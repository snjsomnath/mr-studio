//! The phone relay (#89): for venues where phones cannot reach the studio computer.
//!
//! Guest Wi-Fi often keeps devices apart, and phone browsers want HTTPS for some features.
//! The relay runs on a server with a public address and a real certificate (behind Caddy or
//! a cloud load balancer). The host opens one WebSocket out to it (`/host?room=<room>`, with
//! a token) and phones reach the table through the relay:
//!
//! - `GET /r/<room>/<path>` remembers the room in a cookie and sends the phone to `/<path>`,
//!   so the phone page's own absolute addresses (`/assets/...`, `/ws`, `/api/...`) work as
//!   they do on the local network.
//! - Every other GET goes through the host's link as one request and its answer
//!   ([`protocol::HTTP_REQUEST`]). Nothing but GET and HEAD passes.
//! - `/ws` is the phone's session socket, passed through frame by frame.
//!
//! The relay keeps nothing: no pages, no data, no keys. It only knows which rooms are open.

pub mod protocol;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use protocol::{OpenHead, RequestHead, ResponseHead};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

/// How long a phone's request may wait for the host.
const ANSWER_WITHIN: Duration = Duration::from_secs(30);
/// The relay pings the host and phones this often, and drops one silent for three times as long.
const PING_EVERY: Duration = Duration::from_secs(15);
/// Requests waiting for the host at once, per room.
const MAX_PENDING: usize = 512;
/// The request headers a phone's request carries on to the host.
const PASSED_ON: [&str; 7] = ["accept", "accept-language", "if-none-match", "if-modified-since", "range", "user-agent", "cache-control"];
/// Response headers that belong to one connection, not to the answer.
const HOP: [&str; 5] = ["connection", "transfer-encoding", "content-length", "keep-alive", "upgrade"];

pub struct Config {
    /// Tokens that let a host open a room. Empty: no host can connect.
    pub tokens: Vec<String>,
    /// Mark the room cookie Secure. On for a relay behind HTTPS, which is the only way to run one.
    pub secure_cookies: bool,
}

pub struct Relay {
    config: Config,
    rooms: Mutex<HashMap<String, Arc<Room>>>,
}

/// Where a phone's request waits for the host's answer.
type Answer = oneshot::Sender<(ResponseHead, Vec<u8>)>;

struct Room {
    /// Frames to the host.
    link: mpsc::UnboundedSender<Vec<u8>>,
    next: AtomicU32,
    http: Mutex<HashMap<u32, Answer>>,
    sockets: Mutex<HashMap<u32, mpsc::UnboundedSender<ToPhone>>>,
}

enum ToPhone {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

impl Room {
    fn stream(&self) -> u32 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }
}

impl Relay {
    pub fn new(config: Config) -> Arc<Self> {
        Arc::new(Self { config, rooms: Mutex::new(HashMap::new()) })
    }

    /// The rooms with a host connected.
    pub fn rooms(&self) -> Vec<String> {
        self.rooms.lock().unwrap().keys().cloned().collect()
    }

    fn room(&self, name: &str) -> Option<Arc<Room>> {
        self.rooms.lock().unwrap().get(name).cloned()
    }
}

pub fn router(relay: Arc<Relay>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/host", get(host_link))
        .route("/r/{room}", get(enter))
        .route("/r/{room}/{*rest}", get(enter_at))
        .route("/ws", get(phone_socket))
        .fallback(phone_request)
        .with_state(relay)
}

/// Serves the relay until the process stops.
pub async fn serve(relay: Arc<Relay>, bind: SocketAddr) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("relay listening on {}", listener.local_addr()?);
    axum::serve(listener, router(relay)).await?;
    Ok(())
}

// ---- the host's link ----------------------------------------------------------

#[derive(Deserialize)]
struct HostQuery {
    room: String,
}

async fn host_link(ws: WebSocketUpgrade, State(relay): State<Arc<Relay>>, Query(q): Query<HostQuery>, headers: HeaderMap) -> Response {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if token.is_empty() || !relay.config.tokens.iter().any(|t| t == token) {
        return (StatusCode::UNAUTHORIZED, "This relay needs a valid token.").into_response();
    }
    if !protocol::valid_room(&q.room) {
        return (StatusCode::BAD_REQUEST, "A room is 6 to 32 lowercase letters and digits.").into_response();
    }
    ws.max_message_size(protocol::MAX_BODY + 4096).on_upgrade(move |socket| run_link(socket, relay, q.room))
}

