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
    start(repo().join("sites/sample"), options).await
}

async fn host_for(site_dir: PathBuf) -> RunningHost {
    start(site_dir, SessionOptions::default()).await
}

/// A private copy of the sample site, for tests that edit the scene (the host rewrites site.json).
fn scratch_site(name: &str) -> PathBuf {
    fn copy(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() == ".mrstudio" {
                continue;
            }
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    let dir = std::env::temp_dir().join(format!("mrs-host-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    copy(&repo().join("sites/sample"), &dir);
    dir
}

fn saved_layers(site: &std::path::Path) -> Vec<Value> {
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
    manifest["layers"].as_array().unwrap().clone()
}

async fn start(site_dir: PathBuf, options: SessionOptions) -> RunningHost {
    mrs_host::start(HostConfig {
        site_dir,
        layers_dir: repo().join("packages/layers"),
        web_dir: None,
        bind: "127.0.0.1:0".parse().unwrap(),
        // The CPU reference keeps these tests independent of the machine's GPU.
        backend: Backend::Cpu,
        session: options,
        sources: std::sync::Arc::new(mrs_host::Sources::in_memory()),
        programs: true,
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
        // Pings keep arriving, so the wait as a whole has a limit too.
        let wait = async {
            loop {
                if let Message::Text(text) = self.next().await {
                    let message: Value = serde_json::from_str(&text).unwrap();
                    if message["t"] == "ev" && message["m"] == name {
                        return message["p"].clone();
                    }
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), wait).await.unwrap_or_else(|_| panic!("no '{name}' event"))
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
    assert_eq!(sunlight["layer"], "sunlight");
    assert_eq!(sunlight["active"], false);
    assert_eq!(sunlight["params"]["hour"], 15.0);
    assert_eq!(sunlight["params"]["mode"], "instant");
    // The scene is site.json's list, bottom first, and the base map is on.
    let scene: Vec<&str> = state["scene"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
    assert_eq!(
        scene,
        [
            "basemap",
            "sunlight",
            "building-lights",
            "cars",
            "transit",
            "trees",
            "slideshow",
            "sketch",
            "coolpaths",
            "isovist",
            "mobility",
            "wind"
        ]
    );
    assert_eq!(state["layers"]["basemap"]["active"], true);
    assert_eq!(state["site"]["data"]["roads"], "data/roads.geojson");
    assert_eq!(state["site"]["data"]["buildings"], "data/buildings.geojson");
    // The manifests are the whole catalogue, each with a palette category.
    let manifests = tv.welcome["manifests"].as_array().unwrap();
    assert!(manifests.iter().any(|m| m["id"] == "sunlight"));
    assert!(manifests.iter().any(|m| m["id"] == "cars" && m["category"] == "ambient"));
    assert!(manifests.iter().any(|m| m["id"] == "basemap" && m["category"] == "base"));
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
    tv.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 9.13 } })).await.unwrap();
    let snapped = table.event("state.layer").await["state"]["params"]["hour"].as_f64().unwrap();
    assert!((snapped - 9.15).abs() < 1e-9, "{snapped}");

    // Bad requests are refused and change nothing.
    for params in [json!({ "mode": "weekly" }), json!({ "nope": 1 }), json!({ "hour": "noon" })] {
        assert!(tv.request("layer.set", json!({ "layer": "sunlight", "params": params })).await.is_err());
    }
    assert!(tv.request("layer.set", json!({ "layer": "ghost", "params": {} })).await.is_err());

    // Intensity is host state like any other: clamped to 0..2 and broadcast.
    tv.request("layer.intensity", json!({ "layer": "sunlight", "intensity": 5 })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["intensity"], 2.0);
    assert!(tv.request("layer.intensity", json!({ "layer": "sunlight", "intensity": "bright" })).await.is_err());

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

    // `hour` is marked phone: true, `mode` is a primary control so phones get it too (#335),
    // `threshold` is neither.
    phone.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 7 } })).await.unwrap();
    phone.request("layer.set", json!({ "layer": "sunlight", "params": { "mode": "day" } })).await.unwrap();
    assert!(phone.request("layer.set", json!({ "layer": "sunlight", "params": { "threshold": 3 } })).await.is_err());
    // Phones turn layers on and off (#335); the controller hears which phone did it.
    phone.request("layer.activate", json!({ "layer": "sunlight", "active": false })).await.unwrap();
    let switched = tv.event("phone.switched").await;
    assert_eq!(
        (switched["layer"].clone(), switched["active"].clone(), switched["participant"]["slot"].clone()),
        (json!("sunlight"), json!(false), json!(0))
    );
    assert!(phone.request("layers.reset", json!({})).await.is_err());
    assert!(phone.request("engine.open", json!({ "kernel": "sunlight", "params": {}, "fields": ["shadow"] })).await.is_err());

    // The slot is held when the phone drops (see the resume test), so eight more do not fit.
    drop(phone);
    assert_eq!(tv.event("state.participants").await["participants"][0]["connected"], false);
    let mut phones = Vec::new();
    for _ in 0..7 {
        phones.push(Surface::join(&host, "phone", Some(&code)).await.unwrap());
    }
    // A ninth phone may still look (#462): it has no seat and changes nothing.
    let mut watcher = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert_eq!(watcher.welcome["watching"], true);
    let refused = watcher.request("layer.activate", json!({ "layer": "sunlight", "active": true })).await.unwrap_err();
    assert!(refused.contains("every seat"), "{refused}");
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
async fn the_table_asks_the_engine_about_one_place() {
    let host = host().await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    // lat and lon are filled in from the site; `at` is WGS84.
    let probe = json!({ "kernel": "sunlight", "params": { "time": "2026-06-21T12:00:00Z", "step_minutes": 15 }, "at": [11.97, 57.7] });
    let day = table.request("engine.probe", probe).await.unwrap();
    assert_eq!(day["light"].as_array().unwrap().len(), 96);
    let (sun, daylight) = (day["sun_hours"].as_f64().unwrap(), day["daylight_hours"].as_f64().unwrap());
    assert!(sun <= daylight + 1e-3 && (17.0..18.5).contains(&daylight), "{sun} h of {daylight} h");

    let off = json!({ "kernel": "sunlight", "params": { "time": "2026-06-21T12:00:00Z" }, "at": [12.5, 57.7] });
    assert!(table.request("engine.probe", off).await.unwrap_err().contains("not on the table"));
    assert!(table.request("engine.probe", json!({ "kernel": "sunlight", "params": {} })).await.is_err());
    let code = host.state.hub.session().code.clone();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    let ask = json!({ "kernel": "sunlight", "params": { "time": "2026-06-21T12:00:00Z" }, "at": [11.97, 57.7] });
    assert!(phone.request("engine.probe", ask).await.is_err(), "phones ask through tools");
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn what_if_changes_reach_the_engine_and_go_with_the_table() {
    let host = host().await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let spot = [11.97, 57.7];
    let sun_at = |sun: Value| sun["sun_hours"].as_f64().unwrap();
    let ask = json!({ "kernel": "sunlight", "params": { "time": "2026-03-20T12:00:00Z", "step_minutes": 15 }, "at": spot });
    let before = sun_at(table.request("engine.probe", ask.clone()).await.unwrap());
    assert!(before > 3.0, "sun at the equinox: {before} h");

    // A tall block just south of the spot shades it for most of the day (#500).
    let (dlon, dlat) = (0.0008, 0.0002);
    let south = spot[1] - 0.0003;
    let outline = json!([
        [spot[0] - dlon, south - dlat],
        [spot[0] + dlon, south - dlat],
        [spot[0] + dlon, south + dlat],
        [spot[0] - dlon, south + dlat]
    ]);
    table.request("engine.edit", json!({ "edits": [{ "kind": "building", "outline": outline, "height_m": 120 }] })).await.unwrap();
    let shaded = sun_at(table.request("engine.probe", ask.clone()).await.unwrap());
    assert!(shaded < before * 0.5, "{shaded} h with the block, {before} h without");

    // Only the table changes the scene, and the values are checked.
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    assert!(tv.request("engine.edit", json!({ "edits": [] })).await.is_err());
    let code = host.state.hub.session().code.clone();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert!(phone.request("engine.edit", json!({ "edits": [] })).await.is_err());
    let tall = json!({ "edits": [{ "kind": "tree", "at": spot, "radius_m": 4, "height_m": 500 }] });
    assert!(table.request("engine.edit", tall).await.is_err());
    // A second table can't overwrite the first one's changes, but sees them.
    let mut other = Surface::join(&host, "table", None).await.unwrap();
    assert!(other.request("engine.edit", json!({ "edits": [{ "kind": "remove", "at": spot }] })).await.is_err());
    assert_eq!(sun_at(other.request("engine.probe", ask.clone()).await.unwrap()), shaded);

    // An empty list gives the baked scene back, and so does the table that made them going away.
    table.request("engine.edit", json!({ "edits": [] })).await.unwrap();
    assert_eq!(sun_at(table.request("engine.probe", ask.clone()).await.unwrap()), before);
    table.request("engine.edit", json!({ "edits": [{ "kind": "building", "outline": outline, "height_m": 120 }] })).await.unwrap();
    drop(table);
    let mut restored = None;
    for _ in 0..50 {
        let now = sun_at(other.request("engine.probe", ask.clone()).await.unwrap());
        if now == before {
            restored = Some(now);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(restored, Some(before), "the baked scene is back once the table has gone");
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

#[tokio::test(flavor = "multi_thread")]
async fn the_scene_is_composed_and_saved() {
    let site = scratch_site("compose");
    let host = host_for(site.clone()).await;
    let mut composer = Surface::join(&host, "dev", None).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let order = |event: &Value| event["scene"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_string()).collect::<Vec<_>>();

    // A second copy of a layer gets its own id and its own state, and lands on top.
    let added = composer.request("scene.add", json!({ "use": "cars", "params": { "density": 30 } })).await.unwrap();
    assert_eq!(added["id"], "cars-2");
    let event = table.event("state.scene").await;
    assert_eq!(order(&event).last().unwrap(), "cars-2");
    assert_eq!(event["layers"]["cars-2"]["layer"], "cars");
    assert_eq!(event["layers"]["cars-2"]["active"], true);
    assert_eq!(event["layers"]["cars-2"]["params"]["density"], 30.0);
    assert_eq!(event["layers"]["cars"]["params"]["density"], 10.0);
    let saved = saved_layers(&site);
    assert_eq!(saved.last().unwrap(), &json!({ "use": "cars", "id": "cars-2", "active": true, "params": { "density": 30.0 } }));

    // Each copy is addressed by its id.
    composer.request("layer.set", json!({ "layer": "cars-2", "params": { "speed": 80 } })).await.unwrap();
    let event = table.event("state.layer").await;
    assert_eq!((event["layer"].as_str().unwrap(), &event["state"]["params"]["speed"]), ("cars-2", &json!(80.0)));

    // Moving changes the draw order, in the session and in the file.
    composer.request("scene.move", json!({ "layer": "cars-2", "index": 0 })).await.unwrap();
    assert_eq!(order(&table.event("state.scene").await)[..2], ["cars-2", "basemap"]);
    assert_eq!(saved_layers(&site)[0]["id"], "cars-2");
    composer.request("scene.move", json!({ "layer": "basemap", "index": 99 })).await.unwrap();
    assert_eq!(order(&table.event("state.scene").await).last().unwrap(), "basemap");

    // scene.set saves settings; layer.set changes the session only.
    composer.request("scene.set", json!({ "layer": "trees", "params": { "size": 9 }, "active": false })).await.unwrap();
    let event = table.event("state.layer").await;
    assert_eq!((&event["state"]["params"]["size"], &event["state"]["active"]), (&json!(3.0), &json!(false)));
    let trees = saved_layers(&site).into_iter().find(|l| l["use"] == "trees").unwrap();
    assert_eq!(trees, json!({ "use": "trees", "id": "trees", "active": false, "params": { "size": 3.0 } }));
    let live_only = saved_layers(&site).into_iter().find(|l| l["id"] == "cars-2").unwrap();
    assert_eq!(live_only["params"], json!({ "density": 30.0 }), "layer.set is not written to site.json");

    // A layer's button on the controller: its own name, description, icon and side. Null clears a field.
    let button = json!({ "name": " Shade ", "description": "Where the trees are", "icon": "tree", "side": "right" });
    composer.request("scene.set", json!({ "layer": "trees", "button": button })).await.unwrap();
    let shown = json!({ "name": "Shade", "description": "Where the trees are", "icon": "tree", "side": "right" });
    assert_eq!(table.event("state.layer").await["state"]["button"], shown);
    assert_eq!(saved_layers(&site).into_iter().find(|l| l["use"] == "trees").unwrap()["button"], shown);
    composer
        .request("scene.set", json!({ "layer": "trees", "button": { "description": null, "icon": null, "side": null } }))
        .await
        .unwrap();
    assert_eq!(table.event("state.layer").await["state"]["button"], json!({ "name": "Shade" }));
    for bad in [
        json!({ "side": "top" }),
        json!({ "name": "x".repeat(41) }),
        json!({ "icon": "Tree!" }),
        json!({ "colour": "red" }),
        json!("Shade"),
    ] {
        assert!(composer.request("scene.set", json!({ "layer": "trees", "button": bad })).await.is_err(), "{bad} should be refused");
    }
    composer.request("scene.set", json!({ "layer": "trees", "button": { "name": null } })).await.unwrap();
    table.event("state.layer").await;
    // Controls can be left off the controller and phones. The list is replaced whole, and must name real controls.
    let control = "opacity";
    composer.request("scene.set", json!({ "layer": "trees", "hide": [control, control] })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["hide"], json!([control]));
    assert_eq!(saved_layers(&site).into_iter().find(|l| l["use"] == "trees").unwrap()["hide"], json!([control]));
    assert!(composer.request("scene.set", json!({ "layer": "trees", "hide": ["no-such-control"] })).await.is_err());
    assert!(composer.request("scene.set", json!({ "layer": "trees", "hide": "all" })).await.is_err());
    composer.request("scene.set", json!({ "layer": "trees", "hide": [] })).await.unwrap();
    assert!(table.event("state.layer").await["state"].get("hide").is_none());
    assert!(
        saved_layers(&site).into_iter().find(|l| l["use"] == "trees").unwrap().get("button").is_none(),
        "an empty button is not written"
    );

    // Removing takes the layer out of the session and the file.
    composer.request("scene.remove", json!({ "layer": "cars-2" })).await.unwrap();
    let event = table.event("state.scene").await;
    assert!(event["layers"].get("cars-2").is_none() && !order(&event).contains(&"cars-2".to_string()));
    assert!(saved_layers(&site).iter().all(|l| l["id"] != "cars-2"));
    assert!(composer.request("layer.set", json!({ "layer": "cars-2", "params": {} })).await.is_err());

    // Bad requests are refused and change nothing.
    let before = saved_layers(&site);
    assert!(composer.request("scene.add", json!({ "use": "ghost" })).await.is_err());
    assert!(composer.request("scene.add", json!({ "use": "cars", "id": "trees" })).await.is_err());
    assert!(composer.request("scene.add", json!({ "use": "cars", "id": "Not OK" })).await.is_err());
    assert!(composer.request("scene.add", json!({ "use": "cars", "params": { "nope": 1 } })).await.is_err());
    assert!(composer.request("scene.move", json!({ "layer": "ghost", "index": 0 })).await.is_err());
    assert!(composer.request("scene.remove", json!({ "layer": "ghost" })).await.is_err());
    // The table and phones cannot edit the scene.
    assert!(table.request("scene.remove", json!({ "layer": "trees" })).await.is_err());
    let code = host.state.hub.session().code.clone();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert!(phone.request("scene.add", json!({ "use": "cars" })).await.is_err());
    assert_eq!(saved_layers(&site), before);
    host.shutdown().await;

    // The saved scene is what the next session starts with, and the rest of site.json is untouched.
    let host = host_for(site.clone()).await;
    let tv = Surface::join(&host, "tv", None).await.unwrap();
    let state = &tv.welcome["state"];
    assert_eq!(state["scene"].as_array().unwrap().last().unwrap(), "basemap");
    assert_eq!(state["layers"]["trees"]["params"]["size"], 3.0);
    assert_eq!(state["layers"]["trees"]["active"], false);
    assert_eq!(state["site"]["grid"]["width"], 1000);
    host.shutdown().await;
    let original: Value = serde_json::from_str(&std::fs::read_to_string(repo().join("sites/sample/site.json")).unwrap()).unwrap();
    let mut rewritten: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
    rewritten["layers"] = original["layers"].clone();
    assert_eq!(rewritten, original);
    let _ = std::fs::remove_dir_all(&site);
}

#[tokio::test(flavor = "multi_thread")]
async fn layers_hold_items_and_sequences_show_layers() {
    let site = scratch_site("items");
    let host = host_for(site.clone()).await;
    let mut editor = Surface::join(&host, "dev", None).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let saved = |id: &str| saved_layers(&site).into_iter().find(|l| l["id"] == id).unwrap();

    // Public transport inside the sun study: an item, drawn right on top of its layer, off while it is closed.
    let added = editor.request("scene.add", json!({ "use": "transit", "parent": "sunlight" })).await.unwrap();
    assert_eq!(added["id"], "transit-2", "the map at rest keeps its own 'transit'");
    let event = table.event("state.scene").await;
    let scene: Vec<&str> = event["scene"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    let at = scene.iter().position(|id| *id == "sunlight").unwrap();
    assert_eq!(scene[at + 1], "transit-2");
    assert_eq!(event["layers"]["transit-2"]["parent"], "sunlight");
    assert_eq!(event["layers"]["transit-2"]["active"], false, "the sun study is closed");
    assert_eq!(saved("sunlight")["items"], json!([{ "use": "transit", "id": "transit-2" }]));
    assert!(saved_layers(&site).iter().all(|l| l["id"] != "transit-2"), "an item is not a layer of the scene");

    // Opening the layer brings its items; an item cannot open on its own; closing takes them away.
    assert!(editor.request("layer.activate", json!({ "layer": "transit-2", "active": true })).await.is_err());
    editor.request("layer.activate", json!({ "layer": "sunlight", "active": true })).await.unwrap();
    assert_eq!(table.event("state.layer").await["layer"], "sunlight");
    let item = table.event("state.layer").await;
    assert_eq!((item["layer"].as_str().unwrap(), &item["state"]["active"]), ("transit-2", &json!(true)));
    editor.request("layer.activate", json!({ "layer": "transit-2", "active": false })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["active"], false);
    editor.request("layer.activate", json!({ "layer": "sunlight", "active": false })).await.unwrap();
    table.event("state.layer").await;
    // An item set not to come on stays off when its layer opens.
    editor.request("scene.set", json!({ "layer": "transit-2", "active": false })).await.unwrap();
    assert_eq!(saved("sunlight")["items"][0]["active"], false);
    editor.request("layer.activate", json!({ "layer": "sunlight", "active": true })).await.unwrap();
    table.event("state.layer").await;
    assert!(host.state.hub.welcome(0)["state"]["layers"]["transit-2"]["active"] == false);
    // Items have no buttons and hold no items.
    assert!(editor.request("scene.set", json!({ "layer": "transit-2", "button": { "name": "Buses" } })).await.is_err());
    assert!(editor.request("scene.add", json!({ "use": "trees", "parent": "transit-2" })).await.is_err());
    assert!(editor.request("scene.add", json!({ "use": "trees", "parent": "ghost" })).await.is_err());

    // Moving: a layer of the scene into another as an item, and back out.
    editor.request("scene.move", json!({ "layer": "cars", "parent": "sunlight", "index": 0 })).await.unwrap();
    table.event("state.scene").await;
    assert_eq!(
        saved("sunlight")["items"].as_array().unwrap().iter().map(|i| i["id"].clone()).collect::<Vec<_>>(),
        [json!("cars"), json!("transit-2")]
    );
    editor.request("scene.move", json!({ "layer": "cars", "parent": null, "index": 0 })).await.unwrap();
    table.event("state.scene").await;
    assert_eq!(saved_layers(&site)[0]["id"], "cars");
    // A layer moves with its items.
    editor.request("scene.move", json!({ "layer": "sunlight", "index": 0 })).await.unwrap();
    let event = table.event("state.scene").await;
    assert_eq!(event["scene"].as_array().unwrap()[0..2], [json!("sunlight"), json!("transit-2")]);
    assert!(editor.request("scene.move", json!({ "layer": "sunlight", "parent": "trees", "index": 0 })).await.is_err(), "it has items");

    // A sequence: the slideshow shows the sun study, then the trees at another size.
    let steps = json!({ "mode": "manual", "loop": true, "sequence": [
        { "layer": "sunlight", "params": { "hour": 9 }, "title": "Morning", "transition": "fade" },
        { "layer": "trees", "params": { "size": 2 }, "duration_s": 8 }
    ] });
    editor.request("scene.set", json!({ "layer": "slideshow", "steps": steps })).await.unwrap();
    let event = table.event("state.layer").await;
    assert_eq!(event["state"]["steps"]["sequence"][0]["params"]["hour"], 9.0);
    assert_eq!(saved("slideshow")["steps"]["sequence"][1], json!({ "layer": "trees", "params": { "size": 2.0 }, "duration_s": 8.0 }));
    for bad in [
        json!({ "sequence": [{ "layer": "ghost" }] }),
        json!({ "sequence": [{ "layer": "slideshow" }] }),
        json!({ "sequence": [{ "layer": "sunlight", "params": { "hour": "noon" } }] }),
        json!({ "mode": "sometimes" }),
    ] {
        assert!(editor.request("scene.set", json!({ "layer": "slideshow", "steps": bad })).await.is_err(), "{bad} should be refused");
    }
    assert!(
        editor.request("scene.set", json!({ "layer": "trees", "steps": { "sequence": [{ "layer": "sunlight" }] } })).await.is_err(),
        "only a sequence layer shows other layers"
    );
    editor.request("scene.set", json!({ "layer": "trees", "steps": { "reveal": "then-next" } })).await.unwrap();
    table.event("state.layer").await;
    // Removing a layer drops the steps that showed it.
    let removed = editor.request("scene.remove", json!({ "layer": "sunlight" })).await.unwrap();
    assert_eq!(removed["dropped_steps"], 1);
    let event = table.event("state.scene").await;
    assert!(event["layers"].get("transit-2").is_none(), "its items go with it");
    assert_eq!(saved("slideshow")["steps"]["sequence"].as_array().unwrap().len(), 1);

    // Groups and order for the controller's rails.
    editor.request("scene.set", json!({ "layer": "trees", "button": { "group": "Nature", "order": 2 } })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["button"], json!({ "group": "Nature", "order": 2.0 }));
    assert!(editor.request("scene.set", json!({ "layer": "trees", "button": { "order": "first" } })).await.is_err());
    // A button kept off the controller (#58), and back.
    editor.request("scene.set", json!({ "layer": "trees", "button": { "hidden": true } })).await.unwrap();
    assert_eq!(table.event("state.layer").await["state"]["button"]["hidden"], true);
    assert_eq!(saved("trees")["button"]["hidden"], true);
    editor.request("scene.set", json!({ "layer": "trees", "button": { "hidden": null } })).await.unwrap();
    assert!(table.event("state.layer").await["state"]["button"].get("hidden").is_none());
    assert!(editor.request("scene.set", json!({ "layer": "trees", "button": { "hidden": "yes" } })).await.is_err());
    // Dragging buttons between the rails is one change.
    editor.request("scene.arrange", json!({ "rails": { "right": ["trees"] } })).await.unwrap();
    let event = table.event("state.scene").await;
    assert_eq!(event["layers"]["trees"]["button"]["side"], "right");
    assert_eq!(event["layers"]["trees"]["button"]["order"], 1.0);
    assert_eq!(saved("trees")["button"]["side"], "right");
    assert!(editor.request("scene.arrange", json!({ "rails": { "middle": ["trees"] } })).await.is_err());
    host.shutdown().await;

    // What was saved starts the next session the same way.
    let host = host_for(site.clone()).await;
    let tv = Surface::join(&host, "tv", None).await.unwrap();
    assert_eq!(tv.welcome["state"]["layers"]["slideshow"]["steps"]["mode"], "manual");
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&site);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_custom_layer_is_offered_and_used_like_any_layer() {
    let site = scratch_site("custom");
    let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
    manifest["custom"] = json!({ "heat-walk": {
        "name": "Heat walk", "icon": "route",
        "data": [{ "id": "paths", "dataset": "walkways" }],
        "look": [{ "id": "lines", "block": "lines", "data": "paths", "props": { "width": 3 } }],
        "controls": [{ "id": "width", "type": "range", "label": "Width", "min": 1, "max": 8, "step": 1, "default": 3, "bind": "look.lines.width" }]
    } });
    std::fs::write(site.join("site.json"), manifest.to_string()).unwrap();
    let host = host_for(site.clone()).await;
    let mut editor = Surface::join(&host, "dev", None).await.unwrap();
    let offered = editor.welcome["manifests"].as_array().unwrap().iter().find(|m| m["id"] == "heat-walk").cloned().unwrap();
    assert_eq!((offered["name"].as_str(), offered["category"].as_str()), (Some("Heat walk"), Some("analysis")));
    assert_eq!(offered["custom"]["look"][0]["block"], "lines");
    let added = editor.request("scene.add", json!({ "use": "custom:heat-walk", "params": { "width": 5 } })).await.unwrap();
    assert_eq!(added["id"], "heat-walk");
    assert_eq!(
        saved_layers(&site).last().unwrap(),
        &json!({ "use": "custom:heat-walk", "id": "heat-walk", "active": true, "params": { "width": 5.0 } })
    );
    assert!(
        editor.request("scene.add", json!({ "use": "custom:heat-walk", "params": { "width": 50 } })).await.is_ok(),
        "clamped like any control"
    );
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&site);
}

/// A plain HTTP GET, returning the body.
async fn http_get(host: &RunningHost, path: &str) -> Vec<u8> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(host.addr).await.unwrap();
    stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: {}\r\n\r\n", host.addr).as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let split = response.windows(4).position(|w| w == b"\r\n\r\n").expect("an HTTP response");
    assert!(
        response.starts_with(b"HTTP/1.0 200") || response.starts_with(b"HTTP/1.1 200"),
        "{}",
        String::from_utf8_lossy(&response[..split])
    );
    response[split + 4..].to_vec()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_serves_the_twin() {
    let host = host().await;
    let body = http_get(&host, "/api/model").await;
    assert_eq!(&body[0..4], b"MRSM");
    let (vertices, indices) = (u32_at(&body, 8) as usize, u32_at(&body, 12) as usize);
    assert!(vertices > 1000 && indices % 3 == 0);
    assert_eq!(body.len(), 32 + vertices * 20 + indices * 4);
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn calibration_is_saved_shared_and_survives_a_restart() {
    // A copy of the sample site, so the test's calibration.json does not land in the repository.
    let dir = scratch_site("calibration");
    // The site's own table calibration in the same file must be left alone.
    std::fs::write(
        dir.join("calibration.json"),
        r#"{ "table": { "center": { "lon": 11.9778, "lat": 57.6884 }, "zoom": 16, "bearing": 0 } }"#,
    )
    .unwrap();
    let start = || async {
        mrs_host::start(HostConfig {
            site_dir: dir.clone(),
            layers_dir: repo().join("packages/layers"),
            web_dir: None,
            bind: "127.0.0.1:0".parse().unwrap(),
            backend: Backend::Cpu,
            session: Default::default(),
            sources: std::sync::Arc::new(mrs_host::Sources::in_memory()),
            programs: true,
        })
        .await
        .unwrap()
    };

    let host = start().await;
    let code = host.state.hub.session().code.clone();
    let mut dev = Surface::join(&host, "dev", None).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert_eq!(dev.request("calibration.get", json!({})).await.unwrap()["projector"], Value::Null);

    let projector = json!({ "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1], "image": { "width": 1920, "height": 1080 }, "error_px": 0.4 });
    assert!(phone.request("calibration.set", json!({ "projector": projector })).await.is_err());
    assert!(dev.request("calibration.set", json!({ "projector": { "matrix": [1, 2, 3] } })).await.is_err());
    dev.request("calibration.set", json!({ "projector": projector })).await.unwrap();
    assert_eq!(table.event("calibration").await["projector"], projector);
    // Any controller can ask the table to open its calibration tool.
    dev.request("calibration.mode", json!({ "active": true })).await.unwrap();
    assert_eq!(table.event("calibration.mode").await["active"], true);
    // The tool's panel lives on the controller (#594): the table says where it is, the controller answers.
    table.request("calibration.state", json!({ "index": 2, "count": 10 })).await.unwrap();
    assert_eq!(dev.event("calibration.state").await["index"], 2);
    dev.request("calibration.command", json!({ "action": "nudge", "dx": 1, "dy": 0 })).await.unwrap();
    assert_eq!(table.event("calibration.command").await["action"], "nudge");
    assert!(dev.request("calibration.command", json!({ "action": "explode" })).await.is_err());
    assert!(phone.request("calibration.command", json!({ "action": "next" })).await.is_err());
    host.shutdown().await;

    let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("calibration.json")).unwrap()).unwrap();
    assert_eq!(file["projector"], projector);
    assert_eq!(file["table"]["zoom"], 16);

    let host = start().await;
    let mut dev = Surface::join(&host, "dev", None).await.unwrap();
    assert_eq!(dev.request("calibration.get", json!({})).await.unwrap()["projector"], projector);
    // Clearing goes back to the flat table.
    dev.request("calibration.set", json!({ "projector": null })).await.unwrap();
    assert_eq!(dev.request("calibration.get", json!({})).await.unwrap()["projector"], Value::Null);
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// A plain HTTP POST with a body, returning the status line's code and the body as JSON.
async fn http_post(host: &RunningHost, path: &str, filename: &str, body: &[u8]) -> (u16, Value) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(host.addr).await.unwrap();
    let head = format!(
        "POST {path} HTTP/1.0\r\nHost: {}\r\nX-Filename: {filename}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\n\r\n",
        host.addr,
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let split = response.windows(4).position(|w| w == b"\r\n\r\n").expect("an HTTP response");
    let status = String::from_utf8_lossy(&response[9..12]).parse().unwrap();
    (status, serde_json::from_slice(&response[split + 4..]).unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_table_takes_its_buildings_without_a_restart() {
    // A table as the setup wizard makes it: a base map, sunlight and no data.
    let base = std::env::temp_dir().join(format!("mrs-host-import-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = base.join("new-place");
    mrs_site::create::create(&dir, "New place", 11.97, 57.70, 1000.0, 600.0, 0.0).unwrap();
    let host = host_for(dir.clone()).await;
    let mut dev = Surface::join(&host, "dev", None).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let twin_before = http_get(&host, "/api/model").await.len();
    let refused = dev.request("scene.add", json!({ "use": "building-lights" })).await.unwrap_err();
    assert!(refused.contains("no 'buildings' dataset"), "{refused}");

    // Two footprints in SWEREF99 TM, as a municipal export would have them, one with storeys only.
    let square = |e: f64, n: f64| json!([[[e, n], [e + 20.0, n], [e + 20.0, n + 20.0], [e, n + 20.0], [e, n]]]);
    let (e, n) = mrs_site::Crs::from_epsg(3006).unwrap().forward(11.969, 57.6995);
    let file = serde_json::to_vec(&json!({ "type": "FeatureCollection", "features": [
        { "type": "Feature", "properties": { "height": 20 }, "geometry": { "type": "Polygon", "coordinates": square(e, n) } },
        { "type": "Feature", "properties": { "building:levels": 5 }, "geometry": { "type": "Polygon", "coordinates": square(e + 60.0, n) } },
    ] }))
    .unwrap();

    let (status, report) = http_post(&host, "/api/data/inspect?target=buildings", "buildings.geojson", &file).await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["summary"], "2 buildings, 2 with a height");
    assert_eq!(report["crs"], json!({ "code": "EPSG:3006", "guessed": true }));
    assert_eq!(report["preview"]["features"].as_array().unwrap().len(), 2);
    assert!(!dir.join("data/buildings.geojson").exists(), "inspect writes nothing");

    let (status, report) = http_post(&host, "/api/data/import?target=buildings", "buildings.geojson", &file).await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["path"], "data/buildings.geojson");
    let changed = table.event("site.changed").await;
    assert_eq!(changed["site"]["data"]["buildings"], "data/buildings.geojson");
    assert!(http_get(&host, "/api/model").await.len() > twin_before, "the twin has the new buildings");
    dev.request("scene.add", json!({ "use": "building-lights" })).await.unwrap();
    let info: Value = serde_json::from_slice(&http_get(&host, "/api/info").await).unwrap();
    assert_eq!(info["site"]["data"]["buildings"], "data/buildings.geojson");

    // A blocker is a 422 with the reason, and nothing changes.
    let (status, report) = http_post(&host, "/api/data/import?target=trees", "trees.zip", b"PK\x03\x04").await;
    assert_eq!(status, 422);
    assert_eq!(report["issues"][0]["code"], "read.unknown");
    let (status, report) = http_post(&host, "/api/data/import?target=slideshow", "s.json", b"{}").await;
    assert_eq!(status, 400);
    assert!(report["error"].as_str().unwrap().contains("not something a table can take"));

    // The table is renamed, moved and turned: the site is rewritten, the scene re-baked and every surface told.
    let place = serde_json::to_vec(&json!({ "name": "Harbour", "origin": { "lon": 11.968, "lat": 57.6996 }, "extent": { "width_m": 400, "height_m": 250, "rotation_deg": 15 }, "table_width_cm": 80 })).unwrap();
    let (status, answer) = http_post(&host, "/api/site/place", "", &place).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["site"]["name"], "Harbour");
    let changed = table.event("site.changed").await;
    assert_eq!(changed["site"]["extent"], json!({ "width_m": 400.0, "height_m": 250.0, "rotation_deg": 15.0 }));
    assert_eq!(changed["site"]["grid"]["width"], 400);
    assert_eq!(changed["site"]["data"]["buildings"], "data/buildings.geojson", "the data stays");
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("site.json")).unwrap()).unwrap();
    assert_eq!(saved["origin"], json!({ "lon": 11.968, "lat": 57.6996 }));
    // The table's width sets the model scale (400 m on 80 cm is 1 : 500); its height follows the shape.
    assert_eq!(saved["table"], json!({ "width_cm": 80.0, "height_cm": 50.0 }));
    // A bad place is refused with the reason and changes nothing.
    let bad =
        serde_json::to_vec(&json!({ "origin": { "lon": 11.968, "lat": 95 }, "extent": { "width_m": 400, "height_m": 250 } })).unwrap();
    let (status, answer) = http_post(&host, "/api/site/place", "", &bad).await;
    assert_eq!(status, 422);
    assert!(answer["error"].as_str().unwrap().contains("latitude"), "{answer}");
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&base);
}

/// A stand-in for Overpass that is busy (502) for the first `busy` queries, then answers
/// each with `answer`; and the queries it got.
async fn overpass(answer: Value, busy: usize) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = asked.clone();
    let app = axum::Router::new().route(
        "/api/interpreter",
        axum::routing::post(move |body: String| {
            let (log, answer) = (log.clone(), answer.clone());
            async move {
                let mut log = log.lock().unwrap();
                log.push(body);
                if log.len() <= busy {
                    return axum::response::IntoResponse::into_response(axum::http::StatusCode::BAD_GATEWAY);
                }
                axum::response::IntoResponse::into_response(axum::Json(answer))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/interpreter", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, asked)
}

#[tokio::test(flavor = "multi_thread")]
async fn buildings_come_from_openstreetmap_when_asked() {
    let base = std::env::temp_dir().join(format!("mrs-host-osm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = base.join("osm-place");
    mrs_site::create::create(&dir, "OSM place", 11.97, 57.70, 1000.0, 600.0, 0.0).unwrap();
    let ring = |lat: f64, lon: f64| {
        let p = |dy: f64, dx: f64| json!({ "lat": lat + dy, "lon": lon + dx });
        json!([p(0.0, 0.0), p(0.0, 0.0003), p(0.0002, 0.0003), p(0.0002, 0.0), p(0.0, 0.0)])
    };
    // One building on the table, one in the fetch margin just west of it.
    let (url, asked) = overpass(
        json!({ "elements": [
        { "type": "way", "id": 1, "tags": { "building": "yes", "height": "14" }, "geometry": ring(57.700, 11.970) },
        { "type": "way", "id": 2, "tags": { "building": "house", "building:levels": "2" }, "geometry": ring(57.700, 11.9610) },
        // What a fetch of everything (#310) also gets: a tree and a main street, no footways.
        { "type": "node", "id": 3, "lat": 57.7001, "lon": 11.9701, "tags": { "natural": "tree" } },
        { "type": "way", "id": 4, "tags": { "highway": "primary" }, "geometry": [{ "lat": 57.699, "lon": 11.965 }, { "lat": 57.701, "lon": 11.975 }] },
    ] }),
        1,
    )
    .await;
    std::env::set_var("MRS_OVERPASS_URL", &url);
    let host = host_for(dir.clone()).await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();

    let (status, report) = http_post(&host, "/api/data/inspect?target=buildings&source=osm", "", b"").await;
    assert_eq!(status, 200, "{report}");
    assert_eq!((report["count"].as_u64(), report["inside"].as_u64()), (Some(2), Some(1)));
    assert_eq!(report["preview"]["features"].as_array().unwrap().len(), 2, "the preview shows what lies off the table too");
    assert!(report["issues"].as_array().unwrap().iter().any(|i| i["code"] == "source.osm"), "{report}");
    // The first try found the server busy; the second got the answer.
    assert_eq!(asked.lock().unwrap().len(), 2, "a busy server is asked again");
    let query = asked.lock().unwrap()[1].clone();
    assert!(query.starts_with("data=") && query.contains("building"), "{query}");

    let (status, report) = http_post(&host, "/api/data/import?target=buildings&source=osm&crop=1", "", b"").await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["path"], "data/buildings.geojson");
    table.event("site.changed").await;
    let saved: Value = serde_json::from_slice(&std::fs::read(dir.join("data/buildings.geojson")).unwrap()).unwrap();
    assert_eq!(saved["source"]["attribution"], "© OpenStreetMap contributors");
    assert_eq!(asked.lock().unwrap().len(), 2, "the import brings in what the preview fetched, without asking again");

    // Everything at once (#310): one query for trees, streets and walkways, each kept for its import.
    let (status, answer) = http_post(&host, "/api/data/osm?targets=trees,data:roads,walkways,trips", "", b"").await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(asked.lock().unwrap().len(), 3, "one query for every dataset");
    let query = asked.lock().unwrap()[2].clone();
    assert!(query.contains("tree") && query.contains("highway"), "{query}");
    let datasets = answer["datasets"].as_array().unwrap();
    assert_eq!(datasets.iter().map(|d| d["dataset"].as_str().unwrap()).collect::<Vec<_>>(), ["trees", "roads", "walkways", "trips"]);
    assert_eq!((datasets[0]["ok"].as_bool(), datasets[0]["count"].as_u64()), (Some(true), Some(1)));
    assert_eq!((datasets[1]["ok"].as_bool(), datasets[1]["count"].as_u64()), (Some(true), Some(1)));
    assert_eq!(datasets[2]["report"]["issues"][0]["code"], "osm.empty", "{answer}");
    assert_eq!(datasets[3]["report"]["issues"][0]["code"], "osm.unavailable");
    let (status, report) = http_post(&host, "/api/data/import?target=trees&source=osm", "", b"").await;
    assert_eq!(status, 200, "{report}");
    table.event("site.changed").await;
    let (status, report) = http_post(&host, "/api/data/import?target=data:roads&source=osm", "", b"").await;
    assert_eq!(status, 200, "{report}");
    table.event("site.changed").await;
    assert_eq!(asked.lock().unwrap().len(), 3, "the imports bring in what the fetch got");
    // Asking again within a while answers from what was kept.
    let (_, again) = http_post(&host, "/api/data/osm?targets=trees", "", b"").await;
    assert_eq!(again["datasets"][0]["count"], 1);
    assert_eq!(asked.lock().unwrap().len(), 3);

    // OpenStreetMap has no trips or ground heights.
    let (status, report) = http_post(&host, "/api/data/inspect?target=trips&source=osm", "", b"").await;
    assert_eq!(status, 422);
    assert_eq!(report["issues"][0]["code"], "osm.unavailable");
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&base);
}

/// A Terrarium tile server whose ground rises 1 m per tile pixel eastwards, busy once per tile.
async fn terrarium() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = asked.clone();
    let app = axum::Router::new().route(
        "/{z}/{x}/{name}",
        axum::routing::get(move |axum::extract::Path((z, x, name)): axum::extract::Path<(u32, u32, String)>| {
            let log = log.clone();
            async move {
                let path = format!("{z}/{x}/{name}");
                let first = {
                    let mut log = log.lock().unwrap();
                    log.push(path.clone());
                    log.iter().filter(|p| **p == path).count() == 1
                };
                if first {
                    return axum::response::IntoResponse::into_response(axum::http::StatusCode::SERVICE_UNAVAILABLE);
                }
                let mut bytes = Vec::new();
                {
                    let mut encoder = png::Encoder::new(&mut bytes, 256, 256);
                    encoder.set_color(png::ColorType::Rgb);
                    let mut writer = encoder.write_header().unwrap();
                    // 32768 + 20 + column: (R, G) = (128, 20 + column), up to 275, which carries into R.
                    let pixels: Vec<u8> = (0..256 * 256)
                        .flat_map(|i| {
                            let v = 32768 + 20 + (i % 256) as u32;
                            [(v / 256) as u8, (v % 256) as u8, 0]
                        })
                        .collect();
                    writer.write_image_data(&pixels).unwrap();
                }
                axum::response::IntoResponse::into_response(([(axum::http::header::CONTENT_TYPE, "image/png")], bytes))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, asked)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_ground_comes_from_free_elevation_when_asked() {
    let base = std::env::temp_dir().join(format!("mrs-host-elevation-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let dir = base.join("hills");
    mrs_site::create::create(&dir, "Hills", 11.97, 57.70, 1000.0, 600.0, 0.0).unwrap();
    let (url, asked) = terrarium().await;
    std::env::set_var("MRS_ELEVATION_URL", &url);
    let host = host_for(dir.clone()).await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();

    let (status, report) = http_post(&host, "/api/data/import?target=terrain&source=elevation", "", b"").await;
    assert_eq!(status, 200, "{report}");
    assert!(report["issues"].as_array().unwrap().iter().any(|i| i["code"] == "source.elevation"), "{report}");
    table.event("site.changed").await;
    let site = mrs_site::Site::load(&dir).unwrap();
    assert!(site.manifest.scene.terrain.as_ref().is_some_and(|t| t.path.ends_with(".tif")), "the ground is a GeoTIFF");
    // Every tile was busy once and asked again.
    let asked = asked.lock().unwrap().clone();
    assert!(!asked.is_empty() && asked.len() % 2 == 0, "{asked:?}");
    assert!(asked.iter().all(|p| p.starts_with("14/")), "{asked:?}");

    // Only the ground comes from the elevation service.
    let (status, report) = http_post(&host, "/api/data/inspect?target=buildings&source=elevation", "", b"").await;
    assert_eq!(status, 422);
    assert_eq!(report["issues"][0]["code"], "elevation.unavailable");
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn the_editor_keeps_a_picture_of_the_table_for_home() {
    let site = scratch_site("thumbnail");
    let host = host_for(site.clone()).await;
    let url = format!("http://{}/api/site/thumbnail", host.addr);
    let client = reqwest::Client::new();
    let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];
    let sent = client.post(&url).body(jpeg.clone()).send().await.unwrap();
    assert_eq!(sent.status(), 204);
    assert_eq!(std::fs::read(site.join(mrs_host::THUMBNAIL)).unwrap(), jpeg);
    // Anything but a JPEG is refused.
    let refused = client.post(&url).body("<svg/>").send().await.unwrap();
    assert_eq!(refused.status(), 400);
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&site);
}

#[tokio::test]
async fn site_files_are_never_cached_by_the_browser() {
    // Every table is served at the same address, so a cached or revalidated copy could be
    // another table's file (#222).
    let site = scratch_site("no-store");
    let host = host_for(site.clone()).await;
    let client = reqwest::Client::new();
    let answer = client.get(format!("http://{}/site/site.json", host.addr)).send().await.unwrap();
    assert_eq!(answer.status(), 200);
    assert_eq!(answer.headers().get("cache-control").and_then(|v| v.to_str().ok()), Some("no-store"));
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&site);
}

/// A stand-in map service on this computer that remembers how each request was signed.
async fn signing_service() -> (std::net::SocketAddr, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use axum::http::HeaderMap;
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri, headers: HeaderMap| {
        let log = log.clone();
        async move {
            let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("-").to_string();
            log.lock().unwrap().push(format!("{uri} {auth}"));
            if uri.path().ends_with("token") {
                return ([("content-type", "application/json")], r#"{"access_token":"T1","expires_in":3600}"#.as_bytes().to_vec());
            }
            if uri.path().contains("positions") {
                return (
                    [("content-type", "application/json")],
                    br#"[{"detailsReference":"a","latitude":57.7,"longitude":11.97,"line":{"name":"6","transportMode":"tram"}}]"#.to_vec(),
                );
            }
            ([("content-type", "image/png")], vec![0x89, b'P', b'N', b'G'])
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, seen)
}

#[tokio::test]
async fn sources_keep_keys_on_the_host_and_sign_requests_for_the_table() {
    let (service, seen) = signing_service().await;
    let host = host().await;
    let base = format!("http://{}", host.addr);
    let client = reqwest::Client::new();

    // A page from another site in the same browser may not add a source.
    let foreign = client
        .post(format!("{base}/api/sources"))
        .header("origin", "https://evil.example.org")
        .json(&json!({ "kind": "tiles", "name": "Tiles", "url": format!("http://{service}/{{z}}/{{x}}/{{y}}.png") }))
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status(), 403);

    // The editor adds a tile source with a key; the key is never listed.
    let saved = client
        .post(format!("{base}/api/sources"))
        .header("origin", &base)
        .json(&json!({ "kind": "tiles", "name": "My tiles", "url": format!("http://{service}/{{z}}/{{x}}/{{y}}.png"), "auth": "query", "param": "key", "secret": "s3cret-key" }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), 200);
    let listed = client.get(format!("{base}/api/sources")).send().await.unwrap().text().await.unwrap();
    assert!(listed.contains("\"has_secret\":true") && !listed.contains("s3cret-key"), "{listed}");

    // A tile through the host carries the key to the service, and only the picture comes back.
    let tile = client.get(format!("{base}/api/sources/my-tiles/tile/3/2/1.png")).send().await.unwrap();
    assert_eq!(tile.status(), 200);
    assert_eq!(tile.headers()["content-type"], "image/png");
    assert!(seen.lock().unwrap().last().unwrap().starts_with("/3/2/1.png?key=s3cret-key"));

    // The proxy refuses addresses on any other server.
    let elsewhere =
        client.get(format!("{base}/api/sources/my-tiles/proxy")).query(&[("url", "https://example.org/x")]).send().await.unwrap();
    assert_eq!(elsewhere.status(), 403);

    // A WMS with a login: the table names the source, the host adds the password.
    client
        .post(format!("{base}/api/sources"))
        .json(&json!({ "kind": "wms", "name": "City WMS", "url": format!("http://{service}/wms"), "auth": "basic", "user": "anna", "secret": "pw" }))
        .send()
        .await
        .unwrap();
    let map = client
        .get(format!("{base}/api/wms"))
        .query(&[("source", "city-wms"), ("layers", "roads"), ("bbox", "11.9,57.6,12.0,57.7"), ("width", "64"), ("height", "64")])
        .send()
        .await
        .unwrap();
    assert_eq!(map.status(), 200);
    assert!(seen.lock().unwrap().last().unwrap().ends_with("Basic YW5uYTpwdw=="));

    // Västtrafik: client credentials are traded for a token, and positions become vehicles.
    client
        .post(format!("{base}/api/sources"))
        .json(&json!({ "kind": "vasttrafik", "url": format!("http://{service}"), "secret": "a2V5" }))
        .send()
        .await
        .unwrap();
    let vehicles: Value =
        client.get(format!("{base}/api/transit/vasttrafik/vehicles?bbox=11.9,57.6,12.0,57.7")).send().await.unwrap().json().await.unwrap();
    assert_eq!(vehicles["vehicles"][0]["line"], "6");
    let log = seen.lock().unwrap().clone();
    assert!(log.iter().any(|l| l.starts_with("/token") && l.ends_with("Basic a2V5")), "{log:?}");
    assert!(log.iter().any(|l| l.contains("/pr/v4/positions") && l.ends_with("Bearer T1")), "{log:?}");

    // Test says plainly when it works.
    let status: Value = client.post(format!("{base}/api/sources/my-tiles/test")).send().await.unwrap().json().await.unwrap();
    assert_eq!(status["ok"], true, "{status}");
    host.shutdown().await;
}

/// #72: the editor's edits, an outside tool's edit (with its note) and a hand edit of the
/// file land in one history, each shows live on the table, and each can be undone.
#[tokio::test(flavor = "multi_thread")]
async fn every_change_to_site_json_is_one_history_and_each_can_be_undone() {
    let site = scratch_site("history");
    let host = host_for(site.clone()).await;
    let mut editor = Surface::join(&host, "dev", None).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let ids = |event: &Value| event["scene"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_string()).collect::<Vec<_>>();

    let start = editor.request("history.list", json!({})).await.unwrap();
    assert_eq!(start["revisions"].as_array().unwrap().len(), 1);
    assert_eq!(start["can_undo"], false);

    // 1. The editor adds a layer.
    editor.request("scene.add", json!({ "use": "cars", "id": "more-cars" })).await.unwrap();
    let changed = editor.event("history.changed").await;
    assert_eq!(changed["revision"]["by"], "editor");
    assert_eq!(changed["revision"]["keys"], json!(["layers"]));
    assert!(changed["revision"]["summary"].as_str().unwrap().starts_with("Added "));

    // 2. The MCP server writes the file and leaves a note saying who it is.
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
    doc["palette"] = json!({ "set": "night" });
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    std::fs::write(
        site.join(".mrstudio/next-change.json"),
        json!({ "by": "mcp", "summary": "Set a night palette", "at": now }).to_string(),
    )
    .unwrap();
    std::fs::write(site.join("site.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    let changed = editor.event("history.changed").await;
    assert_eq!((changed["revision"]["by"].as_str(), changed["revision"]["summary"].as_str()), (Some("mcp"), Some("Set a night palette")));
    assert_eq!(table.event("palette.changed").await["palette"]["set"], "night");

    // 3. A hand edit removes the layer the editor added.
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
    doc["layers"].as_array_mut().unwrap().retain(|l| l["id"] != "more-cars");
    std::fs::write(site.join("site.json"), serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    let changed = editor.event("history.changed").await;
    assert_eq!(changed["revision"]["by"], "outside");
    assert_eq!(changed["revision"]["summary"], "Changed outside MR Studio: the layers");
    assert!(!ids(&table.event("state.scene").await).contains(&"more-cars".to_string()), "the table follows the file");

    let list = editor.request("history.list", json!({})).await.unwrap();
    let by: Vec<&str> = list["revisions"].as_array().unwrap().iter().map(|r| r["by"].as_str().unwrap()).collect();
    assert_eq!(by, ["outside", "mcp", "editor", "start"], "one history, newest first");

    // Undo the hand edit: the layer is back on the table and in the file.
    let after = editor.request("history.undo", json!({})).await.unwrap();
    assert_eq!(after["can_redo"], true);
    assert!(ids(&table.event("state.scene").await).contains(&"more-cars".to_string()));
    assert!(saved_layers(&site).iter().any(|l| l["id"] == "more-cars"));
    // Undo the MCP server's palette, then the editor's layer.
    editor.request("history.undo", json!({})).await.unwrap();
    assert!(table.event("palette.changed").await["palette"].is_null());
    editor.request("history.undo", json!({})).await.unwrap();
    assert!(!saved_layers(&site).iter().any(|l| l["id"] == "more-cars"));
    assert!(editor.request("history.undo", json!({})).await.is_err(), "nothing older");
    // The host's own writes are never seen again as outside edits.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let list = editor.request("history.list", json!({})).await.unwrap();
    assert_eq!(list["revisions"].as_array().unwrap().len(), 4);
    assert_eq!(list["head"], 1);

    // Restore brings the newest version back on top, and nothing is lost.
    editor.request("history.restore", json!({ "revision": 4 })).await.unwrap();
    let list = editor.request("history.list", json!({})).await.unwrap();
    assert_eq!(list["revisions"][0]["by"], "history");
    assert_eq!(list["revisions"].as_array().unwrap().len(), 5);

    // A phone may not see it.
    let code = editor.welcome["state"]["session"]["code"].as_str().unwrap().to_string();
    let mut phone = Surface::join(&host, "phone", Some(&code)).await.unwrap();
    assert!(phone.request("history.list", json!({})).await.is_err());
    host.shutdown().await;
}

/// #72: a hand edit that breaks site.json is kept in the history and reported, the table
/// keeps what it shows, and undo puts the last good version back.
#[tokio::test(flavor = "multi_thread")]
async fn a_broken_hand_edit_is_reported_and_can_be_undone() {
    let site = scratch_site("history-broken");
    let host = host_for(site.clone()).await;
    let mut editor = Surface::join(&host, "dev", None).await.unwrap();
    let good = std::fs::read_to_string(site.join("site.json")).unwrap();
    let mut broken: Value = serde_json::from_str(&good).unwrap();
    broken["layers"] = json!(7);
    std::fs::write(site.join("site.json"), broken.to_string()).unwrap();
    let problem = editor.event("site.problem").await;
    assert!(!problem["message"].as_str().unwrap().is_empty());
    editor.request("history.undo", json!({})).await.unwrap();
    let back: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
    assert_eq!(back, serde_json::from_str::<Value>(&good).unwrap());
    host.shutdown().await;
}

#[tokio::test]
async fn a_failed_engine_is_replaced_and_the_surfaces_are_told() {
    let host = host().await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let params = json!({ "mode": "instant", "time": "2026-06-21T13:00:00Z" });
    table.request("engine.open", json!({ "kernel": "sunlight", "params": params, "fields": ["shadow"] })).await.unwrap();
    table.frame().await;

    host.state.engine.inject_fault();
    let restarted = table.event("engine.restarted").await;
    assert_eq!(restarted["backend"], "cpu");
    assert!(restarted["message"].as_str().unwrap().contains("a fault was injected"), "{restarted}");
    let (incidents, total) = host.state.health.incidents_after(0);
    assert_eq!(total, 1);
    assert!(incidents[0].1.contains("A new engine runs on the CPU"));

    // The new engine has the scene: a stream opened on it works as before.
    assert_eq!(table.request("engine.info", json!({})).await.unwrap()["backend"], "cpu");
    let opened = table.request("engine.open", json!({ "kernel": "sunlight", "params": params, "fields": ["shadow"] })).await.unwrap();
    assert!(opened["stream"].as_u64().is_some());
    let frame = table.frame().await;
    assert_eq!((u32_at(&frame, 16), u32_at(&frame, 20)), (1000, 600));
    host.shutdown().await;
}

#[tokio::test]
async fn windows_say_they_are_alive() {
    let host = host().await;
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    let mut phone = Surface::join(&host, "phone", Some(&host.state.hub.session().code)).await.unwrap();
    let beat = |window: &str| Message::Text(json!({ "t": "alive", "window": window, "fps": 58.5 }).to_string().into());
    table.socket.send(beat("surface-1-0-table")).await.unwrap();
    // A phone is not a window of the app; its beats are not taken.
    phone.socket.send(beat("surface-1-1-tv")).await.unwrap();
    // A request after the beat: when it is answered, the beat has been read.
    table.request("engine.info", json!({})).await.unwrap();
    phone.request("engine.info", json!({})).await.ok();
    let windows = host.state.health.windows();
    assert_eq!(windows.len(), 1, "{windows:?}");
    assert_eq!((windows[0].window.as_str(), windows[0].role.as_str(), windows[0].fps), ("surface-1-0-table", "table", 58.5));
    host.shutdown().await;
}

/// A hello over a socket that says which page it comes from, as a browser's does.
async fn hello_from(host: &RunningHost, origin: &str, role: &str, code: Option<&str>) -> Value {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://{}/ws", host.addr).into_client_request().unwrap();
    request.headers_mut().insert("origin", origin.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket.send(Message::Text(json!({ "t": "hello", "protocol": 1, "role": role, "code": code }).to_string().into())).await.unwrap();
    match socket.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("unexpected {other:?}"),
    }
}

/// One request with an `Origin`, as a page in a browser on this computer sends it: its status.
async fn status_from(host: &RunningHost, origin: &str, method: &str, path: &str) -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(host.addr).await.unwrap();
    let head = format!("{method} {path} HTTP/1.0\r\nHost: {}\r\nOrigin: {origin}\r\nContent-Length: 0\r\n\r\n", host.addr);
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8_lossy(&response[9..12]).parse().unwrap()
}

/// #504: the table, the screens and the controller are MR Studio's own windows. A page from
/// another site, open in a browser on this computer, is at most a phone, and changes nothing over HTTP.
#[tokio::test(flavor = "multi_thread")]
async fn only_this_computers_own_windows_are_screens_or_make_changes() {
    let host = host().await;
    let code = host.state.hub.session().code.clone();
    let own = format!("http://{}", host.addr);
    let other = "http://elsewhere.example";

    for role in ["dev", "tv", "table"] {
        let refused = hello_from(&host, other, role, None).await;
        assert_eq!(refused["t"], "refused", "{role}");
        assert!(refused["e"].as_str().unwrap().contains("own computer"), "{refused}");
        assert_eq!(hello_from(&host, &own, role, None).await["t"], "welcome", "{role}");
    }
    // A visitor's page is still welcome as a phone, with the code.
    assert_eq!(hello_from(&host, other, "phone", Some(&code)).await["t"], "welcome");

    // The same page cannot move the table, add to it or replace its pictures.
    for (method, path) in [
        ("POST", "/api/site/place"),
        ("POST", "/api/data/import?target=buildings"),
        ("POST", "/api/data/osm?targets=buildings"),
        ("POST", "/api/data/media"),
        ("POST", "/api/data/sounds"),
        ("POST", "/api/data/model"),
        ("POST", "/api/site/thumbnail"),
        ("PUT", "/api/layers/sunlight/view"),
    ] {
        assert_eq!(status_from(&host, other, method, path).await, 403, "{method} {path}");
    }
    // MR Studio's own page gets past the guard (this request writes nothing, and its empty body is turned down).
    assert_ne!(status_from(&host, &own, "POST", "/api/data/inspect?target=buildings").await, 403);
    // It may read what a phone may.
    assert_eq!(status_from(&host, other, "GET", "/api/info").await, 200);
    host.shutdown().await;
}

/// #504: a join code cannot be found by trying them all.
#[tokio::test(flavor = "multi_thread")]
async fn wrong_codes_run_out() {
    let host = host().await;
    let code = host.state.hub.session().code.clone();
    let wrong = if code == "0000" { "0001" } else { "0000" };
    for _ in 0..60 {
        assert_eq!(Surface::join(&host, "phone", Some(wrong)).await.err().unwrap(), "wrong session code");
    }
    let refused = Surface::join(&host, "phone", Some(&code)).await.err().unwrap();
    assert!(refused.contains("too many wrong codes"), "{refused}");
    assert!(Surface::join(&host, "guide", Some("000000")).await.err().unwrap().contains("too many wrong codes"));
    // The operator's own windows are not held up.
    assert!(Surface::join(&host, "tv", None).await.is_ok());
    host.shutdown().await;
}

/// #507: a request that fails inside the host, with the hub's lock held, costs that request
/// only. The table answers the next one, new windows join, and the operator log hears of it.
#[tokio::test(flavor = "multi_thread")]
async fn a_request_that_fails_inside_the_host_does_not_stop_the_table() {
    let host = host().await;
    let mut tv = Surface::join(&host, "tv", None).await.unwrap();
    host.state.hub.inject_fault();
    let refused = tv.request("layer.activate", json!({ "layer": "sunlight", "active": true })).await.unwrap_err();
    assert!(refused.contains("could not be handled"), "{refused}");

    // The same surface, and a new one, are answered as before.
    tv.request("layer.activate", json!({ "layer": "sunlight", "active": true })).await.unwrap();
    let mut table = Surface::join(&host, "table", None).await.unwrap();
    assert_eq!(table.welcome["state"]["layers"]["sunlight"]["active"], true);
    table.request("layer.activate", json!({ "layer": "sunlight", "active": false })).await.unwrap();
    assert!(!http_get(&host, "/api/diagnostics").await.is_empty());

    let (incidents, _) = host.state.health.incidents_after(0);
    assert!(incidents.iter().any(|(_, message)| message.contains("layer.activate")), "{incidents:?}");
    host.shutdown().await;
}

/// #512: Undo after bringing in buildings puts the earlier buildings back on the table, since
/// the import saved the new ones beside them and never over them.
#[tokio::test(flavor = "multi_thread")]
async fn undo_after_an_import_brings_the_earlier_data_back() {
    let site = scratch_site("import-undo");
    let original = std::fs::read(site.join("data/buildings.geojson")).unwrap();
    let host = host_for(site.clone()).await;
    let mut editor = Surface::join(&host, "dev", None).await.unwrap();
    let buildings_path = |site: &std::path::Path| {
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(site.join("site.json")).unwrap()).unwrap();
        saved["scene"]["buildings"]["path"].as_str().unwrap().to_string()
    };

    let one = json!({ "type": "FeatureCollection", "features": [{ "type": "Feature", "properties": { "height": 9 }, "geometry": {
        "type": "Polygon", "coordinates": [[[11.969, 57.70], [11.9694, 57.70], [11.9694, 57.7002], [11.969, 57.7002], [11.969, 57.70]]] } }] });
    let (status, report) = http_post(&host, "/api/data/import?target=buildings", "mine.geojson", one.to_string().as_bytes()).await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["path"], "data/buildings.v2.geojson");
    editor.event("site.changed").await;
    assert_eq!(buildings_path(&site), "data/buildings.v2.geojson");
    assert_eq!(std::fs::read(site.join("data/buildings.geojson")).unwrap(), original, "the earlier buildings are still there");

    editor.request("history.undo", json!({})).await.unwrap();
    assert_eq!(buildings_path(&site), "data/buildings.geojson");
    editor.request("history.redo", json!({})).await.unwrap();
    assert_eq!(buildings_path(&site), "data/buildings.v2.geojson");
    // A table that was changed says which MR Studio changed it (#509).
    assert_eq!(mrs_site::version::made_with(&site).as_deref(), Some(mrs_site::version::THIS));
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&site);
}
