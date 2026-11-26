//! `POST /api/data/model`: brings a 3D model of the site into the scene, places it again, or
//! takes it out (`mrs_site::model`), then re-bakes and tells every surface.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use mrs_site::model::{self, ModelPlacement};
use mrs_site::{LonLat, Site, Up};
use serde_json::json;

use crate::AppState;

/// The placement, in the query string; the file, if any, is the body.
#[derive(serde::Deserialize)]
pub struct ModelQuery {
    #[serde(default)]
    lon: Option<f64>,
    #[serde(default)]
    lat: Option<f64>,
    #[serde(default)]
    unit_m: Option<f64>,
    #[serde(default)]
    bearing_deg: f64,
    #[serde(default)]
    base_m: f64,
    /// `z` (default) or `y`.
    #[serde(default)]
    up: Option<String>,
    #[serde(default)]
    mirror: Option<String>,
    /// `0` when the model gives the buildings their shape, `1` to raise the footprints too.
    #[serde(default)]
    extrude: Option<String>,
    /// The point of the file taken as its origin, for a model in map coordinates.
    #[serde(default)]
    offset_x: Option<f64>,
    #[serde(default)]
    offset_y: Option<f64>,
    /// `1` takes the model out of the scene.
    #[serde(default)]
    remove: Option<String>,
}

fn flag(value: &Option<String>) -> Option<bool> {
    value.as_deref().map(|v| v == "1" || v == "true")
}

impl AppState {
    /// Saves or re-places the model (`file` is its name and bytes), or removes it, and re-bakes.
    pub async fn place_model(
        &self,
        file: Option<(String, Vec<u8>)>,
        placement: Option<ModelPlacement>,
    ) -> Result<serde_json::Value, String> {
        let _one = self.imports.lock().await;
        let dir = self.site.dir.clone();
        let rebuilt = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let site = Site::load(&dir).map_err(|e| e.to_string())?;
            let (site, triangles) = match &placement {
                Some(placement) => model::place(&site, file.as_ref().map(|(name, bytes)| (name.as_str(), bytes.as_slice())), placement)
                    .map_err(|e| e.to_string())?,
                None => (model::remove(&site).map_err(|e| e.to_string())?, 0),
            };
            let (scene, stats) = site.bake().map_err(|e| format!("the model was saved, but the scene could not be rebuilt: {e}"))?;
            tracing::info!(
                "re-baked with a model of {} triangles covering {:.0}% of the table",
                stats.mesh_triangles,
                stats.mesh_coverage * 100.0
            );
            let twin = Bytes::from(site.twin(&scene).map_err(|e| e.to_string())?.encode());
            Ok((scene, twin, site.info(), triangles, stats.mesh_coverage))
        })
        .await
        .map_err(|e| e.to_string())?;
        let (scene, twin, info, triangles, coverage) = rebuilt?;
        self.engine.load_scene(scene).await?;
        *self.twin.write() = twin;
        self.hub.site_changed(info.clone());
        Ok(json!({ "site": info, "triangles": triangles, "coverage": coverage }))
    }
}

/// `POST /api/data/model?lon=&lat=&unit_m=[&bearing_deg=][&base_m=][&up=y][&mirror=1][&extrude=0]`,
/// with the file as the body (and its name in `X-Filename`), or no body to place the model the
/// table has again. `?remove=1` takes it out.
pub async fn post(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Query(query): Query<ModelQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    if !from.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "the model can only be changed from this computer" }))).into_response();
    }
    let refuse = |error: String| (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    let placement = if flag(&query.remove) == Some(true) {
        None
    } else {
        let (Some(lon), Some(lat), Some(unit_m)) = (query.lon, query.lat, query.unit_m) else {
            return refuse("lon, lat and unit_m place the model".into());
        };
        let up = match query.up.as_deref() {
            None | Some("") | Some("z") => Up::Z,
            Some("y") => Up::Y,
            Some(other) => return refuse(format!("up is z or y, not '{other}'")),
        };
        Some(ModelPlacement {
            anchor: LonLat { lon, lat },
            unit_m,
            bearing_deg: query.bearing_deg,
            base_m: query.base_m,
            up,
            mirror: flag(&query.mirror).unwrap_or(false),
            offset: query.offset_x.zip(query.offset_y).map(|(x, y)| [x, y]),
            extrude: flag(&query.extrude),
        })
    };
    let file = (!body.is_empty()).then(|| {
        // Only the extension is used, so a name sent encodeURIComponent-ed needs no decoding.
        let name = headers.get("x-filename").and_then(|v| v.to_str().ok()).unwrap_or("model.stl");
        (name.to_string(), body.to_vec())
    });
    match state.place_model(file, placement).await {
        Ok(answer) => Json(answer).into_response(),
        Err(error) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": error }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub struct LocateQuery {
    x: f64,
    y: f64,
}

/// `GET /api/data/model/locate?x=&y=`: whether a model's point (x, y), in its own units with
/// Z up, is in map coordinates that land on this table, and how to place it there (#344).
pub async fn locate(State(state): State<Arc<AppState>>, Query(query): Query<LocateQuery>) -> axum::response::Response {
    let dir = state.site.dir.clone();
    let found = tokio::task::spawn_blocking(move || Site::load(&dir).ok().and_then(|site| model::locate(&site, query.x, query.y)))
        .await
        .ok()
        .flatten();
    Json(json!({ "map": found })).into_response()
}
