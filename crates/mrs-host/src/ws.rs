//! One WebSocket connection per surface. Wire protocol in `docs/contracts/session.md`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use mrs_engine::Encoding;
use mrs_site::LonLat;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::engine_bridge::{OpenRequest, Out};
use crate::health::{Budget, WindowError};
use crate::hub::{Role, PROTOCOL};
use crate::AppState;

/// Engine output queued per connection. When it is full, frames are dropped.
const OUT_QUEUE: usize = 16;
/// The host pings every surface this often,
const PING_EVERY: Duration = Duration::from_secs(10);
/// and gives up on one it has not heard from for this long. A phone that fell asleep or
/// walked out of range leaves no close frame; this is what starts its seat's hold.
const SILENCE_LIMIT: Duration = Duration::from_secs(30);

pub async fn upgrade(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> Response {
    ws.max_message_size(1 << 20).on_upgrade(move |socket| connection(socket, state))
}

async fn connection(socket: WebSocket, state: Arc<AppState>) {
    let (mut sink, mut source) = socket.split();

    // The first message must be a hello.
    let hello = match source.next().await {
        Some(Ok(Message::Text(text))) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
        _ => return,
    };
    let admitted = (|| {
        if hello["t"] != "hello" {
            return Err("expected hello".to_string());
        }
        if hello["protocol"].as_u64() != Some(PROTOCOL as u64) {
            return Err(format!("protocol mismatch: host speaks {PROTOCOL}"));
        }
        let role = hello["role"].as_str().and_then(Role::parse).ok_or("unknown role")?;
        let joined = state.hub.join(role, hello["code"].as_str(), hello["resume"].as_str())?;
        Ok((role, joined))
    })();
    let (role, joined) = match admitted {
        Ok(ok) => ok,
        Err(e) => {
            let _ = sink.send(Message::Text(json!({ "t": "refused", "e": e }).to_string().into())).await;
            return;
        }
    };

    let surface = joined.surface;
    // Subscribe before sending the welcome so no event is missed in between.
    // (A phone's own join was announced inside `join`, before this subscription; its welcome carries it.)
    let mut events = state.hub.subscribe();
    let (out_tx, mut out_rx) = mpsc::channel::<Out>(OUT_QUEUE);
    if sink.send(Message::Text(state.hub.welcome(surface).to_string().into())).await.is_err() {
        release(&state, surface);
        return;
    }
    tracing::info!("surface {surface} joined as {role:?}");

    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            incoming = source.next() => {
                heard = Instant::now();
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                // A table or controller window of the desktop app is alive and drawing (#79).
                if message["t"] == "alive" && matches!(role, Role::Table | Role::Tv) {
                    let window = message["window"].as_str().unwrap_or_default();
                    state.health.beat(
                        window,
                        if role == Role::Table { "table" } else { "tv" },
                        message["fps"].as_f64().unwrap_or(0.0),
                        Budget::from_beat(&message),
                    );
                    continue;
                }
                // An error in the window (#260): to the app's log, and to the operator log unless a phone's.
                if message["t"] == "error" {
                    if role != Role::Phone || state.hub.allow(surface) {
                        report_error(&state, role, surface, &message);
                    }
                    continue;
                }
                if message["t"] != "req" {
                    continue;
                }
                // Phones are strangers on the network: each gets a fixed allowance of requests.
                let result = if role == Role::Phone && !state.hub.allow(surface) {
                    Err("rate limited".to_string())
                } else {
                    request(&state, role, surface, &message, &out_tx).await
                };
                let reply = match result {
                    Ok(r) => json!({ "t": "res", "id": message["id"], "ok": true, "r": r }),
                    Err(e) => json!({ "t": "res", "id": message["id"], "ok": false, "e": e }),
                };
                if sink.send(Message::Text(reply.to_string().into())).await.is_err() {
                    break;
                }
            }
            event = events.recv() => match event {
                Ok(text) => {
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                // This surface fell behind. Resend the whole state instead of a backlog.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let mut resync = state.hub.welcome(surface);
                    resync["t"] = json!("resync");
                    if sink.send(Message::Text(resync.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            Some(out) = out_rx.recv() => {
                let message = match out {
                    Out::Text(text) => Message::Text(text.into()),
                    Out::Binary(bytes) => Message::Binary(bytes.into()),
                };
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() > SILENCE_LIMIT || sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            // The same phone joined again (a reload, or a second tab) and now has this seat.
            // Or the operator let it go (#335): its turn is over.
            _ = replaced(&joined.kick) => {
                let why = if state.hub.was_released(surface) { "the operator ended this phone's turn" } else { "this phone joined again somewhere else" };
                let _ = sink.send(Message::Text(json!({ "t": "refused", "e": why }).to_string().into())).await;
                break;
            }
        }
    }
    state.engine.close_connection(surface);
    release(&state, surface);
    tracing::info!("surface {surface} left");
}

async fn replaced(kick: &Option<Arc<tokio::sync::Notify>>) {
    match kick {
        Some(kick) => kick.notified().await,
        None => std::future::pending().await,
    }
}

/// Keeps an error a window reported, and logs it the first time it is seen.
fn report_error(state: &AppState, role: Role, surface: u64, message: &Value) {
    let Some(error) = WindowError::from_report(role.name(), message) else { return };
    let line = error.line();
    let stack = error.stack.clone();
    if !state.health.error(&surface.to_string(), error) {
        return;
    }
    match stack {
        Some(stack) => tracing::warn!("error in the {line}\n{stack}"),
        None => tracing::warn!("error in the {line}"),
    }
    if role != Role::Phone {
        state.health.note(format!("Error in the {line}"));
    }
}

/// Ends a surface's part in the session. A phone's seat is held for a while first.
fn release(state: &Arc<AppState>, surface: u64) {
    if let Some(hold) = state.hub.leave(surface) {
        let state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(state.hub.resume_hold()).await;
            state.hub.expire(hold);
        });
    }
}

async fn request(state: &AppState, role: Role, surface: u64, message: &Value, out: &mpsc::Sender<Out>) -> Result<Value, String> {
    let method = message["m"].as_str().ok_or("missing method")?;
    let p = &message["p"];
    if method.starts_with("calibration.") {
        if !role.may_calibrate() {
            return Err("phones cannot read or change the calibration".into());
        }
        return state.calibration_request(method, p);
    }
    if method.starts_with("field.") {
        return state.field_request(role, surface, method, p);
    }
    if method.starts_with("history.") {
        return state.history_request(role, surface, method, p).await;
    }
    if !method.starts_with("engine.") {
        let result = state.hub.request(role, surface, method, p);
        // The field walk's Remove and Clear (#445) are named actions of its controller stage.
        if method == "layer.action" && result.is_ok() {
            state.field_action(role, p)?;
        }
        // A layer's trouble starting or ending goes to the operator log (#259).
        if method == "layer.health" {
            if let Some(incident) = result.as_ref().ok().and_then(|r| r["incident"].as_str()) {
                tracing::warn!("{incident}");
                state.health.note(incident);
            }
        }
        return result;
    }
    if !role.may_use_engine() {
        return Err("phones cannot open engine streams".into());
    }
    let stream = || p["stream"].as_u64().map(|s| s as u32).ok_or("missing stream");
    match method {
        "engine.info" => state.engine.info().await.map(|i| json!(i)).map_err(|e| e.to_string()),
        "engine.open" => {
            let fields = p["fields"].as_array().ok_or("missing fields")?;
            let request = OpenRequest {
                conn: surface,
                kernel: p["kernel"].as_str().ok_or("missing kernel")?.to_string(),
                params: p.get("params").cloned().unwrap_or_else(|| json!({})),
                fields: fields.iter().filter_map(|f| f.as_str().map(String::from)).collect(),
                encoding: match p["encoding"].as_str() {
                    None => Encoding::U8,
                    Some(e) => Encoding::parse(e).ok_or("encoding must be 'u8' or 'f32'")?,
                },
                max_hz: p["maxHz"].as_f64().unwrap_or(30.0),
                out: out.clone(),
            };
            state.engine.open(request).await.map(|stream| json!({ "stream": stream }))
        }
        "engine.set" => {
            let params = p.get("params").cloned().ok_or("missing params")?;
            state.engine.set(surface, stream()?, params).await.map(|_| json!({}))
        }
        "engine.probe" => {
            let at = p["at"]
                .as_array()
                .and_then(|a| Some(LonLat { lon: a.first()?.as_f64()?, lat: a.get(1)?.as_f64()? }))
                .ok_or("at must be [lon, lat]")?;
            let kernel = p["kernel"].as_str().ok_or("missing kernel")?.to_string();
            state.engine.probe(kernel, p.get("params").cloned().unwrap_or_else(|| json!({})), at).await
        }
        "engine.close" => {
            state.engine.close(surface, stream()?);
            Ok(json!({}))
        }
        other => Err(format!("unknown method '{other}'")),
    }
}
