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

/// Where OpenStreetMap is asked, in turn: the main Overpass server, then public mirrors, each
/// host once (#424: `overpass.kumi.systems` now redirects to `overpass.private.coffee`, so
/// listing both asked one silent server twice; #603 added VK Maps' mirror). `MRS_OVERPASS_URL`
/// replaces the list (a mirror of your own, or a test); several can be given, separated by commas.
const OVERPASS_URLS: [&str; 3] = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

/// Tries for each part before a fetch gives up, across the servers.
const OVERPASS_TRIES: u32 = 4;
/// How long a server may take to accept the connection.
const OVERPASS_CONNECT: std::time::Duration = std::time::Duration::from_secs(10);
/// How long a server may take to start its answer (#603): it may queue a query 15 s for a free
/// slot and then run it for the query's own limit. Hanging up sooner does not stop the work, which
/// keeps holding one of our slots there, so the next try was refused with 429 by our own query.
const OVERPASS_FIRST_BYTE: std::time::Duration = std::time::Duration::from_secs(osm::QUERY_SECONDS + 20);
/// How long the rest of the answer may take once it has started.
const OVERPASS_BODY: std::time::Duration = std::time::Duration::from_secs(osm::QUERY_SECONDS + 30);
/// How long a server that answered 429 (too many requests from us) is left alone (#603). Its
/// operators ask for at least 30 s, and ban addresses that come back sooner.
const OVERPASS_REST_429: std::time::Duration = std::time::Duration::from_secs(30);
/// How long a busy (502, 503, 504) or silent server is left alone before it is asked again.
const OVERPASS_REST_BUSY: std::time::Duration = std::time::Duration::from_secs(3);
/// The longest wait for a free slot that a server's `/api/status` announces before it is asked.
const OVERPASS_SLOT_WAIT: u64 = 60;
/// How long a part that came back is kept, so trying again after a failure asks only for the rest.
const OVERPASS_KEEP: std::time::Duration = std::time::Duration::from_secs(15 * 60);
/// Who is asking, with where to find us, as the Overpass operators ask of every app (#603).
const OVERPASS_AGENT: &str = concat!("MR Studio/", env!("CARGO_PKG_VERSION"), " (+https://github.com/snjsomnath/mr-studio)");
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

/// Parts that came back lately, by query, so a fetch tried again asks only for what failed.
static OVERPASS_ANSWERS: std::sync::LazyLock<parking_lot::Mutex<std::collections::HashMap<String, (std::time::Instant, Value)>>> =
    std::sync::LazyLock::new(Default::default);

/// Asks OpenStreetMap for everything `query_for` asks within `bounds`, in tiles no wider than
/// `osm::TILE_M` (#424) so the main server does not refuse a whole table, and merges the
/// answers. Each tile is tried on the next server when one is busy or silent. `say` hears
/// which part is being asked and where, in words for the import dialog.
pub async fn ask_overpass(
    query_for: &(dyn Fn([f64; 4]) -> String + Sync),
    bounds: [f64; 4],
    say: &(dyn Fn(String) + Send + Sync),
) -> Result<Value, String> {
    ask_servers(overpass_urls(), query_for, bounds, say).await
}

/// `ask_overpass` on the servers `urls`, in turn.
async fn ask_servers(
    urls: Vec<String>,
    query_for: &(dyn Fn([f64; 4]) -> String + Sync),
    bounds: [f64; 4],
    say: &(dyn Fn(String) + Send + Sync),
) -> Result<Value, String> {
    if urls.is_empty() {
        return Err("no Overpass server is set".into());
    }
    let client =
        reqwest::Client::builder().user_agent(OVERPASS_AGENT).connect_timeout(OVERPASS_CONNECT).build().map_err(|e| e.to_string())?;
    // Parts still to ask, with how many times each was halved; the first is asked first.
    let mut todo: std::collections::VecDeque<([f64; 4], u32)> = osm::tiles(bounds, osm::TILE_M).into_iter().map(|t| (t, 0)).collect();
    let mut merged = osm::Merge::default();
    let mut servers = Servers::new(urls);
    let mut done = 0;
    while let Some((tile, halved)) = todo.pop_front() {
        let query = query_for(tile);
        let kept = {
            let mut answers = OVERPASS_ANSWERS.lock();
            answers.retain(|_, (at, _)| at.elapsed() < OVERPASS_KEEP);
            answers.get(&query).map(|(_, answer)| answer.clone())
        };
        let answer = match kept {
            Some(answer) => answer,
            None => {
                let total = done + 1 + todo.len();
                let part = if total > 1 { format!(", part {} of {total}", done + 1) } else { String::new() };
                match ask_one(&client, &mut servers, &query, &|words| say(format!("{words}{part}"))).await {
                    Ok(answer) => {
                        OVERPASS_ANSWERS.lock().insert(query, (std::time::Instant::now(), answer.clone()));
                        answer
                    }
                    // Too much for the budget the query declared (#603 follow-up): ask for each
                    // quarter on its own, so every part stays small enough for a busy server.
                    Err(Failure::TooBig(why)) if halved < OVERPASS_HALVINGS => {
                        tracing::info!("OpenStreetMap: {why}; asking for the part in quarters");
                        for quarter in osm::quarters(tile).into_iter().rev() {
                            todo.push_front((quarter, halved + 1));
                        }
                        continue;
                    }
                    Err(Failure::TooBig(why) | Failure::Down(why)) => return Err(why),
                }
            }
        };
        done += 1;
        merged.add(answer);
    }
    Ok(merged.answer())
}

