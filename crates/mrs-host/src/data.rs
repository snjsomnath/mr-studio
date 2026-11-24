//! Bringing data into a site without a running table (#320): OpenStreetMap, free elevation and
//! files, read and checked by `mrs_site::import` exactly as the editor's Add data does. The host
//! uses these behind `/api/data/*`; `mrstudio data` uses them from the command line, and the MCP
//! server through that. A running table notices the change to site.json and records it.

use std::path::Path;

use mrs_site::elevation;
use mrs_site::import::{self, Options, Report, Target};
use mrs_site::osm::{self, OsmLayer};
use mrs_site::Site;
use serde_json::Value;

/// Where OpenStreetMap is asked, in order: the main Overpass server, then public mirrors.
/// `MRS_OVERPASS_URL` replaces the list with one server (a mirror of your own, or a test).
const OVERPASS_URLS: [&str; 3] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
];

/// Tries in all before a fetch gives up, waiting 1, 2, then 4 seconds between them.
const OVERPASS_TRIES: u32 = 4;
/// Each elevation tile is asked for this many times before the fetch gives up.
const ELEVATION_TRIES: u32 = 3;

/// The refusal when no Overpass server answered.
pub fn osm_offline(target: &Target, detail: String) -> Report {
    tracing::warn!("OpenStreetMap fetch failed: {detail}");
    Report::refused(
        target,
        "osm.offline",
        "We can't reach OpenStreetMap right now. Check the internet connection and try again in a minute.",
        "OpenStreetMap did not answer.",
    )
}

/// One layer's share of an Overpass answer as GeoJSON; nothing mapped there is a refusal.
pub fn osm_collection(target: &Target, layer: OsmLayer, answer: &Value) -> Result<Vec<u8>, Report> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let collection = osm::to_geojson(layer, answer, &osm::date(now));
    if osm::count(&collection) == 0 {
        let words = osm::nothing_found(layer);
        return Err(Report::refused(target, "osm.empty", words.clone(), words));
    }
    Ok(serde_json::to_vec(&collection).expect("json"))
}

/// The table's extent plus a margin, as OpenStreetMap and the elevation service are asked for it.
pub fn site_bounds(site_dir: &Path, target: &Target) -> Result<[f64; 4], Report> {
    Site::load(site_dir)
        .map(|site| osm::bounds(&site))
        .map_err(|e| Report::refused(target, "site.unreadable", e.to_string(), e.to_string()))
}

/// Asks OpenStreetMap for one layer around the table, as a GeoJSON file `import_file` takes.
pub async fn osm_for(site_dir: &Path, target: &Target) -> Result<Vec<u8>, Report> {
    let layer = OsmLayer::for_target(target).map_err(|why| Report::refused(target, "osm.unavailable", why.clone(), why))?;
    let bounds = site_bounds(site_dir, target)?;
    let answer = ask_overpass(&osm::query(layer, bounds)).await.map_err(|detail| osm_offline(target, detail))?;
    osm_collection(target, layer, &answer)
}

/// Sends one Overpass query, trying again after a pause on the next mirror when a server is busy.
pub async fn ask_overpass(query: &str) -> Result<Value, String> {
    let urls: Vec<String> = match std::env::var("MRS_OVERPASS_URL") {
        Ok(url) => vec![url],
        Err(_) => OVERPASS_URLS.iter().map(|u| u.to_string()).collect(),
    };
    let client = reqwest::Client::builder()
        .user_agent("MR Studio")
        .timeout(std::time::Duration::from_secs(200))
        .build()
        .map_err(|e| e.to_string())?;
    // Overpass is often busy (429, 502, 504): try again after a pause, on the next mirror.
    let mut last = String::new();
    for attempt in 0..OVERPASS_TRIES {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1 << (attempt - 1))).await;
        }
        let url = &urls[attempt as usize % urls.len()];
        match client.post(url).form(&[("data", query)]).send().await {
            Ok(response) if response.status().is_success() => match response.json::<Value>().await {
                Ok(value) => return Ok(value),
                Err(e) => last = format!("{url}: {e}"),
            },
            Ok(response) => last = format!("{url} answered {}", response.status()),
            Err(e) => last = format!("{url}: {e}"),
        }
        tracing::info!("OpenStreetMap try {} of {OVERPASS_TRIES} failed: {last}", attempt + 1);
    }
    Err(last)
}

