//! The host's side of the phone relay (#89).
//!
//! When the table has a relay (a "Phone relay" source in Sources and keys), the host opens one
//! WebSocket out to it and stays connected, trying again with growing pauses when the link
//! drops. While it is connected the QR code points at the relay, so phones join from any
//! network over the relay's HTTPS. The protocol is in `mrs_relay::protocol`.
//!
//! What comes through the relay is treated as coming from the network, never from this
//! computer. Phones' requests are answered by the host's own router in process, as if from
//! [`RELAYED`], so every route that only this computer may use refuses them. Only GET and
//! HEAD pass, and a socket through the relay can only be a phone: its first message must be a
//! phone's (or the guide's) `hello`.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Weak;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, Request};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use mrs_relay::protocol::{self, OpenHead, RequestHead, ResponseHead};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

use crate::AppState;

/// The address requests through the relay seem to come from: a documentation address
/// (TEST-NET-1), so they are never mistaken for this computer or a device on its network.
pub const RELAYED: SocketAddr = SocketAddr::new(std::net::IpAddr::V4(std::net::Ipv4Addr::new(192, 0, 2, 1)), 0);

/// Where the relay is and how the host shows it may use it.
#[derive(Debug, Clone)]
pub struct RelayLink {
    /// The relay's public address, such as `https://relay.example.org`.
    pub url: String,
    /// The `Authorization` header value, such as `Bearer <token>`.
    pub authorization: String,
}

/// Keeps the host connected to the relay for as long as the host runs.
pub fn spawn(state: Weak<AppState>, app: Router, port: u16, link: RelayLink) {
    tokio::spawn(async move {
        let room = room_name();
        let mut pause = Duration::from_secs(1);
        loop {
            let Some(strong) = state.upgrade() else { break };
            drop(strong);
            match connect(&state, &app, port, &link, &room).await {
                Ok(()) => {
                    tracing::warn!("the relay link closed; connecting again");
                    pause = Duration::from_secs(1);
                }
                Err(e) => tracing::warn!("relay {}: {e:#}", link.url),
            }
            match state.upgrade() {
                Some(state) => {
                    if state.hub.session().join_url.as_deref().is_some_and(|u| u.starts_with(link.url.trim_end_matches('/'))) {
                        state.hub.set_relay(None);
                    }
                }
                None => break,
            }
            tokio::time::sleep(pause).await;
            pause = (pause * 2).min(Duration::from_secs(30));
        }
    });
}

/// A room name for this run of the host: ten letters and digits, hard to guess.
fn room_name() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut n = std::collections::hash_map::RandomState::new().build_hasher().finish();
    let alphabet = b"abcdefghijkmnpqrstuvwxyz23456789";
    (0..10)
        .map(|_| {
            let c = alphabet[(n % alphabet.len() as u64) as usize] as char;
            n /= alphabet.len() as u64;
            c
        })
        .collect()
}

/// One connection to the relay, until it closes.
async fn connect(state: &Weak<AppState>, app: &Router, port: u16, link: &RelayLink, room: &str) -> anyhow::Result<()> {
    let base = link.url.trim_end_matches('/');
    let address = format!("{}/host?room={room}", base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1));
    let mut request = address.into_client_request()?;
    request.headers_mut().insert(header::AUTHORIZATION, link.authorization.parse()?);
    let (socket, _) = tokio_tungstenite::connect_async(request).await?;
    let Some(strong) = state.upgrade() else { return Ok(()) };
    strong.hub.set_relay(Some(format!("{base}/r/{room}")));
    tracing::info!("phones join through the relay at {base}/r/{room}");
    drop(strong);

    let (mut sink, mut source) = socket.split();
    let (frames, incoming) = mpsc::unbounded_channel::<Vec<u8>>();
    let (out, mut outbox) = mpsc::unbounded_channel::<Vec<u8>>();
    let carrying = tokio::spawn(carry(incoming, out, app.clone(), port));
    let result = loop {
        tokio::select! {
            frame = outbox.recv() => {
                let Some(frame) = frame else { break Ok(()) };
                if let Err(e) = sink.send(Message::Binary(frame.into())).await { break Err(e.into()) }
            }
            incoming = source.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => { let _ = frames.send(bytes.to_vec()); }
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Err(e)) => break Err(e.into()),
                Some(Ok(_)) => {}
            },
        }
    };
    drop(frames);
    carrying.abort();
    result
}

/// Answers the relay protocol's frames from `incoming`, sending the host's frames to `out`,
/// until `incoming` ends. Both the relay link and the join page's WebRTC bridge (#275) use it,
/// so a phone gets the same treatment whichever way it comes.
pub(crate) async fn carry(mut incoming: mpsc::UnboundedReceiver<Vec<u8>>, out: mpsc::UnboundedSender<Vec<u8>>, app: Router, port: u16) {
    let mut phones: HashMap<u32, mpsc::UnboundedSender<Message>> = HashMap::new();
    while let Some(bytes) = incoming.recv().await {
        from_relay(&bytes, &app, port, &out, &mut phones);
    }
}

