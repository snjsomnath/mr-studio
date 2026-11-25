//! Phones joining through the join page (#275): a studio surface opens `/api/phones/bridge`
//! and carries phones' traffic in as the relay protocol's frames. Here the test plays that
//! surface, and checks the QR code and the same rules as the relay.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use mrs_engine::Backend;
use mrs_host::{HostConfig, SessionOptions};
use mrs_relay::protocol::{self, OpenHead, RequestHead, ResponseHead};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const PAGE: &str = "https://example.test/mr-studio/v1/";

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

async fn host(join_page: Option<&str>) -> mrs_host::RunningHost {
    mrs_host::start(HostConfig {
        site_dir: repo().join("sites/sample"),
        layers_dir: repo().join("packages/layers"),
        web_dir: None,
        bind: "127.0.0.1:0".parse().unwrap(),
        backend: Backend::Cpu,
        session: SessionOptions { join_page: join_page.map(String::from), peer_options: None, ..SessionOptions::default() },
        sources: std::sync::Arc::new(mrs_host::Sources::in_memory()),
    })
    .await
    .unwrap()
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn bridge(host: &mrs_host::RunningHost) -> (Socket, Value) {
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{}/api/phones/bridge", host.addr)).await.unwrap();
    let first = next_text(&mut socket).await;
    (socket, first)
}

async fn next_text(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(20), socket.next()).await.expect("no answer") {
            Some(Ok(Message::Text(text))) => return serde_json::from_str(&text).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("the socket closed: {other:?}"),
        }
    }
}

/// The next binary frame: (kind, stream, payload).
async fn next_frame(socket: &mut Socket) -> (u8, u32, Vec<u8>) {
    loop {
        match tokio::time::timeout(Duration::from_secs(20), socket.next()).await.expect("no frame") {
            Some(Ok(Message::Binary(bytes))) => {
                let (kind, stream, payload) = protocol::parse(&bytes).unwrap();
                return (kind, stream, payload.to_vec());
            }
            Some(Ok(_)) => continue,
            other => panic!("the socket closed: {other:?}"),
        }
    }
}

async fn get(socket: &mut Socket, stream: u32, method: &str, path: &str) -> u16 {
    let head = RequestHead { method: method.into(), path: path.into(), headers: vec![] };
    socket.send(Message::Binary(protocol::with_head(protocol::HTTP_REQUEST, stream, &head, &[]).into())).await.unwrap();
    let (kind, back, payload) = next_frame(socket).await;
    assert_eq!((kind, back), (protocol::HTTP_RESPONSE, stream));
    protocol::split_head::<ResponseHead>(&payload).unwrap().0.status
}

#[tokio::test]
async fn a_phone_joins_through_the_join_page_and_nothing_else_gets_in() {
    let host = host(Some(PAGE)).await;
    let code = host.state.hub.session().code;
    assert!(host.state.hub.session().join_url.is_none(), "a host on this computer only has no address for phones");

    let (mut socket, first) = bridge(&host).await;
    let id = first["id"].as_str().unwrap().to_string();
    assert_eq!(first, json!({ "t": "bridge", "page": PAGE, "peer": null, "id": id }));

    // Only one surface carries phones at a time; the one carrying them hears that another waits (#422).
    let (_, second) = bridge(&host).await;
    assert_eq!(second["t"], "busy");
    let waiting = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(message)) = socket.next().await {
            if let Message::Text(text) = message {
                return serde_json::from_str::<Value>(&text).unwrap();
            }
        }
        Value::Null
    })
    .await
    .unwrap();
    assert_eq!(waiting, json!({ "t": "waiting" }));

    // Once the bridge's peer is up, the QR code points at the join page.
    socket.send(Message::Text(json!({ "t": "peer", "id": "mrs-abcdefgh2345" }).to_string().into())).await.unwrap();
    let mut url = None;
    for _ in 0..100 {
        url = host.state.hub.session().join_url;
        if url.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(url.as_deref(), Some(format!("{PAGE}?t=mrs-abcdefgh2345#/phone?c={code}").as_str()));
    let guide = host.state.hub.guide();
    assert!(guide["url"].as_str().unwrap().starts_with(&format!("{PAGE}?t=mrs-abcdefgh2345#/guide?g=")));

    // Phones read; they cannot use what only this computer may, nor write.
    assert_eq!(get(&mut socket, 1, "GET", "/api/info").await, 200);
    assert_eq!(get(&mut socket, 2, "GET", "/api/sources").await, 403);
    assert_eq!(get(&mut socket, 3, "POST", "/api/site/place").await, 405);

    // A socket must start as a phone.
    let open = serde_json::to_vec(&OpenHead { path: "/ws".into() }).unwrap();
    socket.send(Message::Binary(protocol::frame(protocol::WS_OPEN, 4, &open).into())).await.unwrap();
    let hello = json!({ "t": "hello", "protocol": 1, "role": "tv" }).to_string();
    socket.send(Message::Binary(protocol::frame(protocol::WS_TEXT, 4, hello.as_bytes()).into())).await.unwrap();
    let (kind, stream, payload) = next_frame(&mut socket).await;
    assert_eq!((kind, stream), (protocol::WS_TEXT, 4));
    assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap()["t"], "refused");

    // A phone with the code gets a seat.
    socket.send(Message::Binary(protocol::frame(protocol::WS_OPEN, 5, &open).into())).await.unwrap();
    let hello = json!({ "t": "hello", "protocol": 1, "role": "phone", "code": code }).to_string();
    socket.send(Message::Binary(protocol::frame(protocol::WS_TEXT, 5, hello.as_bytes()).into())).await.unwrap();
    loop {
        let (kind, stream, payload) = next_frame(&mut socket).await;
        if (kind, stream) == (protocol::WS_TEXT, 5) {
            assert_eq!(serde_json::from_slice::<Value>(&payload).unwrap()["t"], "welcome");
            break;
        }
    }

    // The bridge goes: the QR code no longer points at it.
    drop(socket);
    let mut gone = false;
    for _ in 0..100 {
        if host.state.hub.session().join_url.is_none() {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(gone, "the join link outlived its bridge");

    // The next surface to carry phones takes the same peer, so joined phones find it again (#422).
    let (_, next) = bridge(&host).await;
    assert_eq!((next["t"].as_str(), next["id"].as_str()), (Some("bridge"), Some(id.as_str())));
}

#[tokio::test]
async fn the_join_page_can_be_turned_off() {
    let host = host(None).await;
    let (_, first) = bridge(&host).await;
    assert_eq!(first, json!({ "t": "off" }));
}
