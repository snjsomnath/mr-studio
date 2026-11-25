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

/// Where OpenStreetMap is asked, in turn: the main Overpass server, then a public mirror, each
/// host once (#424: `overpass.kumi.systems` now redirects to `overpass.private.coffee`, so
/// listing both asked one silent server twice). `MRS_OVERPASS_URL` replaces the list with one
/// server (a mirror of your own, or a test); several can be given, separated by commas.
const OVERPASS_URLS: [&str; 2] = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

/// Tries for each part before a fetch gives up, waiting 1 then 2 seconds between them.
const OVERPASS_TRIES: u32 = 3;
/// How long a server may take to accept the connection, and then to start its answer. Overpass
/// starts its JSON at once and streams the rest, so a server that is silent this long is not
/// going to answer: move on in seconds, not minutes (#424).
const OVERPASS_CONNECT: std::time::Duration = std::time::Duration::from_secs(10);
const OVERPASS_FIRST_BYTE: std::time::Duration = std::time::Duration::from_secs(20);
/// How long the rest of the answer may take once it has started (the query's own limit is 180 s).
const OVERPASS_BODY: std::time::Duration = std::time::Duration::from_secs(190);
/// Each elevation tile is asked for this many times before the fetch gives up.
const ELEVATION_TRIES: u32 = 3;

/// The refusal when no Overpass server answered.
pub fn osm_offline(target: &Target, detail: String) -> Report {
    tracing::warn!("OpenStreetMap fetch failed: {detail}");
    Report::refused(
        target,
        "osm.offline",
        format!("No OpenStreetMap server answered (last: {detail}). Check the internet connection and try again in a minute."),
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
    let say = |words: String| tracing::info!("{words}");
    let answer = ask_overpass(&|b| osm::query(layer, b), bounds, &say).await.map_err(|detail| osm_offline(target, detail))?;
    osm_collection(target, layer, &answer)
}

/// The Overpass servers to ask, each host once.
fn overpass_urls() -> Vec<String> {
    let listed: Vec<String> = match std::env::var("MRS_OVERPASS_URL") {
        Ok(urls) => urls.split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect(),
        Err(_) => OVERPASS_URLS.iter().map(|u| u.to_string()).collect(),
    };
    let mut hosts = Vec::new();
    let mut urls = Vec::new();
    for url in listed {
        let host = server_name(&url);
        if !hosts.contains(&host) {
            hosts.push(host);
            urls.push(url);
        }
    }
    urls
}

/// The name a person knows a server by: its host, with the port when it is not the usual one.
fn server_name(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else { return url.to_string() };
    match (parsed.host_str(), parsed.port()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => url.to_string(),
    }
}

/// Asks OpenStreetMap for everything `query_for` asks within `bounds`, in tiles no wider than
/// `osm::TILE_M` (#424) so the main server does not refuse a whole table, and merges the
/// answers. Each tile is tried on the next server when one is busy or silent. `say` hears
/// which part is being asked and where, in words for the import dialog.
pub async fn ask_overpass(
    query_for: &(dyn Fn([f64; 4]) -> String + Sync),
    bounds: [f64; 4],
    say: &(dyn Fn(String) + Send + Sync),
) -> Result<Value, String> {
    let urls = overpass_urls();
    if urls.is_empty() {
        return Err("no Overpass server is set".into());
    }
    let client = reqwest::Client::builder().user_agent("MR Studio").connect_timeout(OVERPASS_CONNECT).build().map_err(|e| e.to_string())?;
    let tiles = osm::tiles(bounds, osm::TILE_M);
    let mut merged = osm::Merge::default();
    // The next part starts on the server that answered the last one, so a silent one costs once.
    let mut first = 0;
    for (i, tile) in tiles.iter().enumerate() {
        let part = if tiles.len() > 1 { format!(", part {} of {}", i + 1, tiles.len()) } else { String::new() };
        let (answer, used) = ask_one(&client, &urls, first, &query_for(*tile), &|server, attempt| {
            let again = if attempt > 0 { format!(", try {} of {OVERPASS_TRIES}", attempt + 1) } else { String::new() };
            say(format!("Asking {server}{part}{again}"));
        })
        .await?;
        first = used;
        merged.add(answer);
    }
    Ok(merged.answer())
}

/// One Overpass query, tried on each server in turn (from `urls[first]`) after a short pause. A
/// server that does not start answering within `OVERPASS_FIRST_BYTE` counts as busy. Returns the
/// answer and which server gave it.
async fn ask_one(
    client: &reqwest::Client,
    urls: &[String],
    first: usize,
    query: &str,
    trying: &(dyn Fn(&str, u32) + Send + Sync),
) -> Result<(Value, usize), String> {
    let mut last = String::new();
    for attempt in 0..OVERPASS_TRIES {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1 << (attempt - 1))).await;
        }
        let index = (first + attempt as usize) % urls.len();
        let url = &urls[index];
        let server = server_name(url);
        trying(&server, attempt);
        match tokio::time::timeout(OVERPASS_FIRST_BYTE, client.post(url).form(&[("data", query)]).send()).await {
            Err(_) => last = format!("{server} did not answer within {} s", OVERPASS_FIRST_BYTE.as_secs()),
            Ok(Err(e)) => last = format!("{server}: {e}"),
            Ok(Ok(response)) if response.status().is_success() => match tokio::time::timeout(OVERPASS_BODY, response.json::<Value>()).await
            {
                Ok(Ok(value)) => return Ok((value, index)),
                Ok(Err(e)) => last = format!("{server}: {e}"),
                Err(_) => last = format!("{server} stopped part-way through its answer"),
            },
            Ok(Ok(response)) => last = format!("{server} answered {}", response.status()),
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
