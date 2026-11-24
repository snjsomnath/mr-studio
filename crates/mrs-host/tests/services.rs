//! Outside compute (#278): the host starts a site's service, forwards to it, keeps its answers,
//! gives the kept answer when the service is gone, and starts it again after a crash.

use std::path::PathBuf;
use std::time::Duration;

use mrs_engine::Backend;
use mrs_host::{HostConfig, RunningHost};
use serde_json::{json, Value};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// A service that answers `/health`, echoes a POST to `/sum` as the sum of its numbers, and
/// exits when asked to `/crash`.
const SERVER: &str = r#"
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): print("request", self.path, flush=True)
    def send(self, code, value):
        body = json.dumps(value).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/health": self.send(200, {"ok": True})
        elif self.path == "/crash": os._exit(3)
        else: self.send(200, {"path": self.path, "mode": os.environ.get("MODE")})
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/job":
            import uuid
            return self.send(202, {"job": uuid.uuid4().hex})
        self.send(200, {"sum": sum(data["numbers"])})
from http.server import ThreadingHTTPServer
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
"#;

fn site_with_service(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mrs-services-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    copy(&repo().join("sites/sample"), &dir);
    std::fs::create_dir_all(dir.join("services/adder")).unwrap();
    std::fs::write(dir.join("services/adder/server.py"), SERVER).unwrap();
    let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("site.json")).unwrap()).unwrap();
    let python = if cfg!(windows) { "python" } else { "python3" };
    manifest["services"] = json!([{
        "id": "adder", "name": "Adder", "health": "/health",
        "run": { "cwd": "services/adder", "command": [python, "server.py", "{port}"], "env": { "MODE": "test-{port}" } }
    }]);
    std::fs::write(dir.join("site.json"), serde_json::to_string_pretty(&manifest).unwrap()).unwrap();
    dir
}

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

async fn start(site_dir: PathBuf) -> RunningHost {
    mrs_host::start(HostConfig {
        site_dir,
        layers_dir: repo().join("packages/layers"),
        web_dir: None,
        bind: "127.0.0.1:0".parse().unwrap(),
        backend: Backend::Cpu,
        session: Default::default(),
        sources: std::sync::Arc::new(mrs_host::Sources::in_memory()),
    })
    .await
    .unwrap()
}

async fn state_of(base: &str) -> String {
    let page: Value = reqwest::get(format!("{base}/api/services")).await.unwrap().json().await.unwrap();
    page["services"][0]["state"].as_str().unwrap_or_default().to_string()
}