/// Fetches free elevation around the table (Terrarium tiles on AWS, no key) as a GeoTIFF
/// `import_data` takes for the ground. The refusal is a report, as for OpenStreetMap.
pub async fn elevation_for(site_dir: &Path, target: &Target) -> Result<Vec<u8>, Report> {
    if *target != Target::Terrain {
        let why = "Free elevation is only for the ground.".to_string();
        return Err(Report::refused(target, "elevation.unavailable", why.clone(), why));
    }
    let dir = site_dir.to_path_buf();
    let bounds = tokio::task::spawn_blocking(move || Site::load(&dir).map(|site| osm::bounds(&site)))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()))
        .map_err(|e| Report::refused(target, "site.unreadable", e.clone(), e))?;
    let offline = |detail: String| {
        tracing::warn!("elevation fetch failed: {detail}");
        Report::refused(
            target,
            "elevation.offline",
            "We can't reach the free elevation service right now. Check the internet connection and try again in a minute.",
            "The elevation service did not answer.",
        )
    };
    let client = reqwest::Client::builder()
        .user_agent("MR Studio")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| offline(e.to_string()))?;
    let base = std::env::var("MRS_ELEVATION_URL").ok();
    let mut tasks = tokio::task::JoinSet::new();
    for id in elevation::tiles(bounds) {
        let client = client.clone();
        let url = match &base {
            Some(base) => format!("{base}/{}/{}/{}.png", id.z, id.x, id.y),
            None => id.url(),
        };
        tasks.spawn(async move {
            let mut last = String::new();
            for attempt in 0..ELEVATION_TRIES {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(1 << (attempt - 1))).await;
                }
                match client.get(&url).send().await {
                    Ok(response) if response.status().is_success() => match response.bytes().await {
                        Ok(bytes) => return elevation::decode(&bytes).map(|heights| (id, heights)).map_err(|e| format!("{url}: {e}")),
                        Err(e) => last = format!("{url}: {e}"),
                    },
                    Ok(response) => last = format!("{url} answered {}", response.status()),
                    Err(e) => last = format!("{url}: {e}"),
                }
            }
            Err(last)
        });
    }
    let mut tiles = Vec::new();
    while let Some(done) = tasks.join_next().await {
        tiles.push(done.map_err(|e| offline(e.to_string()))?.map_err(offline)?);
    }
    tokio::task::spawn_blocking(move || elevation::geotiff(bounds, &tiles))
        .await
        .map_err(|e| offline(e.to_string()))?
        .map_err(|e| Report::refused(target, "elevation.unreadable", format!("The elevation could not be read: {e}"), e))
}

/// Reads and checks a file for `target` against the site as it is on disk and, with `write`,
/// saves it and wires it into site.json. A blocker leaves the site untouched; the report is the
/// same either way.
pub fn import_file(site_dir: &Path, target: &str, filename: &str, bytes: &[u8], options: Options, write: bool) -> Result<Report, String> {
    let target = Target::parse(target)?;
    let site = Site::load(site_dir).map_err(|e| e.to_string())?;
    let prepared = import::inspect(&site, &target, filename, bytes, options);
    if !write || !prepared.report.ok {
        return Ok(prepared.report);
    }
    import::apply(&site, prepared).map(|(_, report)| report).map_err(|e| e.to_string())
}

/// The note a free-elevation import carries.
pub fn elevation_note(report: &mut Report) {
    report.note(
        "source.elevation",
        format!(
            "From {}. About 30 m detail in most places: fine for hills, too coarse for kerbs and steps on a campus-sized table.",
            elevation::ATTRIBUTION
        ),
    );
}
