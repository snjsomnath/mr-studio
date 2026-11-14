//! The host over a real WebSocket: joining, authority over layer state, roles, and field streaming.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mrs_engine::Backend;
use mrs_host::{HostConfig, RunningHost, SessionOptions};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

async fn host() -> RunningHost {
    host_with(SessionOptions::default()).await
}

async fn host_with(options: SessionOptions) -> RunningHost {
    mrs_host::start(HostConfig {
        site_dir: repo().join("sites/sample"),
        layers_dir: repo().join("packages/layers"),
        web_dir: None,
        bind: "127.0.0.1:0".parse().unwrap(),
        // The CPU reference keeps these tests independent of the machine's GPU.
        backend: Backend::Cpu,
        session: options,
    })
    .await
    .unwrap()
}

struct Surface {
    socket: Socket,
    next_id: u64,
    welcome: Value,
}

impl Surface {
    async fn join(host: &RunningHost, role: &str, code: Option<&str>) -> Result<Self, String> {
        Self::resume(host, role, code, None).await
    }

    async fn resume(host: &RunningHost, role: &str, code: Option<&str>, resume: Option<&str>) -> Result<Self, String> {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", host.addr)).await.unwrap();
        let hello = json!({ "t": "hello", "protocol": 1, "role": role, "code": code, "resume": resume });
        socket.send(Message::Text(hello.to_string().into())).await.unwrap();
        let first: Value = match socket.next().await.unwrap().unwrap() {
            Message::Text(text) => serde_json::from_str(&text).unwrap(),
            other => panic!("unexpected {other:?}"),
        };
        if first["t"] == "refused" {
            return Err(first["e"].as_str().unwrap().to_string());
        }
        assert_eq!(first["t"], "welcome");
        Ok(Self { socket, next_id: 1, welcome: first })
    }

    async fn next(&mut self) -> Message {
        tokio::time::timeout(Duration::from_secs(20), self.socket.next()).await.expect("timed out waiting for the host").unwrap().unwrap()
    }

    /// Sends a request and returns its result, skipping events and frames that arrive first.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.socket.send(Message::Text(json!({ "t": "req", "id": id, "m": method, "p": params }).to_string().into())).await.unwrap();
        loop {
            if let Message::Text(text) = self.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                if message["t"] == "res" && message["id"] == id {
                    return if message["ok"] == true { Ok(message["r"].clone()) } else { Err(message["e"].as_str().unwrap().to_string()) };
                }
            }
        }
    }

    /// Waits for an event with this name and returns its payload.
    async fn event(&mut self, name: &str) -> Value {
        loop {
            if let Message::Text(text) = self.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                if message["t"] == "ev" && message["m"] == name {
                    return message["p"].clone();
                }
            }
        }
    }

    async fn frame(&mut self) -> Vec<u8> {
        loop {
            if let Message::Binary(bytes) = self.next().await {
                return bytes.to_vec();
            }
        }
    }
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn welcome_carries_site_state_and_manifests() {
    let host = host().await;
    let tv = Surface::join(&host, "tv", None).await.unwrap();
    let state = &tv.welcome["state"];
    assert_eq!(state["protocol"], 1);
    assert_eq!(state["site"]["id"], "sample");
    assert_eq!(state["site"]["grid"]["width"], 1000);
    assert_eq!(state["site"]["corners"].as_array().unwrap().len(), 4);
    // Defaults from the manifest, overridden by site.json.
    let sunlight = &state["layers"]["sunlight"];
    assert_eq!(sunlight["active"], true);
    assert_eq!(sunlight["params"]["hour"], 15.0);
    assert_eq!(sunlight["params"]["mode"], "instant");
    assert_eq!(tv.welcome["manifests"][0]["id"], "sunlight");
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_validates_and_broadcasts_param_changes() {
    let host = host().await;
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();

    // Out of range is clamped, off-step is snapped, and every surface hears the result.
    tv.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 99 } })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["params"]["hour"], 24.0);
    tv.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9.1 } })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["params"]["hour"], 9.0);

    // Bad requests are refused and change nothing.
    for params in [json!({ "mode": "weekly" }), json!({ "nope": 1 }), json!({ "hour": "noon" })] {
        assert!(tv.request("layer.set", json!({ "layer": "sunlight", "params": params })).await.is_err());
    }
    assert!(tv.request("layer.set", json!({ "layer": "ghost", "params": {} })).await.is_err());

    tv.request("layer.activate", json!({ "layer": "sunlight", "active": false })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["active"], false);

    // Only the table publishes derived values.
    assert!(tv.request("layer.publish", json!({ "layer": "sunlight", "values": { "x": 1 } })).await.is_err());
    table.request("layer.publish", json!({ "layer": "sunlight", "values": { "altitude": 42 } })).await.unwrap();
    assert_eq!(tv.event("state.layer").await["state"]["shared"]["altitude"], 42);
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn phones_need_the_code_and_are_limited() {
    let host = host().await;
    let code = host.state.hub.session().code.clone();
    assert_eq!(Surface::join(&host, "phone", None).await.err().unwrap(), "wrong session code");
    assert!(Surface::join(&host, "phone", Some("nope")).await.is_err());
    assert!(Surface::join(&host, "projector", None).await.is_err());

    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    let people = tv.event("state.participants").await;
    assert_eq!(people["participants"].as_array().unwrap().len(), 1);
    assert_eq!(people["participants"][0]["slot"], 0);

    // `hour` is marked phone: true, `mode` is not.
    phone.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 7 } })).await.unwrap();
    assert!(phone.request("layer.set", json!({ "layer": "sunlight", "params": { "mode": "day" } })).await.is_err());
    assert!(phone.request("layer.activate", json!({ "layer": "sunlight", "active": false })).await.is_err());
    assert!(phone.request("engine.open", json!({ "kernel": "sunlight", "params": {}, "fields": ["shadow"] })).await.is_err());

    // The slot is held when the phone drops (see the resume test), so eight more do not fit.
    drop(phone);
    assert_eq!(tv.event("state.participants").await["participants"][0]["connected"], false);
    let mut phones = Vec::new();
    for _ in 0..7 {
        phones.push(Surface::join(&host, "phone", Some(&code)).await.unwrap());
    }
    assert_eq!(Surface::join(&host, "phone", Some(&code)).await.err().unwrap(), "session full");
    host.shutdown().await;
}

