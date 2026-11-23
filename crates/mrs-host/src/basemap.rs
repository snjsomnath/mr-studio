//! Base map tiles from the key-free services the Base map layer offers (#37), kept on disk in
//! the site folder, so a table that has shown its map once shows it again without a connection.
//!
//! The layer asks `GET /api/basemap/<service>/<z>/<x>/<y>`. Only the services listed here are
//! fetched, each from its own address, so the route is not a way to reach anything else.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// The folder in a site that holds the tiles, by service, zoom, column and row.
pub const CACHE_DIR: &str = ".cache/tiles";

/// How old a kept tile may be before it is fetched again, when there is a connection.
const FRESH: Duration = Duration::from_secs(30 * 24 * 3600);

/// The services and their tile addresses. They match `packages/layers/basemap/src/tiles.ts`.
pub const SERVICES: &[(&str, &str)] = &[
    ("osm", "https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
    ("esri-imagery", "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"),
    ("esri-grey", "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"),
    ("esri-dark-grey", "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"),
    ("opentopomap", "https://tile.opentopomap.org/{z}/{x}/{y}.png"),
];

/// The address of one tile, or `None` for a service or tile that does not exist.
pub fn tile_url(service: &str, z: u32, x: u32, y: u32) -> Option<String> {
    let (_, template) = SERVICES.iter().find(|(id, _)| *id == service)?;
    if z > 20 || x >= 1 << z || y >= 1 << z {
        return None;
    }
    Some(template.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string()))
}

/// Where a tile is kept in the site folder.
pub fn cache_path(site: &Path, service: &str, z: u32, x: u32, y: u32) -> PathBuf {
    site.join(CACHE_DIR).join(service).join(z.to_string()).join(x.to_string()).join(y.to_string())
}

/// The image type of tile bytes, from their first bytes.
pub fn content_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "image/jpeg"
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().user_agent("MR Studio").timeout(Duration::from_secs(20)).build().expect("an HTTP client"))
}

/// A tile: the kept copy while it is fresh, else from the service (and kept), else the kept
/// copy however old. `Err` says why there is none.
pub async fn tile(site: &Path, service: &str, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
    let url = tile_url(service, z, x, y).ok_or("no such tile")?;
    let path = cache_path(site, service, z, x, y);
    let kept = tokio::fs::read(&path).await.ok();
    let fresh = tokio::fs::metadata(&path).await.ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age < FRESH);
    if let (Some(bytes), true) = (&kept, fresh) {
        return Ok(bytes.clone());
    }
    let fetched = async {
        let answer = client().get(&url).send().await.map_err(|e| e.without_url().to_string())?;
        if !answer.status().is_success() {
            return Err(format!("the map service answered {}", answer.status()));
        }
        answer.bytes().await.map(|b| b.to_vec()).map_err(|e| e.without_url().to_string())
    }
    .await;
    match fetched {
        Ok(bytes) => {
            if let Some(dir) = path.parent() {
                if tokio::fs::create_dir_all(dir).await.is_ok() {
                    if let Err(e) = tokio::fs::write(&path, &bytes).await {
                        tracing::warn!("could not keep a base map tile: {e}");
                    }
                }
            }
            Ok(bytes)
        }
        // Offline: an old tile is better than none.
        Err(why) => kept.ok_or(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_services_and_real_tiles() {
        assert_eq!(tile_url("esri-grey", 14, 8737, 4783).unwrap(), "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/14/4783/8737");
        assert!(tile_url("carto-light", 1, 0, 0).is_none(), "CARTO wants a key now: it goes through Sources");
        assert_eq!(tile_url("esri-imagery", 2, 1, 3).unwrap(), "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/2/3/1");
        assert!(tile_url("http://example.com", 1, 0, 0).is_none());
        assert!(tile_url("osm", 2, 4, 0).is_none(), "x past the edge of the world");
        assert!(tile_url("osm", 21, 0, 0).is_none());
    }

    #[tokio::test]
    async fn a_kept_tile_is_served_without_a_connection() {
        let site = std::env::temp_dir().join(format!("mrs-basemap-test-{}", std::process::id()));
        let path = cache_path(&site, "osm", 3, 4, 2);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"\x89PNG kept").unwrap();
        assert_eq!(tile(&site, "osm", 3, 4, 2).await.unwrap(), b"\x89PNG kept");
        assert_eq!(content_type(b"\x89PNG kept"), "image/png");
        let _ = std::fs::remove_dir_all(&site);
    }
}