async fn run_link(socket: WebSocket, relay: Arc<Relay>, name: String) {
    let (mut sink, mut source) = socket.split();
    let (link, mut frames) = mpsc::unbounded_channel::<Vec<u8>>();
    let room = Arc::new(Room { link, next: AtomicU32::new(1), http: Mutex::default(), sockets: Mutex::default() });
    // A host that comes back takes its room over; phones of the old link start again.
    if let Some(old) = relay.rooms.lock().unwrap().insert(name.clone(), room.clone()) {
        close_all(&old);
    }
    tracing::info!("room {name} opened");
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Some(frame) => if sink.send(Message::Binary(frame.into())).await.is_err() { break },
                None => break,
            },
            incoming = source.next() => {
                heard = Instant::now();
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => from_host(&room, &bytes),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() > PING_EVERY * 3 || sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }
    let mut rooms = relay.rooms.lock().unwrap();
    if rooms.get(&name).is_some_and(|r| Arc::ptr_eq(r, &room)) {
        rooms.remove(&name);
    }
    drop(rooms);
    close_all(&room);
    tracing::info!("room {name} closed");
}

fn close_all(room: &Room) {
    room.http.lock().unwrap().clear();
    for (_, phone) in room.sockets.lock().unwrap().drain() {
        let _ = phone.send(ToPhone::Close);
    }
}

fn from_host(room: &Room, bytes: &[u8]) {
    let Some((kind, stream, payload)) = protocol::parse(bytes) else { return };
    match kind {
        protocol::HTTP_RESPONSE => {
            let Some((head, body)) = protocol::split_head::<ResponseHead>(payload) else { return };
            if let Some(waiting) = room.http.lock().unwrap().remove(&stream) {
                let _ = waiting.send((head, body.to_vec()));
            }
        }
        protocol::WS_TEXT | protocol::WS_BINARY | protocol::WS_CLOSE => {
            let mut sockets = room.sockets.lock().unwrap();
            let message = match kind {
                protocol::WS_TEXT => match String::from_utf8(payload.to_vec()) {
                    Ok(text) => ToPhone::Text(text),
                    Err(_) => return,
                },
                protocol::WS_BINARY => ToPhone::Binary(payload.to_vec()),
                _ => ToPhone::Close,
            };
            let closing = matches!(message, ToPhone::Close);
            if let Some(phone) = sockets.get(&stream) {
                let _ = phone.send(message);
            }
            if closing {
                sockets.remove(&stream);
            }
        }
        _ => {}
    }
}

// ---- phones ---------------------------------------------------------------------

const COOKIE: &str = "mrs_room";

fn room_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().strip_prefix(&format!("{COOKIE}=")).map(str::to_string))
        .find(|room| protocol::valid_room(room))
}

/// `/r/<room>`: the phone page of that room.
async fn enter(State(relay): State<Arc<Relay>>, Path(room): Path<String>, request: Request) -> Response {
    let query = request.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    redirect_into(&relay, &room, &format!("/phone{query}"))
}

/// `/r/<room>/<path>`: that path, in that room.
async fn enter_at(State(relay): State<Arc<Relay>>, Path((room, rest)): Path<(String, String)>, request: Request) -> Response {
    let query = request.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    redirect_into(&relay, &room, &format!("/{}{query}", rest.trim_start_matches(['/', '\\'])))
}

