//! `GET /api/transit/<source>/vehicles?bbox=w,s,e,n`: live vehicles from a transit provider,
//! in the shape the Public transport layer reads (`packages/layers/transit/README.md`). The
//! host signs the request with the source's key (see `sources.rs`), so the table never
//! holds it. Västtrafik is the first provider; others get their own `vehicles_*` here.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::sources::{Kind, Refusal, Sources};

/// The layer polls every few seconds; a provider is asked at most this often per box.
const REUSE: Duration = Duration::from_secs(3);

#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, (Instant, Value)>>);

pub async fn vehicles(sources: &Sources, cache: &Cache, id: &str, bbox: &str) -> Result<Value, Refusal> {
    let numbers: Vec<f64> =
        bbox.split(',').map(|v| v.trim().parse::<f64>()).collect::<Result<_, _>>().map_err(|_| refusal("bbox must be four numbers"))?;
    let [w, s, e, n] = numbers[..] else { return Err(refusal("bbox must be four numbers")) };
    if !(w < e && s < n && e - w < 2.0 && n - s < 2.0) {
        return Err(refusal("bbox must be minLon,minLat,maxLon,maxLat around one table"));
    }
    let key = format!("{id} {bbox}");
    if let Some((at, value)) = cache.0.lock().get(&key) {
        if at.elapsed() < REUSE {
            return Ok(value.clone());
        }
    }
    let connection = sources.connection(id).ok_or_else(|| Refusal { status: 404, message: format!("there is no source called '{id}'") })?;
    let value = match connection.kind {
        Kind::Vasttrafik => {
            let mut url = reqwest::Url::parse(&format!("{}/pr/v4/positions", connection.url.trim_end_matches('/')))
                .map_err(|e| refusal(&e.to_string()))?;
            url.query_pairs_mut()
                .append_pair("lowerLeftLat", &s.to_string())
                .append_pair("lowerLeftLong", &w.to_string())
                .append_pair("upperRightLat", &n.to_string())
                .append_pair("upperRightLong", &e.to_string())
                .append_pair("limit", "200");
            let answer = sources.fetch(id, url).await?;
            let body: Value = answer
                .json()
                .await
                .map_err(|_| Refusal { status: 502, message: "Västtrafik answered in a way this version does not read".into() })?;
            vasttrafik(&body)
        }
        _ => return Err(refusal(&format!("{} is not a transit provider", connection.name))),
    };
    cache.0.lock().insert(key, (Instant::now(), value.clone()));
    Ok(value)
}

fn refusal(message: &str) -> Refusal {
    Refusal { status: 400, message: message.into() }
}

/// Västtrafik Planera Resa v4 `positions`: a list of journeys with a position and a line.
pub fn vasttrafik(body: &Value) -> Value {
    let list = body.as_array().or_else(|| body["results"].as_array()).map(Vec::as_slice).unwrap_or(&[]);
    let vehicles: Vec<Value> = list
        .iter()
        .filter_map(|j| {
            let lat = j["latitude"].as_f64()?;
            let lon = j["longitude"].as_f64()?;
            let id = j["detailsReference"]
                .as_str()
                .or(j["journeyGid"].as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{lon:.5},{lat:.5}"));
            let line = &j["line"];
            let mode = match line["transportMode"].as_str().unwrap_or("bus").to_ascii_lowercase().as_str() {
                "tram" => "tram",
                "train" => "train",
                "ferry" | "boat" => "ferry",
                _ => "bus",
            };
            // The short name is what Västtrafik prints on the vehicle ("6", "X4"); the name can be long ("Rosa Express").
            let label = ["shortName", "designation", "name"].iter().find_map(|k| line[*k].as_str().filter(|s| !s.is_empty())).unwrap_or("");
            let mut vehicle = json!({ "id": id, "lon": lon, "lat": lat, "mode": mode, "line": label });
            if let Some(colour) = line["backgroundColor"].as_str().filter(|c| c.len() == 7 && c.starts_with('#')) {
                vehicle["colour"] = colour.into();
            }
            if let Some(colour) = line["foregroundColor"].as_str().filter(|c| c.len() == 7 && c.starts_with('#')) {
                vehicle["textColour"] = colour.into();
            }
            Some(vehicle)
        })
        .collect();
    json!({ "vehicles": vehicles })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vasttrafik_positions_become_vehicles() {
        let body = json!([
            { "detailsReference": "abc", "latitude": 57.70, "longitude": 11.97,
              "line": { "name": "6", "backgroundColor": "#ffd700", "foregroundColor": "#000000", "transportMode": "tram" } },
            { "latitude": 57.71, "longitude": 11.95, "line": { "name": "Älvsnabben", "shortName": "286", "transportMode": "ferry" } },
            { "detailsReference": "no position" }
        ]);
        let vehicles = vasttrafik(&body)["vehicles"].as_array().unwrap().clone();
        assert_eq!(vehicles.len(), 2);
        assert_eq!(
            vehicles[0],
            json!({ "id": "abc", "lon": 11.97, "lat": 57.70, "mode": "tram", "line": "6", "colour": "#ffd700", "textColour": "#000000" })
        );
        assert_eq!(vehicles[1]["mode"], "ferry");
        assert_eq!(vehicles[1]["line"], "286");
    }
}