/// Why one Overpass query gave no answer.
#[derive(Debug)]
enum Failure {
    /// The server ran it and stopped: the query needed more time or memory than it declared.
    TooBig(String),
    /// No server answered it.
    Down(String),
}

/// How many times a part that is too big for its declared budget is cut in quarters (1.2 km,
/// 600 m, 300 m a side).
const OVERPASS_HALVINGS: u32 = 2;

/// The error Overpass puts in a successful answer when it stopped a query part-way (#603
/// follow-up): `"remark": "runtime error: Query run out of memory ..."` or `"... timed out ..."`.
/// The elements are then missing or cut short, so the answer must not be used.
pub fn runtime_error(answer: &Value) -> Option<String> {
    let remark = answer.get("remark")?.as_str()?;
    remark.contains("runtime error").then(|| remark.trim().to_string())
}

/// The Overpass servers of one fetch, and when each may be asked again (#603).
struct Servers {
    urls: Vec<String>,
    rest_until: Vec<tokio::time::Instant>,
    /// The server that answered last: the next part starts there, so a silent one costs once.
    current: usize,
}

impl Servers {
    fn new(urls: Vec<String>) -> Self {
        let now = tokio::time::Instant::now();
        Self { rest_until: vec![now; urls.len()], urls, current: 0 }
    }

    /// The next server to ask, from the current one on: the first that is not resting, or the one
    /// that rests the shortest, with how long it still rests.
    fn next(&self) -> (usize, std::time::Duration) {
        let now = tokio::time::Instant::now();
        let order = (0..self.urls.len()).map(|k| (self.current + k) % self.urls.len());
        let index =
            order.clone().find(|&i| self.rest_until[i] <= now).unwrap_or_else(|| order.min_by_key(|&i| self.rest_until[i]).unwrap_or(0));
        (index, self.rest_until[index].saturating_duration_since(now))
    }

    fn rest(&mut self, index: usize, how_long: std::time::Duration) {
        self.rest_until[index] = self.rest_until[index].max(tokio::time::Instant::now() + how_long);
    }
}

/// How long a server's `/api/status` text says to wait for one of our slots, in seconds: none
/// when a slot is free or there is no limit, else the soonest "in N seconds".
pub fn slot_wait(status: &str) -> Option<u64> {
    if status.lines().any(|l| l.trim() == "Rate limit: 0") {
        return None;
    }
    if status.lines().any(|l| l.trim_end().ends_with("slots available now.") && !l.trim_start().starts_with("0 ")) {
        return None;
    }
    status
        .lines()
        .filter(|l| l.starts_with("Slot available after:"))
        .filter_map(|l| l.rsplit_once(", in ").and_then(|(_, rest)| rest.split_whitespace().next()?.parse::<i64>().ok()))
        .min()
        .map(|seconds| seconds.max(0) as u64)
}

/// Waits for a free slot when the server says when one frees (#603), instead of asking blind and
/// getting 429. A server without the status page, or one that does not answer it, is just asked.
async fn wait_for_slot(client: &reqwest::Client, url: &str, server: &str, plain: &str, say: &(dyn Fn(String) + Send + Sync)) {
    let Some(status_url) = url.strip_suffix("/interpreter").map(|base| format!("{base}/status")) else { return };
    let ask = client.get(&status_url).timeout(std::time::Duration::from_secs(5)).send();
    let Ok(Ok(response)) = tokio::time::timeout(std::time::Duration::from_secs(6), ask).await else { return };
    if !response.status().is_success() {
        return;
    }
    let Ok(text) = response.text().await else { return };
    if let Some(seconds) = slot_wait(&text) {
        let seconds = seconds.min(OVERPASS_SLOT_WAIT) + 1;
        say(format!("Waiting for a free turn at {plain} ({seconds} s)"));
        tracing::info!("OpenStreetMap: {server} has no free slot for us, waiting {seconds} s");
        tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
    }
}

