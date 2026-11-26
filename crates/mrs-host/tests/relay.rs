//! Phones joining through the relay (#89): a relay and a host in one process, the host linked
//! out to the relay, and a phone that only knows the relay's address.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mrs_engine::Backend;
use mrs_host::relay::RelayLink;
use mrs_host::{HostConfig, SessionOptions};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "a-token-for-the-relay-tests";

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

async fn relay() -> String {
    let relay = mrs_relay::Relay::new(mrs_relay::Config { tokens: vec![TOKEN.into()], secure_cookies: false });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, mrs_relay::router(relay)).await.unwrap() });
    format!("http://{addr}")
}

async fn host() -> mrs_host::RunningHost {
    mrs_host::start(HostConfig {
        site_dir: repo().join("sites/sample"),
        layers_dir: repo().join("packages/layers"),
        web_dir: None,
        bind: "127.0.0.1:0".parse().unwrap(),
        backend: Backend::Cpu,
        session: SessionOptions::default(),
        sources: std::sync::Arc::new(mrs_host::Sources::in_memory()),
        programs: true,
    })
    .await
    .unwrap()
}

/// Waits until the host's QR code points at the relay.
async fn join_url(host: &mrs_host::RunningHost, relay: &str) -> String {
    for _ in 0..100 {
        if let Some(url) = host.state.hub.session().join_url.filter(|u| u.starts_with(relay)) {
            return url;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the host never linked to the relay");
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

async fn socket(relay: &str, cookie: &str, hello: Value) -> Value {
    let mut request = format!("{}/ws", relay.replacen("http://", "ws://", 1)).into_client_request().unwrap();
    request.headers_mut().insert("cookie", cookie.parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket.send(Message::Text(hello.to_string().into())).await.unwrap();
    loop {
        match tokio::time::timeout(Duration::from_secs(20), socket.next()).await.expect("no answer through the relay") {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("the socket closed: {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_phone_joins_through_the_relay_and_nothing_else_gets_in() {
    let relay = relay().await;
    let host = host().await;

    // A host without the token is turned away.
    host.connect_relay(RelayLink { url: relay.clone(), authorization: "Bearer wrong-token-wrong-token".into() });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(host.state.hub.session().join_url.is_none_or(|u| !u.starts_with(&relay)));

    host.connect_relay(RelayLink { url: relay.clone(), authorization: format!("Bearer {TOKEN}") });
    let join = join_url(&host, &relay).await;
    let code = host.state.hub.session().code;
    assert!(join.ends_with(&format!("/phone?c={code}")), "{join}");

    // The room link sets the room and sends the phone on to the phone page.
    let http = client();
    let entered = http.get(&join).send().await.unwrap();
    assert_eq!(entered.status(), 302);
    assert_eq!(entered.headers()["location"], format!("/phone?c={code}"));
    let cookie = entered.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    assert!(cookie.starts_with("mrs_room="));

    let page = http.get(format!("{relay}/phone?c={code}")).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(page.status(), 200);
    // The same page the host serves on its own network.
    let direct = http.get(format!("http://{}/phone?c={code}", host.addr)).send().await.unwrap();
    assert_eq!(page.text().await.unwrap(), direct.text().await.unwrap());

    // What only this computer may ask for is refused, and nothing but reading passes.
    let sources = http.get(format!("{relay}/api/sources")).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(sources.status(), 403);
    let post = http.post(format!("{relay}/api/sources")).header("cookie", &cookie).send().await.unwrap();
    assert_eq!(post.status(), 405);
    let lost = http.get(format!("{relay}/phone")).send().await.unwrap();
    assert_eq!(lost.status(), 404);

    // Only phones join through the relay, and only with the session code.
    let table = socket(&relay, &cookie, json!({ "t": "hello", "protocol": 1, "role": "table" })).await;
    assert_eq!(table["t"], "refused");
    let wrong = socket(&relay, &cookie, json!({ "t": "hello", "protocol": 1, "role": "phone", "code": "nope" })).await;
    assert_eq!(wrong["t"], "refused");
    let phone = socket(&relay, &cookie, json!({ "t": "hello", "protocol": 1, "role": "phone", "code": code })).await;
    assert_eq!(phone["t"], "welcome", "{phone}");

    host.shutdown().await;
}
