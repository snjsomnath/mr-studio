//! `GET /api/wms`: one WMS map image for the table, fetched by the host. Surfaces cannot
//! fetch most WMS services themselves (no CORS headers), and a picture from another origin
//! cannot be drawn on the table. A service that needs a sign-in names a source from the
//! Sources manager (`source=<id>`, #41/#42): the host adds its key, and the table never sees it.
//!
//! An ArcGIS map or image service (`service=arcgis`) is asked through its REST `export`
//! (MapServer) or `exportImage` (ImageServer) instead, with the same box and size (#42).
//!
//! Every picture is kept in the site folder (`.cache/maps`), so a table that has shown a map
//! once shows it again at a venue without a connection, or with a service that is down. A kept
//! picture younger than a day is used as it is, which also makes slides quick to step through.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::sources::Sources;

/// The largest image the table asks for, per side.
const MAX_SIDE: u32 = 4096;

/// The folder in a site that keeps the pictures.
pub const CACHE_DIR: &str = ".cache/maps";

/// How old a kept picture may be before the service is asked again.
const FRESH: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug, serde::Deserialize)]
pub struct WmsQuery {
    /// The service address, such as `https://ows.example.org/wms`. Its own query is kept.
    /// With a `source`, empty means the source's own address.
    #[serde(default)]
    pub url: String,
    /// A connection in the Sources manager whose key or login signs the request.
    #[serde(default)]
    pub source: Option<String>,
    pub layers: String,
    #[serde(default)]
    pub styles: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    /// `minLon,minLat,maxLon,maxLat`.
    pub bbox: String,
    pub width: u32,
    pub height: u32,
    /// `wms` (the default) or `arcgis`.
    #[serde(default)]
    pub service: Option<String>,
}

/// The box and size, checked: `[minLon, minLat, maxLon, maxLat]`.
fn checked_box(q: &WmsQuery) -> Result<[f64; 4], String> {
    let numbers: Vec<f64> =
        q.bbox.split(',').map(|v| v.trim().parse::<f64>()).collect::<Result<_, _>>().map_err(|_| "bbox must be four numbers")?;
    let [w, s, e, n] = numbers[..] else { return Err("bbox must be four numbers".into()) };
    if !(w < e
        && s < n
        && (-180.0..=180.0).contains(&w)
        && (-180.0..=180.0).contains(&e)
        && (-90.0..=90.0).contains(&s)
        && (-90.0..=90.0).contains(&n))
    {
        return Err("bbox must be minLon,minLat,maxLon,maxLat".into());
    }
    if q.width == 0 || q.height == 0 || q.width > MAX_SIDE || q.height > MAX_SIDE {
        return Err(format!("width and height are 1 to {MAX_SIDE}"));
    }
    Ok([w, s, e, n])
}

