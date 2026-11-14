//! The host over a real WebSocket: joining, authority over layer state, roles, and field streaming.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mrs_engine::Backend;
use mrs_host::{HostConfig, RunningHost};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

async fn host() -> RunningHost {
    host_for(repo().join("sites/sample")).await
}

/// A private copy of the sample site, for tests that edit the scene (the host rewrites site.json).
fn scratch_site(name: &str) -> PathBuf {
    fn copy(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
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

async fn host_for(site_dir: PathBuf) -> RunningHost {
    mrs_host::start(HostConfig {
        site_dir,
        layers_dir: repo().join("packages/layers"),
        web_dir: None,
        bind: "127.0.0.1:0".parse().unwrap(),
        // The CPU reference keeps these tests independent of the machine's GPU.
        backend: Backend::Cpu,
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
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/ws", host.addr)).await.unwrap();
        let hello = json!({ "t": "hello", "protocol": 1, "role": role, "code": code });
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
    assert_eq!(sunlight["layer"], "sunlight");
    assert_eq!(sunlight["active"], false);
    assert_eq!(sunlight["params"]["hour"], 15.0);
    assert_eq!(sunlight["params"]["mode"], "instant");
    // The scene is site.json's list, bottom first, and the base map is on.
    let scene: Vec<&str> = state["scene"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
    assert_eq!(scene, ["basemap", "sunlight", "building-lights", "cars", "transit", "trees", "slideshow"]);
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

    // `hour` is marked phone: true, `mode` is not.
    phone.request("layer.set", json!({ "layer": "sunlight", "params": { "hour": 7 } })).await.unwrap();
    assert!(phone.request("layer.set", json!({ "layer": "sunlight", "params": { "mode": "day" } })).await.is_err());
    assert!(phone.request("layer.activate", json!({ "layer": "sunlight", "active": false })).await.is_err());
    assert!(phone.request("engine.open", json!({ "kernel": "sunlight", "params": {}, "fields": ["shadow"] })).await.is_err());

    // Leaving frees the slot.
    drop(phone);
    assert_eq!(tv.event("state.participants").await["participants"].as_array().unwrap().len(), 0);

    // The ninth phone is turned away.
    let mut phones = Vec::new();
    for _ in 0..8 {
        phones.push(Surface::join(&host, "phone", Some(&code)).await.unwrap());
    }
    assert_eq!(Surface::join(&host, "phone", Some(&code)).await.err().unwrap(), "session full");
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
    assert_eq!(trees, json!({ "use": "trees", "active": false, "params": { "size": 3.0 } }));
    let live_only = saved_layers(&site).into_iter().find(|l| l["id"] == "cars-2").unwrap();
    assert_eq!(live_only["params"], json!({ "density": 30.0 }), "layer.set is not written to site.json");

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
