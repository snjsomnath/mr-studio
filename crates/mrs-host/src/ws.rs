//! One WebSocket connection per surface. Wire protocol in `docs/contracts/session.md`.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use mrs_engine::Encoding;
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc};

use crate::engine_bridge::{OpenRequest, Out};
use crate::hub::{Role, PROTOCOL};
use crate::AppState;

/// Engine output queued per connection. When it is full, frames are dropped.
const OUT_QUEUE: usize = 16;

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
        let surface = state.hub.join(role, hello["code"].as_str())?;
        Ok((role, surface))
    })();
    let (role, surface) = match admitted {
        Ok(ok) => ok,
        Err(e) => {
            let _ = sink.send(Message::Text(json!({ "t": "refused", "e": e }).to_string().into())).await;
            return;
        }
    };

    // Subscribe before sending the welcome so no event is missed in between.
    let mut events = state.hub.subscribe();
    let (out_tx, mut out_rx) = mpsc::channel::<Out>(OUT_QUEUE);
    if sink.send(Message::Text(state.hub.welcome(surface).to_string().into())).await.is_err() {
        state.hub.leave(surface);
        return;
    }
    tracing::info!("surface {surface} joined as {role:?}");

    loop {
        tokio::select! {
            incoming = source.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                };
                let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
                if message["t"] != "req" {
                    continue;
                }
                let result = request(&state, role, surface, &message, &out_tx).await;
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
        }
    }
    state.engine.close_connection(surface);
    state.hub.leave(surface);
    tracing::info!("surface {surface} left");
}

async fn request(state: &AppState, role: Role, surface: u64, message: &Value, out: &mpsc::Sender<Out>) -> Result<Value, String> {
    let method = message["m"].as_str().ok_or("missing method")?;
    let p = &message["p"];
    if !method.starts_with("engine.") {
        return state.hub.request(role, surface, method, p);
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
        "engine.close" => {
            state.engine.close(surface, stream()?);
            Ok(json!({}))
        }
        other => Err(format!("unknown method '{other}'")),
    }
}