fn service_url(q: &WmsQuery, what: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(q.url.trim()).map_err(|e| format!("the {what} address is not a web address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("the {what} address must start with http:// or https://"));
    }
    Ok(url)
}

/// The address of the picture, for either kind of service.
pub fn map_url(q: &WmsQuery) -> Result<reqwest::Url, String> {
    match q.service.as_deref().map(str::trim).unwrap_or("") {
        "" | "wms" => get_map_url(q),
        "arcgis" => arcgis_url(q),
        other => Err(format!("unknown map service '{other}': use wms or arcgis")),
    }
}

/// An ArcGIS REST export in EPSG:4326: `…/MapServer/export` or `…/ImageServer/exportImage`.
/// `layers` (optional) is a comma-separated list of the map service's layer ids to show.
pub fn arcgis_url(q: &WmsQuery) -> Result<reqwest::Url, String> {
    let mut url = service_url(q, "ArcGIS")?;
    let [w, s, e, n] = checked_box(q)?;
    let path = url.path().trim_end_matches('/').to_string();
    let lower = path.to_ascii_lowercase();
    let (base, image) = if let Some(at) = lower.rfind("/mapserver") {
        (&path[..at + "/mapserver".len()], false)
    } else if let Some(at) = lower.rfind("/imageserver") {
        (&path[..at + "/imageserver".len()], true)
    } else {
        return Err("an ArcGIS address ends in /MapServer or /ImageServer".into());
    };
    url.set_path(&format!("{base}/{}", if image { "exportImage" } else { "export" }));
    // The service's own query (a token kept in the address, say) stays; export keys are replaced.
    let keep: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| {
            !matches!(
                k.to_ascii_lowercase().as_str(),
                "bbox" | "bboxsr" | "imagesr" | "size" | "format" | "transparent" | "f" | "layers" | "dpi"
            )
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut pairs = url.query_pairs_mut();
    pairs
        .clear()
        .extend_pairs(keep)
        .append_pair("bbox", &format!("{w},{s},{e},{n}"))
        .append_pair("bboxSR", "4326")
        .append_pair("imageSR", "4326")
        .append_pair("size", &format!("{},{}", q.width, q.height))
        .append_pair("format", if image { "png" } else { "png32" })
        .append_pair("transparent", "true")
        .append_pair("f", "image");
    let layers = q.layers.trim();
    if !image && !layers.is_empty() {
        pairs.append_pair("layers", &format!("show:{layers}"));
    }
    drop(pairs);
    Ok(url)
}

/// The GetMap address: WMS 1.1.1 in EPSG:4326, so the box is longitude first everywhere.
pub fn get_map_url(q: &WmsQuery) -> Result<reqwest::Url, String> {
    let mut url = service_url(q, "WMS")?;
    let [w, s, e, n] = checked_box(q)?;
    if q.layers.trim().is_empty() {
        return Err("name at least one of the service's layers".into());
    }
    // A service address often carries its own query (`?map=…`); WMS keys in it are replaced.
    let keep: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| {
            !matches!(
                k.to_ascii_lowercase().as_str(),
                "service"
                    | "version"
                    | "request"
                    | "layers"
                    | "styles"
                    | "format"
                    | "srs"
                    | "crs"
                    | "bbox"
                    | "width"
                    | "height"
                    | "transparent"
            )
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(keep)
        .append_pair("SERVICE", "WMS")
        .append_pair("VERSION", "1.1.1")
        .append_pair("REQUEST", "GetMap")
        .append_pair("LAYERS", q.layers.trim())
        .append_pair("STYLES", q.styles.as_deref().unwrap_or("").trim())
        .append_pair("FORMAT", q.format.as_deref().filter(|f| !f.trim().is_empty()).unwrap_or("image/png").trim())
        .append_pair("TRANSPARENT", "TRUE")
        .append_pair("SRS", "EPSG:4326")
        .append_pair("BBOX", &format!("{w},{s},{e},{n}"))
        .append_pair("WIDTH", &q.width.to_string())
        .append_pair("HEIGHT", &q.height.to_string());
    Ok(url)
}

/// Where a picture is kept: named by a hash of its address and the source that signs it.
pub fn cache_path(site: &Path, url: &reqwest::Url, source: Option<&str>) -> PathBuf {
    // FNV-1a: stable across builds, unlike the standard library's hasher.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_str().bytes().chain([0]).chain(source.unwrap_or("").bytes()) {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    site.join(CACHE_DIR).join(format!("{hash:016x}"))
}

fn picture(bytes: Vec<u8>, kind: &str, kept: Option<&str>) -> Response {
    let mut response =
        ([(header::CONTENT_TYPE, kind.to_string()), (header::CACHE_CONTROL, "max-age=300".to_string())], bytes).into_response();
    if let Some(kept) = kept {
        // `fresh`: kept less than a day ago; `stale`: the service could not give a new one.
        response.headers_mut().insert("x-mrs-kept", header::HeaderValue::from_static(if kept == "fresh" { "fresh" } else { "stale" }));
    }
    response
}

pub async fn get_map(site: &Path, sources: &Sources, mut q: WmsQuery) -> Response {
    let source = q.source.take().filter(|s| !s.trim().is_empty());
    if let Some(id) = &source {
        if q.url.trim().is_empty() {
            match sources.connection(id) {
                Some(c) => q.url = c.url,
                None => return (StatusCode::NOT_FOUND, format!("there is no source called '{id}'")).into_response(),
            }
        }
    }
    let url = match map_url(&q) {
        Ok(url) => url,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let path = cache_path(site, &url, source.as_deref());
    let kept = tokio::fs::read(&path).await.ok().filter(|b| !b.is_empty());
    let fresh =
        tokio::fs::metadata(&path).await.ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age < FRESH);
    if let (Some(bytes), true) = (&kept, fresh) {
        let kind = crate::basemap::content_type(bytes);
        return picture(bytes.clone(), kind, Some("fresh"));
    }
    match fetch(sources, &q, url, source.as_deref()).await {
        Ok((bytes, kind)) => {
            if let Some(dir) = path.parent() {
                if tokio::fs::create_dir_all(dir).await.is_ok() {
                    if let Err(e) = tokio::fs::write(&path, &bytes).await {
                        tracing::warn!("could not keep a map picture: {e}");
                    }
                }
            }
            picture(bytes, &kind, None)
        }
        // A picture kept from before is better than none: the venue may be offline.
        Err(failure) => match kept {
            Some(bytes) => {
                tracing::warn!("showing a kept map picture: {}", failure.1);
                let kind = crate::basemap::content_type(&bytes);
                picture(bytes, kind, Some("stale"))
            }
            None => failure.into_response(),
        },
    }
}

/// Asks the service for the picture. Only an image is accepted.
async fn fetch(
    sources: &Sources,
    q: &WmsQuery,
    url: reqwest::Url,
    source: Option<&str>,
) -> Result<(Vec<u8>, String), (StatusCode, String)> {
    let what = if q.service.as_deref().map(str::trim) == Some("arcgis") { "ArcGIS" } else { "WMS" };
    let request = match source {
        Some(id) => sources
            .request(id, url)
            .await
            .map_err(|refusal| (StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::BAD_GATEWAY), refusal.message))?,
        None => match reqwest::Client::builder().user_agent("MR Studio").timeout(Duration::from_secs(30)).build() {
            Ok(client) => client.get(url),
            Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        },
    };
    // Never repeat the address: with a source it may carry the key.
    let answer = request
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("the {what} service could not be reached: {}", e.without_url())))?;
    let status = answer.status();
    let kind = answer.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = answer
        .bytes()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("the {what} service stopped answering: {}", e.without_url())))?;
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        let words = if source.is_some() {
            format!("the {what} service did not accept the key or login")
        } else {
            format!("the {what} service wants a sign-in: add it in Sources and choose it for this map")
        };
        return Err((StatusCode::BAD_GATEWAY, format!("{words} ({status})")));
    }
    // Services answer errors as XML or JSON with status 200; only a picture is passed on.
    if !status.is_success() || !kind.starts_with("image/") {
        let said: String = String::from_utf8_lossy(&body[..body.len().min(400)]).chars().filter(|c| !c.is_control()).collect();
        // ArcGIS says a token is missing or wrong with codes 498 and 499 inside a JSON answer.
        if said.contains("\"code\":498") || said.contains("\"code\":499") {
            return Err((StatusCode::BAD_GATEWAY, format!("the {what} service did not accept the token")));
        }
        return Err((StatusCode::BAD_GATEWAY, format!("the {what} service answered {status} {kind}: {said}")));
    }
    Ok((body.to_vec(), kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(url: &str) -> WmsQuery {
        WmsQuery {
            url: url.into(),
            source: None,
            layers: "roads".into(),
            styles: None,
            format: None,
            bbox: "11.9,57.6,12.0,57.7".into(),
            width: 1024,
            height: 512,
            service: None,
        }
    }

    #[test]
    fn get_map_keeps_the_service_query_and_replaces_wms_keys() {
        let url = get_map_url(&query("https://maps.example.org/wms?map=city&request=GetCapabilities")).unwrap();
        let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(pairs[0], ("map".into(), "city".into()));
        assert!(pairs.contains(&("REQUEST".into(), "GetMap".into())));
        assert!(!pairs.iter().any(|(k, _)| k == "request"));
        assert!(pairs.contains(&("BBOX".into(), "11.9,57.6,12,57.7".into())));
        assert!(pairs.contains(&("FORMAT".into(), "image/png".into())));
    }

    #[test]
    fn get_map_refuses_what_is_not_a_map_request() {
        assert!(get_map_url(&query("file:///etc/passwd")).is_err());
        assert!(get_map_url(&WmsQuery { bbox: "12,57,11,58".into(), ..query("https://a.org/wms") }).is_err());
        assert!(get_map_url(&WmsQuery { width: 9000, ..query("https://a.org/wms") }).is_err());
        assert!(get_map_url(&WmsQuery { layers: " ".into(), ..query("https://a.org/wms") }).is_err());
    }

    #[test]
    fn arcgis_exports_from_a_map_or_image_server() {
        let map = WmsQuery {
            service: Some("arcgis".into()),
            layers: "0,3".into(),
            ..query("https://gis.example.org/arcgis/rest/services/Plan/MapServer?token=abc")
        };
        let url = map_url(&map).unwrap();
        assert_eq!(url.path(), "/arcgis/rest/services/Plan/MapServer/export");
        let pairs: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(pairs[0], ("token".into(), "abc".into()));
        for want in [("bbox", "11.9,57.6,12,57.7"), ("bboxSR", "4326"), ("size", "1024,512"), ("f", "image"), ("layers", "show:0,3")] {
            assert!(pairs.contains(&(want.0.into(), want.1.into())), "{want:?} in {pairs:?}");
        }
        let image = WmsQuery {
            service: Some("arcgis".into()),
            layers: "".into(),
            ..query("https://gis.example.org/arcgis/rest/services/Ortho/ImageServer/")
        };
        let url = map_url(&image).unwrap();
        assert_eq!(url.path(), "/arcgis/rest/services/Ortho/ImageServer/exportImage");
        assert!(!url.query_pairs().any(|(k, _)| k == "layers"));
        assert!(map_url(&WmsQuery { service: Some("arcgis".into()), ..query("https://gis.example.org/arcgis/rest/services") }).is_err());
        assert!(map_url(&WmsQuery { service: Some("ftp".into()), ..query("https://a.org/wms") }).is_err());
    }

    #[test]
    fn a_kept_picture_is_named_by_its_address_and_signer() {
        let site = Path::new("/sites/a");
        let url = get_map_url(&query("https://a.org/wms")).unwrap();
        let open = cache_path(site, &url, None);
        assert!(open.starts_with("/sites/a/.cache/maps"));
        assert_eq!(open, cache_path(site, &url, None));
        assert_ne!(open, cache_path(site, &url, Some("lm")));
        let other = get_map_url(&WmsQuery { layers: "rivers".into(), ..query("https://a.org/wms") }).unwrap();
        assert_ne!(open, cache_path(site, &other, None));
    }
}
