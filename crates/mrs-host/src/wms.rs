//! `GET /api/wms`: one WMS map image for the table, fetched by the host. Surfaces cannot
//! fetch most WMS services themselves (no CORS headers), and a picture from another origin
//! cannot be drawn on the table. A service that needs a sign-in names a source from the
//! Sources manager (`source=<id>`, #41/#42): the host adds its key, and the table never sees it.

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::sources::Sources;

/// The largest image the table asks for, per side.
const MAX_SIDE: u32 = 4096;

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
}

/// The GetMap address: WMS 1.1.1 in EPSG:4326, so the box is longitude first everywhere.
pub fn get_map_url(q: &WmsQuery) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(q.url.trim()).map_err(|e| format!("the WMS address is not a web address: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the WMS address must start with http:// or https://".into());
    }
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

pub async fn get_map(sources: &Sources, mut q: WmsQuery) -> Response {
    let source = q.source.take().filter(|s| !s.trim().is_empty());
    if let Some(id) = &source {
        if q.url.trim().is_empty() {
            match sources.connection(id) {
                Some(c) => q.url = c.url,
                None => return (StatusCode::NOT_FOUND, format!("there is no source called '{id}'")).into_response(),
            }
        }
    }
    let url = match get_map_url(&q) {
        Ok(url) => url,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let request = match &source {
        Some(id) => match sources.request(id, url).await {
            Ok(request) => request,
            Err(refusal) => {
                return (StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::BAD_GATEWAY), refusal.message).into_response()
            }
        },
        None => match reqwest::Client::builder().user_agent("MR Studio").timeout(std::time::Duration::from_secs(30)).build() {
            Ok(client) => client.get(url),
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
        },
    };
    // Never repeat the address: with a source it may carry the key.
    let answer = match request.send().await {
        Ok(answer) => answer,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("the WMS service could not be reached: {}", e.without_url())).into_response(),
    };
    let status = answer.status();
    let kind = answer.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = match answer.bytes().await {
        Ok(body) => body,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("the WMS service stopped answering: {}", e.without_url())).into_response(),
    };
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        let words = if source.is_some() {
            "the WMS service did not accept the key or login"
        } else {
            "the WMS service wants a sign-in: add it in Sources and choose it for this map"
        };
        return (StatusCode::BAD_GATEWAY, format!("{words} ({status})")).into_response();
    }
    // Services answer errors as XML with status 200; only a picture is passed on.
    if !status.is_success() || !kind.starts_with("image/") {
        let said: String = String::from_utf8_lossy(&body[..body.len().min(400)]).chars().filter(|c| !c.is_control()).collect();
        return (StatusCode::BAD_GATEWAY, format!("the WMS service answered {status} {kind}: {said}")).into_response();
    }
    ([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "max-age=300".to_string())], body).into_response()
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
}