/// The participants in the next `state.participants` event, as (slot, connected).
async fn people(surface: &mut Surface) -> Vec<(u64, bool)> {
    let event = surface.event("state.participants").await;
    event["participants"].as_array().unwrap().iter().map(|p| (p["slot"].as_u64().unwrap(), p["connected"].as_bool().unwrap())).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_phone_resumes_its_slot_and_an_abandoned_slot_is_released() {
    let host = host_with(SessionOptions { resume_hold: Duration::from_millis(600), ..Default::default() }).await;
    let code = host.state.hub.session().code.clone();
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    assert!(tv.welcome["resume"].is_null());

    let _first = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert_eq!(people(&mut tv).await, [(0, true)]);
    let second = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert_eq!(people(&mut tv).await, [(0, true), (1, true)]);
    let token = second.welcome["resume"].as_str().unwrap().to_string();
    let colour = second.welcome["state"]["participants"][1]["colour"].clone();

    // The connection drops: the slot is kept, shown as away.
    drop(second);
    assert_eq!(people(&mut tv).await, [(0, true), (1, false)]);

    // Back in time with the token: same slot and colour, same token, a new surface id.
    let mut back = Surface::resume(&host, "phone", Some(&code), Some(&token)).await.unwrap();
    assert_eq!(people(&mut tv).await, [(0, true), (1, true)]);
    assert_eq!(back.welcome["resume"], token.as_str());
    let me = back.welcome["state"]["participants"].as_array().unwrap().iter().find(|p| p["surface"] == back.welcome["surface"]).unwrap();
    assert_eq!((me["slot"].as_u64(), &me["colour"]), (Some(1), &colour));
    back.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 7 } })).await.unwrap();

    // A reload that arrives before the old connection is gone takes the seat over; the old one is told.
    let _again = Surface::resume(&host, "phone", Some(&code), Some(&token)).await.unwrap();
    assert_eq!(people(&mut tv).await, [(0, true), (1, true)]);
    let told = loop {
        if let Message::Text(text) = back.next().await {
            let message: Value = serde_json::from_str(&text).unwrap();
            if message["t"] == "refused" {
                break message;
            }
        }
    };
    assert!(told["e"].as_str().unwrap().contains("joined again"));

    // Nobody comes back for this one: after the hold the slot is free again.
    drop(_again);
    assert_eq!(people(&mut tv).await, [(0, true), (1, false)]);
    let started = std::time::Instant::now();
    assert_eq!(people(&mut tv).await, [(0, true)]);
    assert!(started.elapsed() >= Duration::from_millis(400), "released after the hold, not before");
    // The token died with the slot: it now gets an ordinary new seat.
    let fresh = Surface::resume(&host, "phone", Some(&code), Some(&token)).await.unwrap();
    assert_ne!(fresh.welcome["resume"], token.as_str());
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_flooding_phone_is_cut_to_twenty_requests_a_second() {
    let host = host().await;
    let code = host.state.hub.session().code.clone();
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();

    // Sixty requests at once, without waiting for answers.
    for id in 1..=60 {
        let request = json!({ "t": "req", "id": id, "m": "layer.set", "p": { "layer": "sunlight", "params": { "hour": id % 24 } } });
        phone.socket.send(Message::Text(request.to_string().into())).await.unwrap();
    }
    let (mut accepted, mut limited) = (0, 0);
    while accepted + limited < 60 {
        if let Message::Text(text) = phone.next().await {
            let message: Value = serde_json::from_str(&text).unwrap();
            if message["t"] == "res" {
                if message["ok"] == true {
                    accepted += 1;
                } else {
                    assert_eq!(message["e"], "rate limited");
                    limited += 1;
                }
            }
        }
    }
    // Twenty at once, plus whatever refilled while they were being handled.
    assert!((20..=30).contains(&accepted), "{accepted} accepted, {limited} refused");

    // The limit is per phone and does not touch the studio's own surfaces.
    for hour in 0..40 {
        tv.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": hour % 24 } })).await.unwrap();
    }
    // The allowance comes back.
    tokio::time::sleep(Duration::from_millis(300)).await;
    phone.next_id = 100;
    phone.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9 } })).await.unwrap();
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_tools_reach_the_table_as_tool_input() {
    let host = host().await;
    let code = host.state.hub.session().code.clone();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    let _other = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();

    // A point, with anything extra stripped, tagged with who sent it.
    let point = json!({ "type": "Point", "coordinates": [11.9712, 57.7003, 40.0], "note": "x" });
    phone.request("tool.input", json!({ "layer": "sketch", "tool": "place", "geometry": point })).await.unwrap();
    let input = table.event("tool.input").await;
    assert_eq!(input["layer"], "sketch");
    assert_eq!(input["tool"], "place");
    assert_eq!(input["geometry"], json!({ "type": "Point", "coordinates": [11.9712, 57.7003] }));
    assert_eq!(input["from"], phone.welcome["surface"]);
    assert_eq!(input["participant"]["slot"], 1);
    assert_eq!(input["participant"]["colour"], phone.welcome["state"]["participants"][1]["colour"]);

    let line = json!({ "type": "LineString", "coordinates": [[11.97, 57.7], [11.971, 57.7005], [11.972, 57.7]] });
    phone.request("tool.input", json!({ "layer": "sketch", "tool": "route", "geometry": line })).await.unwrap();
    assert_eq!(table.event("tool.input").await["geometry"], line);
    let area = json!({ "type": "Polygon", "coordinates": [[[11.97, 57.7], [11.971, 57.7], [11.971, 57.701], [11.97, 57.7]]] });
    phone.request("tool.input", json!({ "layer": "sketch", "tool": "area", "geometry": area })).await.unwrap();
    assert_eq!(table.event("tool.input").await["geometry"], area);

    // The geometry must be the tool's kind and well formed, and the tool must exist.
    let send = |tool: &str, geometry: Value| json!({ "layer": "sketch", "tool": tool, "geometry": geometry });
    assert!(phone.request("tool.input", send("place", line.clone())).await.is_err());
    assert!(phone.request("tool.input", send("route", json!({ "type": "LineString", "coordinates": [[11.97, 57.7]] }))).await.is_err());
    assert!(phone.request("tool.input", send("place", json!({ "type": "Point", "coordinates": [500, 57.7] }))).await.is_err());
    assert!(phone.request("tool.input", send("lasso", point.clone())).await.is_err());
    assert!(phone.request("tool.input", json!({ "layer": "sunlight", "tool": "place", "geometry": point })).await.is_err());

    // A studio surface may send tool input too; it carries no participant.
    tv.request("tool.input", send("place", point.clone())).await.unwrap();
    assert!(table.event("tool.input").await["participant"].is_null());

    // A layer that is off takes no input.
    tv.request("layer.activate", json!({ "layer": "sketch", "active": false })).await.unwrap();
    assert_eq!(phone.request("tool.input", send("place", point)).await.err().unwrap(), "layer 'sketch' is off");
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn engine_streams_push_frames_when_results_change() {
    let host = host().await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    assert_eq!(table.request("engine.info", json!({})).await.unwrap()["backend"], "cpu");

    // lat and lon are filled in from the site.
    let params = json!({ "mode": "instant", "time": "2026-06-21T13:00:00Z" });
    let opened = table.request("engine.open", json!({ "kernel": "sunlight", "params": params, "fields": ["shadow"] })).await.unwrap();
    let stream = opened["stream"].as_u64().unwrap();

    let status = table.event("engine.status").await;
    assert_eq!(status["stream"], stream);
    assert_eq!(status["state"], "done");
    assert!(status["info"]["sun"]["altitude_deg"].as_f64().unwrap() > 40.0);

    let frame = table.frame().await;
    assert_eq!(&frame[0..4], b"MRSF");
    assert_eq!(u32_at(&frame, 8) as u64, stream);
    assert_eq!((u32_at(&frame, 16), u32_at(&frame, 20)), (1000, 600));
    assert_eq!(frame.len(), 40 + 1000 * 600, "u8 encoding is one byte per cell");
    let lit = frame[40..].iter().filter(|v| **v > 128).count() as f64 / 600_000.0;
    assert!((0.3..0.95).contains(&lit), "{lit} of the site is lit in mid-afternoon");

    // A new time produces a new frame with a higher revision, and at night nothing is lit.
    let first_revision = u32_at(&frame, 24);
    table.request("engine.set", json!({ "stream": stream, "params": { "time": "2026-06-21T23:30:00Z" } })).await.unwrap();
    let night = table.frame().await;
    assert!(u32_at(&night, 24) > first_revision);
    assert!(night[40..].iter().all(|v| *v == 0));

    // Exact values on request.
    let opened = table
        .request("engine.open", json!({ "kernel": "sunlight", "params": params, "fields": ["shadow"], "encoding": "f32" }))
        .await
        .unwrap();
    let exact = loop {
        let frame = table.frame().await;
        if u32_at(&frame, 8) as u64 == opened["stream"].as_u64().unwrap() {
            break frame;
        }
    };
    assert_eq!(exact.len(), 40 + 1000 * 600 * 4);

    // Bad requests are errors, and another surface cannot touch this stream.
    assert!(table.request("engine.open", json!({ "kernel": "nope", "params": {}, "fields": ["x"] })).await.is_err());
    assert!(table.request("engine.open", json!({ "kernel": "sunlight", "params": params, "fields": ["nope"] })).await.is_err());
    assert!(table
        .request("engine.open", json!({ "kernel": "sunlight", "params": { "time": "soon" }, "fields": ["shadow"] }))
        .await
        .is_err());
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    assert!(tv.request("engine.set", json!({ "stream": stream, "params": { "time": "2026-06-21T10:00:00Z" } })).await.is_err());
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sun_hours_arrive_progressively() {
    let host = host().await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let params = json!({ "mode": "day", "time": "2026-06-21T12:00:00Z", "step_minutes": 60 });
    table.request("engine.open", json!({ "kernel": "sunlight", "params": params, "fields": ["sun_hours"] })).await.unwrap();
    let mut updates = 0;
    let done = loop {
        let status = table.event("engine.status").await;
        updates += 1;
        if status["state"] == "done" {
            break status;
        }
        assert!(status["progress"].as_f64().unwrap() < 1.0);
    };
    assert!(updates >= 2, "the day should arrive in more than one update");
    assert_eq!(done["progress"], 1.0);
    let hours = done["info"]["daylight_hours"].as_f64().unwrap();
    assert!((17.0..19.0).contains(&hours), "{hours} h of daylight at midsummer");
    host.shutdown().await;
}