fn redirect_into(relay: &Relay, room: &str, to: &str) -> Response {
    if !protocol::valid_room(room) {
        return not_here("That link is not a table's link.");
    }
    let secure = if relay.config.secure_cookies { "; Secure" } else { "" };
    let cookie = format!("{COOKIE}={room}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax{secure}");
    let mut response = StatusCode::FOUND.into_response();
    let headers = response.headers_mut();
    headers.insert(header::LOCATION, HeaderValue::from_str(to).unwrap_or(HeaderValue::from_static("/phone")));
    headers.insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).expect("a cookie is ASCII"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// A plain page for a phone that cannot reach a table, in the words the phone page uses.
fn not_here(words: &str) -> Response {
    let page = format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>MR Studio</title>\
         <body style='font:17px system-ui;padding:2rem;color:#1d2433'><h1 style='font-size:20px'>The table is not here</h1><p>{words}</p>\
         <p>Scan the code on the table's screen again.</p>"
    );
    (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response()
}

async fn phone_request(State(relay): State<Arc<Relay>>, request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "Phones only read through the relay.").into_response();
    }
    let Some(name) = room_cookie(request.headers()) else {
        return not_here("This phone has not joined a table through this relay yet.");
    };
    let Some(room) = relay.room(&name) else {
        return not_here("The table's computer is not connected to the relay right now.");
    };
    let head = RequestHead {
        method: request.method().to_string(),
        path: request.uri().path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into()),
        headers: PASSED_ON
            .iter()
            .filter_map(|name| request.headers().get(*name).and_then(|v| v.to_str().ok()).map(|v| (name.to_string(), v.to_string())))
            .collect(),
    };
    let stream = room.stream();
    let (answer, answered) = oneshot::channel();
    {
        let mut http = room.http.lock().unwrap();
        if http.len() >= MAX_PENDING {
            return (StatusCode::SERVICE_UNAVAILABLE, "The table is busy. Try again in a moment.").into_response();
        }
        http.insert(stream, answer);
    }
    if room.link.send(protocol::with_head(protocol::HTTP_REQUEST, stream, &head, &[])).is_err() {
        room.http.lock().unwrap().remove(&stream);
        return not_here("The table's computer is not connected to the relay right now.");
    }
    let Ok(Ok((head, body))) = tokio::time::timeout(ANSWER_WITHIN, answered).await else {
        room.http.lock().unwrap().remove(&stream);
        return (StatusCode::GATEWAY_TIMEOUT, "The table did not answer in time.").into_response();
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::from_u16(head.status).unwrap_or(StatusCode::BAD_GATEWAY);
    for (name, value) in head.headers {
        if HOP.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (header::HeaderName::try_from(name), HeaderValue::from_str(&value)) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

async fn phone_socket(ws: WebSocketUpgrade, State(relay): State<Arc<Relay>>, headers: HeaderMap) -> Response {
    let Some(room) = room_cookie(&headers).and_then(|name| relay.room(&name)) else {
        return not_here("The table's computer is not connected to the relay right now.");
    };
    ws.max_message_size(1 << 20).on_upgrade(move |socket| run_phone(socket, room))
}

async fn run_phone(socket: WebSocket, room: Arc<Room>) {
    let stream = room.stream();
    let (to_phone, mut inbox) = mpsc::unbounded_channel();
    room.sockets.lock().unwrap().insert(stream, to_phone);
    let open = OpenHead { path: "/ws".into() };
    if room.link.send(protocol::frame(protocol::WS_OPEN, stream, &serde_json::to_vec(&open).expect("JSON"))).is_err() {
        room.sockets.lock().unwrap().remove(&stream);
        return;
    }
    let (mut sink, mut source) = socket.split();
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let mut heard = Instant::now();
    let mut host_closed = false;
    loop {
        tokio::select! {
            incoming = source.next() => {
                heard = Instant::now();
                let frame = match incoming {
                    Some(Ok(Message::Text(text))) => protocol::frame(protocol::WS_TEXT, stream, text.as_bytes()),
                    Some(Ok(Message::Binary(bytes))) => protocol::frame(protocol::WS_BINARY, stream, &bytes),
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                if room.link.send(frame).is_err() {
                    break;
                }
            }
            message = inbox.recv() => {
                let sent = match message {
                    Some(ToPhone::Text(text)) => sink.send(Message::Text(text.into())).await,
                    Some(ToPhone::Binary(bytes)) => sink.send(Message::Binary(bytes.into())).await,
                    Some(ToPhone::Close) | None => {
                        host_closed = true;
                        break;
                    }
                };
                if sent.is_err() {
                    break;
                }
            }
            // A phone that went to sleep leaves no close frame: this is what notices.
            _ = ping.tick() => {
                if heard.elapsed() > PING_EVERY * 3 || sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }
    room.sockets.lock().unwrap().remove(&stream);
    if !host_closed {
        let _ = room.link.send(protocol::frame(protocol::WS_CLOSE, stream, &[]));
    }
    let _ = sink.send(Message::Close(None)).await;
}