async fn until(base: &str, wanted: &str) {
    for _ in 0..600 {
        if state_of(base).await == wanted {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the service never became {wanted}; it is {}", state_of(base).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_site_service_is_started_forwarded_kept_and_restarted() {
    let dir = site_with_service("adder");
    let host = start(dir.clone()).await;
    let base = format!("http://{}", host.addr);
    until(&base, "up").await;
    let client = reqwest::Client::new();

    // Forwarded, any method, with the body and the query; the port reached the environment.
    let sum: Value = client
        .post(format!("{base}/api/services/adder/call/sum"))
        .json(&json!({ "numbers": [1, 2, 3.5] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sum["sum"], 6.5);
    let echoed: Value =
        client.get(format!("{base}/api/services/adder/call/scenario?year=2022")).send().await.unwrap().json().await.unwrap();
    assert_eq!(echoed["path"], "/scenario?year=2022");
    assert!(echoed["mode"].as_str().unwrap().starts_with("test-"));
    let unknown = client.get(format!("{base}/api/services/nobody/call/x")).send().await.unwrap();
    assert_eq!(unknown.status(), 404);

    // The projector and the editor both run the layer, so the same job request comes twice at
    // once: it is started once, and both get its id.
    let ask = || client.post(format!("{base}/api/services/adder/call/job")).json(&json!({ "days": 2 })).send();
    let (a, b) = tokio::join!(ask(), ask());
    let (a, b): (Value, Value) = (a.unwrap().json().await.unwrap(), b.unwrap().json().await.unwrap());
    assert_eq!(a["job"], b["job"]);
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let c: Value = ask().await.unwrap().json().await.unwrap();
    assert_ne!(a["job"], c["job"], "a later request is a new one");

    // A layer keeps a value of its own, such as a finished job.
    let kept = client.put(format!("{base}/api/services/adder/kept?key=year-2022")).body(r#"{"saving":12}"#).send().await.unwrap();
    assert_eq!(kept.status(), 204);

    // It crashes: the host says so and starts it again; meanwhile the kept answer stands in.
    let _ = client.get(format!("{base}/api/services/adder/call/crash")).send().await;
    let mut down = false;
    for _ in 0..50 {
        let answer =
            client.post(format!("{base}/api/services/adder/call/sum")).json(&json!({ "numbers": [1, 2, 3.5] })).send().await.unwrap();
        if answer.headers().contains_key("x-mrs-cached") {
            assert_eq!(answer.json::<Value>().await.unwrap()["sum"], 6.5);
            down = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(down, "a kept answer stands in while the service is down");
    // A request never asked before has nothing kept.
    let page: Value = reqwest::get(format!("{base}/api/services")).await.unwrap().json().await.unwrap();
    if page["services"][0]["state"] != "up" {
        let fresh = client.post(format!("{base}/api/services/adder/call/sum")).json(&json!({ "numbers": [9] })).send().await.unwrap();
        assert_eq!(fresh.status(), 503);
    }
    until(&base, "up").await;
    let page: Value = reqwest::get(format!("{base}/api/services")).await.unwrap().json().await.unwrap();
    assert_eq!(page["services"][0]["restarts"], 1);
    let log: Value = reqwest::get(format!("{base}/api/services/adder/log")).await.unwrap().json().await.unwrap();
    assert!(log["lines"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("/sum")));

    // What was kept is in the site's hidden folder, which an export leaves out.
    let kept: Value = reqwest::get(format!("{base}/api/services/adder/kept?key=year-2022")).await.unwrap().json().await.unwrap();
    assert_eq!(kept["saving"], 12);
    assert!(dir.join(mrs_host::services::CACHE_DIR).join("adder").is_dir());

    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn bad_service_entries_are_reported() {
    let mut site = mrs_site::Site::load(repo().join("sites/sample")).unwrap();
    let service = |value: Value| serde_json::from_value::<mrs_site::Service>(value).unwrap();
    site.manifest.services = vec![
        service(json!({ "id": "a", "url": "ftp://x" })),
        service(json!({ "id": "a", "url": "https://x", "run": { "cwd": "data", "command": ["x"] } })),
        service(json!({ "id": "b", "run": { "cwd": "../elsewhere", "command": [] } })),
        service(json!({ "id": "c", "run": { "cwd": "data", "command": ["python", "x.py"], "venv": "../../venv" }, "health": "ok" })),
    ];
    let problems = site.problems().join("\n");
    for expected in [
        "services.a.url",
        "another service has this id",
        "give either run or url",
        "leaves the site folder",
        "name the program",
        "stays inside",
        "services.c.health",
    ] {
        assert!(problems.contains(expected), "missing '{expected}' in:\n{problems}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_service_with_a_venv_gets_one_made_and_runs_in_it() {
    let dir = site_with_service("venv");
    let mut manifest: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("site.json")).unwrap()).unwrap();
    manifest["services"][0]["run"]["venv"] = json!(".venv");
    manifest["services"][0]["run"]["command"] = json!(["{python}", "server.py", "{port}"]);
    std::fs::write(dir.join("site.json"), manifest.to_string()).unwrap();
    let host = start(dir.clone()).await;
    let base = format!("http://{}", host.addr);
    until(&base, "up").await;
    assert!(dir.join("services/adder/.venv").is_dir());
    host.shutdown().await;
    let _ = std::fs::remove_dir_all(&dir);
}