fn from_relay(
    bytes: &[u8],
    app: &Router,
    port: u16,
    out: &mpsc::UnboundedSender<Vec<u8>>,
    phones: &mut HashMap<u32, mpsc::UnboundedSender<Message>>,
) {
    let Some((kind, stream, payload)) = protocol::parse(bytes) else { return };
    match kind {
        protocol::HTTP_REQUEST => {
            let Some((head, _)) = protocol::split_head::<RequestHead>(payload) else { return };
            let (app, out) = (app.clone(), out.clone());
            tokio::spawn(async move {
                let (head, body) = answer(app, head).await;
                let _ = out.send(protocol::with_head(protocol::HTTP_RESPONSE, stream, &head, &body));
            });
        }
        protocol::WS_OPEN => {
            let Ok(open) = serde_json::from_slice::<OpenHead>(payload) else { return };
            if open.path != "/ws" {
                let _ = out.send(protocol::frame(protocol::WS_CLOSE, stream, &[]));
                return;
            }
            let (to_host, inbox) = mpsc::unbounded_channel();
            phones.insert(stream, to_host);
            tokio::spawn(phone(port, stream, inbox, out.clone()));
        }
        protocol::WS_TEXT => {
            if let (Some(phone), Ok(text)) = (phones.get(&stream), std::str::from_utf8(payload)) {
                let _ = phone.send(Message::Text(text.to_string().into()));
            }
        }
        protocol::WS_BINARY => {
            if let Some(phone) = phones.get(&stream) {
                let _ = phone.send(Message::Binary(payload.to_vec().into()));
            }
        }
        protocol::WS_CLOSE => {
            phones.remove(&stream);
        }
        _ => {}
    }
}

/// Answers a phone's request with the host's own router, as a request from the network.
async fn answer(app: Router, head: RequestHead) -> (ResponseHead, Vec<u8>) {
    let refuse = |status: u16| (ResponseHead { status, headers: vec![] }, Vec::new());
    if head.method != "GET" && head.method != "HEAD" {
        return refuse(405);
    }
    let mut request = Request::builder().method(head.method.as_str()).uri(&head.path);
    for (name, value) in &head.headers {
        request = request.header(name, value);
    }
    let Ok(mut request) = request.body(Body::empty()) else { return refuse(400) };
    request.extensions_mut().insert(ConnectInfo(RELAYED));
    let Ok(response) = app.oneshot(request).await;
    let (parts, body) = response.into_parts();
    let Ok(body) = axum::body::to_bytes(body, protocol::MAX_BODY).await else { return refuse(502) };
    let headers = parts.headers.iter().filter_map(|(n, v)| v.to_str().ok().map(|v| (n.to_string(), v.to_string()))).collect();
    (ResponseHead { status: parts.status.as_u16(), headers }, body.to_vec())
}

/// One phone's socket through the relay, joined to the host's own `/ws` once the phone has
/// said it is a phone.
async fn phone(port: u16, stream: u32, mut inbox: mpsc::UnboundedReceiver<Message>, out: mpsc::UnboundedSender<Vec<u8>>) {
    let close = |out: &mpsc::UnboundedSender<Vec<u8>>| {
        let _ = out.send(protocol::frame(protocol::WS_CLOSE, stream, &[]));
    };
    let Some(Message::Text(hello)) = inbox.recv().await else { return close(&out) };
    let said: Value = serde_json::from_str(&hello).unwrap_or(Value::Null);
    // The guide's phone (#98) comes through too; it still needs its own code.
    if said["t"] != "hello" || (said["role"] != "phone" && said["role"] != "guide") {
        tracing::warn!("refused a socket through the relay that was not a phone");
        let refused = serde_json::json!({ "t": "refused", "e": "only phones join through the relay" }).to_string();
        let _ = out.send(protocol::frame(protocol::WS_TEXT, stream, refused.as_bytes()));
        return close(&out);
    }
    let Ok((local, _)) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws")).await else { return close(&out) };
    let (mut sink, mut source) = local.split();
    if sink.send(Message::Text(hello)).await.is_err() {
        return close(&out);
    }
    loop {
        tokio::select! {
            from_phone = inbox.recv() => match from_phone {
                Some(message) => if sink.send(message).await.is_err() { break },
                // The phone left (the relay said so, or the link closed).
                None => {
                    let _ = sink.send(Message::Close(None)).await;
                    return;
                }
            },
            from_host = source.next() => {
                let frame = match from_host {
                    Some(Ok(Message::Text(text))) => protocol::frame(protocol::WS_TEXT, stream, text.as_bytes()),
                    Some(Ok(Message::Binary(bytes))) => protocol::frame(protocol::WS_BINARY, stream, &bytes),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                if out.send(frame).is_err() {
                    break;
                }
            }
        }
    }
    close(&out);
}