/// One Overpass query, tried on the servers in turn. A server that refuses (429) rests at least
/// 30 s, a busy or silent one a few seconds, and the next server is asked meanwhile. Returns
/// the answer; the server that gave it becomes the current one.
async fn ask_one(
    client: &reqwest::Client,
    servers: &mut Servers,
    query: &str,
    say: &(dyn Fn(String) + Send + Sync),
) -> Result<Value, Failure> {
    let mut last = String::new();
    for attempt in 0..OVERPASS_TRIES {
        let (index, resting) = servers.next();
        let url = servers.urls[index].clone();
        let server = server_name(&url);
        // People see the service, not the host (#712): the main server is "OpenStreetMap", the others its mirrors.
        let plain = if index == 0 { "OpenStreetMap" } else { "an OpenStreetMap mirror" };
        let again = if attempt > 0 { format!(", try {} of {OVERPASS_TRIES}", attempt + 1) } else { String::new() };
        if !resting.is_zero() {
            say(format!("OpenStreetMap is busy; asking again in {} s{again}", resting.as_secs().max(1)));
            tokio::time::sleep(resting).await;
        }
        wait_for_slot(client, &url, &server, plain, say).await;
        say(format!("Asking {plain}{again}"));
        match tokio::time::timeout(OVERPASS_FIRST_BYTE, client.post(&url).form(&[("data", query)]).send()).await {
            Err(_) => {
                last = format!("{server} did not answer within {} s", OVERPASS_FIRST_BYTE.as_secs());
                servers.rest(index, OVERPASS_REST_BUSY);
            }
            Ok(Err(e)) => {
                last = format!("{server}: {e}");
                servers.rest(index, OVERPASS_REST_BUSY);
            }
            Ok(Ok(response)) if response.status().is_success() => match tokio::time::timeout(OVERPASS_BODY, response.json::<Value>()).await
            {
                Ok(Ok(value)) => {
                    servers.current = index;
                    if let Some(error) = runtime_error(&value) {
                        return Err(Failure::TooBig(format!("{server} stopped the query: {error}")));
                    }
                    return Ok(value);
                }
                Ok(Err(e)) => {
                    last = format!("{server}: {e}");
                    servers.rest(index, OVERPASS_REST_BUSY);
                }
                Err(_) => {
                    last = format!("{server} stopped part-way through its answer");
                    servers.rest(index, OVERPASS_REST_BUSY);
                }
            },
            Ok(Ok(response)) if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                let asked = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok()?.trim().parse::<u64>().ok())
                    .map_or(OVERPASS_REST_429, std::time::Duration::from_secs);
                last = format!("{server} answered 429: we asked too often, so it rests {} s", asked.max(OVERPASS_REST_429).as_secs());
                servers.rest(index, asked.max(OVERPASS_REST_429));
            }
            Ok(Ok(response)) => {
                last = format!("{server} answered {}", response.status());
                servers.rest(index, OVERPASS_REST_BUSY);
            }
        }
        tracing::info!("OpenStreetMap try {} of {OVERPASS_TRIES} failed: {last}", attempt + 1);
    }
    Err(Failure::Down(last))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_free_slot_means_no_wait() {
        let status = "Connected as: 1\nCurrent time: 2026-11-26T15:00:00Z\nRate limit: 2\n2 slots available now.\nCurrently running queries (pid, space limit, time limit, start time):\n";
        assert_eq!(slot_wait(status), None);
        assert_eq!(slot_wait("Rate limit: 0\nCurrently running queries:\n"), None);
    }

    #[test]
    fn a_busy_server_says_when_a_slot_frees() {
        let status = "Rate limit: 2\nSlot available after: 2026-11-26T15:00:12Z, in 12 seconds.\nSlot available after: 2026-11-26T15:00:40Z, in 40 seconds.\nCurrently running queries (pid, space limit, time limit, start time):\n";
        assert_eq!(slot_wait(status), Some(12));
        assert_eq!(slot_wait("Rate limit: 2\n1 slots available now.\nSlot available after: x, in 9 seconds.\n"), None);
        assert_eq!(slot_wait("not a status page"), None);
    }

    #[test]
    fn a_refusing_server_rests_and_the_next_is_asked() {
        let mut servers = Servers::new(vec!["a".into(), "b".into()]);
        assert_eq!(servers.next().0, 0);
        servers.rest(0, OVERPASS_REST_429);
        assert_eq!(servers.next(), (1, std::time::Duration::ZERO));
        servers.rest(1, OVERPASS_REST_BUSY);
        let (index, wait) = servers.next();
        assert_eq!(index, 1, "the one that rests the shortest");
        assert!(wait > std::time::Duration::ZERO && wait <= OVERPASS_REST_BUSY);
    }

    /// A stand-in Overpass server: its status page says `status`, and each query gets `code`
    /// with `body`. Returns its interpreter URL and how many queries it got.
    async fn stand_in(status: &'static str, code: u16, body: Value) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = asked.clone();
        let app = axum::Router::new().route("/api/status", axum::routing::get(move || async move { status })).route(
            "/api/interpreter",
            axum::routing::post(move || {
                let (count, body) = (count.clone(), body.clone());
                async move {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    (axum::http::StatusCode::from_u16(code).unwrap(), axum::Json(body))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/interpreter", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (url, asked)
    }

    #[tokio::test]
    async fn too_many_requests_moves_on_and_leaves_that_server_alone() {
        let free = "Rate limit: 2\n2 slots available now.\n";
        let (refusing, refused) = stand_in(free, 429, serde_json::json!({})).await;
        let (answering, answered) = stand_in(free, 200, serde_json::json!({ "elements": [] })).await;
        let client = reqwest::Client::new();
        let mut servers = Servers::new(vec![refusing, answering]);
        let said = parking_lot::Mutex::new(Vec::new());
        let say = |words: String| said.lock().push(words);
        let started = std::time::Instant::now();
        for _ in 0..3 {
            ask_one(&client, &mut servers, "[out:json];node(1);out;", &say).await.unwrap();
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "no wait while another server is free");
        use std::sync::atomic::Ordering::SeqCst;
        assert_eq!((refused.load(SeqCst), answered.load(SeqCst)), (1, 3), "the refusing server is asked once, then rests");
        assert!(servers.rest_until[0] > tokio::time::Instant::now() + std::time::Duration::from_secs(25));
    }

    #[tokio::test]
    async fn a_server_with_no_free_slot_is_waited_for() {
        let (url, asked) = stand_in(
            "Rate limit: 2\nSlot available after: 2026-11-26T15:00:01Z, in 1 seconds.\n",
            200,
            serde_json::json!({ "elements": [] }),
        )
        .await;
        let client = reqwest::Client::new();
        let mut servers = Servers::new(vec![url]);
        let said = parking_lot::Mutex::new(Vec::new());
        let say = |words: String| said.lock().push(words);
        let started = std::time::Instant::now();
        ask_one(&client, &mut servers, "[out:json];node(1);out;", &say).await.unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_secs(2), "waited for the slot");
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(said.lock().iter().any(|w| w.starts_with("Waiting for a free turn at OpenStreetMap (2 s)")), "{:?}", said.lock());
    }

    #[test]
    fn a_query_stopped_part_way_is_not_an_answer() {
        let stopped = serde_json::json!({ "remark": "runtime error: Query run out of memory using about 64 MB of RAM.", "elements": [] });
        assert!(runtime_error(&stopped).unwrap().contains("out of memory"));
        assert_eq!(runtime_error(&serde_json::json!({ "elements": [] })), None);
        assert_eq!(runtime_error(&serde_json::json!({ "remark": "runtime remark: Timeout is 60 seconds.", "elements": [] })), None);
    }

    #[tokio::test]
    async fn a_part_too_big_for_its_budget_is_asked_in_quarters() {
        // Runs out of memory for anything wider than 0.005 degrees; answers smaller parts with one
        // node each, whose id says which part asked.
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = asked.clone();
        let app = axum::Router::new().route(
            "/api/interpreter",
            axum::routing::post(move |body: String| {
                let count = count.clone();
                async move {
                    let n = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) as i64;
                    let query = body.replace("%28", "(").replace("%29", ")").replace("%2C", ",");
                    let inside = query.split_once('(').and_then(|(_, rest)| rest.split_once(')')).map(|(b, _)| b.to_string()).unwrap_or_default();
                    let b: Vec<f64> = inside.split(',').filter_map(|v| v.parse().ok()).collect();
                    if b.len() == 4 && b[3] - b[1] > 0.005 {
                        return axum::Json(serde_json::json!({ "remark": "runtime error: Query run out of memory using about 64 MB of RAM.", "elements": [] }));
                    }
                    axum::Json(serde_json::json!({ "elements": [{ "type": "node", "id": n, "lat": 0.0, "lon": 0.0 }] }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/interpreter", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        // About 550 m a side: one tile, too big; its quarters (about 0.004 degrees wide) fit.
        let bounds = [57.700, 11.970, 57.705, 11.979];
        let query_for = |b: [f64; 4]| format!("[out:json];node({:.6},{:.6},{:.6},{:.6});out;", b[0], b[1], b[2], b[3]);
        let answer = ask_servers(vec![url], &query_for, bounds, &|_| {}).await.unwrap();
        assert_eq!(answer["elements"].as_array().unwrap().len(), 4, "{answer}");
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 5, "the whole part once, then each quarter");
    }
}
