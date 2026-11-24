//! The studio's side of the join page (#275): phones that cannot reach this computer, on
//! eduroam or mobile data, open a page on GitHub Pages that reaches the table over WebRTC.
//!
//! A studio surface on this computer (the table) holds the WebRTC peer and opens this socket,
//! `/api/phones/bridge`, from the computer itself. Over it the phones' traffic arrives as the
//! relay protocol's frames (`mrs_relay::protocol`), and the host answers them exactly as it
//! answers a relay: as from the network, GET and HEAD only, and every socket must start with
//! a phone's (or the guide's) `hello`. The bridge only carries bytes; it is not trusted with
//! more than a relay is.
//!
//! The socket's own messages, as text:
//! - host to bridge, first: `{"t":"bridge","page":<join page>,"peer":<PeerJS options>}`, or
//!   `{"t":"off"}` when the join page is turned off, or `{"t":"busy"}` while another surface
//!   is already the bridge. The host closes the socket after `off` and `busy`.
//! - bridge to host: `{"t":"peer","id":<peer id or null>}` when its peer is (or stops being)
//!   reachable. While it is, the QR code points at the join page.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::AppState;

/// The version of the link between the join page and the bridge. It must equal
/// `LINK_VERSION` in `packages/sdk/src/link.ts` (a test checks), and each version's join page
/// stays published at `/v<N>/`.
pub const LINK_VERSION: u32 = 1;

/// One bridge at a time: a second surface is told the host is busy.
#[derive(Default)]
pub struct BridgeSlot(AtomicBool);

pub async fn upgrade(ws: WebSocketUpgrade, ConnectInfo(from): ConnectInfo<SocketAddr>, State(state): State<Arc<AppState>>) -> Response {
    // Only a surface on this computer may carry phones in.
    if !from.ip().is_loopback() {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(mrs_relay::protocol::MAX_BODY + 4096).on_upgrade(move |socket| bridge(socket, state))
}

/// The join link for peer `id`: the page, the peer and, when they are not the defaults, the
/// PeerJS options; the path (`/phone?c=…`) follows the `#`.
pub fn join_base(page: &str, id: &str, options: Option<&Value>) -> String {
    let mut base = format!("{page}{}t={}", if page.contains('?') { '&' } else { '?' }, encode(id));
    if let Some(options) = options.filter(|o| !o.is_null()) {
        base.push_str("&s=");
        base.push_str(&encode(&options.to_string()));
    }
    base.push('#');
    base
}

/// Percent-encodes everything but unreserved characters.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn bridge(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut source) = socket.split();
    let Some((page, options)) = state.hub.join_page() else {
        let _ = sink.send(Message::Text(json!({ "t": "off" }).to_string().into())).await;
        return;
    };
    if state.bridge.0.swap(true, Ordering::SeqCst) {
        let _ = sink.send(Message::Text(json!({ "t": "busy" }).to_string().into())).await;
        return;
    }
    struct Release(Arc<AppState>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.hub.set_bridge(None);
            self.0.bridge.0.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release(state.clone());
    if sink.send(Message::Text(json!({ "t": "bridge", "page": page, "peer": options }).to_string().into())).await.is_err() {
        return;
    }
    let Some(app) = state.links.get().cloned() else { return };
    let port = state.hub.session().port;
    let (frames, incoming) = mpsc::unbounded_channel::<Vec<u8>>();
    let (out, mut outbox) = mpsc::unbounded_channel::<Vec<u8>>();
    let carrying = tokio::spawn(crate::relay::carry(incoming, out, app, port));
    loop {
        tokio::select! {
            frame = outbox.recv() => {
                let Some(frame) = frame else { break };
                if sink.send(Message::Binary(frame.into())).await.is_err() { break }
            }
            incoming = source.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => { let _ = frames.send(bytes.to_vec()); }
                Some(Ok(Message::Text(text))) => {
                    let said: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    if said["t"] == "peer" {
                        match said["id"].as_str().filter(|id| valid_peer(id)) {
                            Some(id) => {
                                let base = join_base(&page, id, options.as_ref());
                                tracing::info!("phones join through the join page at {base}");
                                state.hub.set_bridge(Some(base));
                            }
                            None => state.hub.set_bridge(None),
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    drop(frames);
    carrying.abort();
}

/// A PeerJS id the bridge may announce: letters, digits and dashes, not too long.
fn valid_peer(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The join page on GitHub Pages and the table's bridge are built from the same source,
    /// but a table at a venue may be older than the page: both sides must name the same link.
    #[test]
    fn the_host_and_the_join_page_speak_the_same_link() {
        let link = include_str!("../../../packages/sdk/src/link.ts");
        let line = link.lines().find(|l| l.starts_with("export const LINK_VERSION = ")).expect("LINK_VERSION in link.ts");
        let version: u32 = line.trim_start_matches("export const LINK_VERSION = ").trim_end_matches(';').parse().unwrap();
        assert_eq!(version, LINK_VERSION, "bump both, and keep the old join page published at /v{LINK_VERSION}/");
        let pages = include_str!("../../../.github/workflows/pages.yml");
        assert!(pages.contains(&format!("LINK_VERSION: {LINK_VERSION}")), "pages.yml publishes the join page for this link version");
    }

    #[test]
    fn the_join_link_carries_the_peer_and_its_options() {
        assert_eq!(join_base("https://x.github.io/mr-studio/", "mrs-abc123def", None), "https://x.github.io/mr-studio/?t=mrs-abc123def#");
        let options = json!({ "host": "peer.example" });
        assert_eq!(
            join_base("https://x/j/?v=1", "mrs-abc123def", Some(&options)),
            "https://x/j/?v=1&t=mrs-abc123def&s=%7B%22host%22%3A%22peer.example%22%7D#"
        );
        assert!(crate::hub::DEFAULT_JOIN_PAGE.ends_with(&format!("/v{LINK_VERSION}/")));
        assert!(valid_peer("mrs-abc123def") && !valid_peer("short") && !valid_peer("mrs-abc123def#x"));
    }
}
