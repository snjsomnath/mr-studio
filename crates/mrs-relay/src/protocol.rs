//! The frames between a host and the relay, over one WebSocket the host opens (#89).
//!
//! Every frame is binary: one byte for the kind, four for the stream (big endian), then the
//! payload. A stream is one phone request or one phone WebSocket. HTTP heads are JSON,
//! followed by a zero byte and the body; JSON never holds a raw zero byte, so the first one
//! ends the head.

use serde::{Deserialize, Serialize};

pub const HTTP_REQUEST: u8 = 1;
pub const HTTP_RESPONSE: u8 = 2;
pub const WS_OPEN: u8 = 3;
pub const WS_TEXT: u8 = 4;
pub const WS_BINARY: u8 = 5;
pub const WS_CLOSE: u8 = 6;

/// The largest response the relay passes on. Phones load pages, layer code and site data.
pub const MAX_BODY: usize = 64 * 1024 * 1024;

/// A phone's HTTP request, relay to host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestHead {
    pub method: String,
    /// Path and query, as the phone asked: `/phone?c=1234`.
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// The host's answer, host to relay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseHead {
    pub status: u16,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// A phone opens a WebSocket, relay to host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenHead {
    pub path: String,
}

pub fn frame(kind: u8, stream: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&stream.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// A head and a body in one frame.
pub fn with_head(kind: u8, stream: u32, head: &impl Serialize, body: &[u8]) -> Vec<u8> {
    let mut payload = serde_json::to_vec(head).expect("a head is JSON");
    payload.push(0);
    payload.extend_from_slice(body);
    frame(kind, stream, &payload)
}

/// `(kind, stream, payload)`, or None for a frame too short to be one.
pub fn parse(bytes: &[u8]) -> Option<(u8, u32, &[u8])> {
    if bytes.len() < 5 {
        return None;
    }
    Some((bytes[0], u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]), &bytes[5..]))
}

/// Splits a payload into its JSON head and body.
pub fn split_head<T: for<'de> Deserialize<'de>>(payload: &[u8]) -> Option<(T, &[u8])> {
    let end = payload.iter().position(|b| *b == 0)?;
    Some((serde_json::from_slice(&payload[..end]).ok()?, &payload[end + 1..]))
}

/// A room name: what the host asks for and phones' links carry. Lowercase letters and digits.
pub fn valid_room(room: &str) -> bool {
    (6..=32).contains(&room.len()) && room.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_goes_through_a_frame_and_back() {
        let head = RequestHead { method: "GET".into(), path: "/phone?c=1234".into(), headers: vec![("accept".into(), "text/html".into())] };
        let bytes = with_head(HTTP_REQUEST, 7, &head, b"\0body\0");
        let (kind, stream, payload) = parse(&bytes).unwrap();
        assert_eq!((kind, stream), (HTTP_REQUEST, 7));
        let (back, body) = split_head::<RequestHead>(payload).unwrap();
        assert_eq!(back, head);
        assert_eq!(body, b"\0body\0");
        assert!(parse(&[1, 0, 0]).is_none());
        assert!(valid_room("a1b2c3d4") && !valid_room("ABCDEF12") && !valid_room("abc") && !valid_room("../etc/x"));
    }
}
