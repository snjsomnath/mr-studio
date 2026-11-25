//! `mrstudio`: run, check and prepare MR Studio sites.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context};
use clap::{Parser, Subcommand};
use mrs_engine::{Backend, Engine, EngineConfig, JobState};
use mrs_host::HostConfig;
use mrs_site::Site;
use serde_json::json;

mod layer;

#[derive(Parser)]
#[command(name = "mrstudio", version, about = "MR Studio command line")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the host for a site. With the web dev server this is the layer dev mode.
    Dev {
        #[arg(long, default_value = "sites/sample")]
        site: PathBuf,
        /// Folder with the core layer packages.
        #[arg(long, default_value = "packages/layers")]
        layers: PathBuf,
        /// Built surfaces to serve (packages/runtime/dist).
        #[arg(long)]
        web: Option<PathBuf>,
        #[arg(long, default_value_t = 4170)]
        port: u16,
        /// Listen on the local network so phones can join.
        #[arg(long)]
        lan: bool,
        /// The address phones reach this host at, when it is not this machine's own
        /// (a dev server or a relay in front of it), for example http://192.168.1.20:5173.
        #[arg(long)]
        public_url: Option<String>,
        /// auto, gpu or cpu.
        #[arg(long, default_value = "auto")]
        backend: String,
        /// A phone relay to join through (#89), such as https://relay.example.org. Its token
        /// is read from MRS_RELAY_TOKEN. Without it the relay in Sources and keys is used, if any.
        #[arg(long)]
        relay: Option<String>,
    },
    /// Rewrite a site's site.json for this version's site format. The original is kept beside it.
    Migrate { site: PathBuf },
    /// Pack a table into one .mrstable file to open on another computer. No keys go with it.
    Export {
        site: PathBuf,
        /// The file to write, for example Lindholmen.mrstable.
        #[arg(long)]
        out: PathBuf,
        /// Folder with the core layer packages.
        #[arg(long, default_value = "packages/layers")]
        layers: PathBuf,
    },
    /// Make a starter pack (#450): the table's outline, tiles, buildings, streets, projection
    /// area and at-a-glance boxes as files for QGIS, Illustrator, Photoshop and PowerPoint, with
    /// instructions, in one zip.
    StarterPack {
        site: PathBuf,
        /// The zip to write, for example "Lindholmen starter pack.zip".
        #[arg(long)]
        out: PathBuf,
        /// Comma-separated: table, tiles, buildings, streets, projection, glance. Default: the first four.
        #[arg(long, value_delimiter = ',')]
        features: Vec<String>,
        /// Comma-separated: qgis, illustrator, photoshop, powerpoint. Default: all.
        #[arg(long, value_delimiter = ',')]
        apps: Vec<String>,
        /// table (exactly the table's frame, comes back in place) or projection (with the margins).
        #[arg(long, default_value = "table")]
        canvas: String,
        /// Picture resolution, pixels per centimetre of table.
        #[arg(long, default_value_t = 20.0)]
        px_per_cm: f64,
        /// Print what was written as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Open a .mrstable file as a new table folder in a sites folder.
    Import {
        file: PathBuf,
        /// The sites folder to unpack into.
        #[arg(long, default_value = "sites")]
        into: PathBuf,
    },
    /// Check a site package and report what the scene bake produces.
    Validate { site: PathBuf },
    /// Bake the scene and write the rasters to `<site>/scene/` for inspection.
    Prepare { site: PathBuf },
    /// Create a new site package with a valid site.json.
    NewSite {
        /// Folder to create, for example sites/lindholmen.
        dir: PathBuf,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        lon: f64,
        #[arg(long)]
        lat: f64,
        #[arg(long, default_value_t = 1000.0)]
        width_m: f64,
        #[arg(long, default_value_t = 600.0)]
        height_m: f64,
        #[arg(long, default_value_t = 0.0, allow_hyphen_values = true)]
        rotation_deg: f64,
    },
    /// A site's own code layers (#277): make one, or build them for the app to load.
    Layer {
        #[command(subcommand)]
        action: LayerCommand,
    },
    /// Bring data into a site, as the editor's Add data does (#320): a file, OpenStreetMap,
    /// free elevation, a picture or video, a sound. Prints JSON with `--json`.
    Data {
        #[command(subcommand)]
        action: DataCommand,
    },
    /// Time a kernel on a site with each backend.
    Bench {
        #[arg(default_value = "sites/sample")]
        site: PathBuf,
    },
}

#[derive(Subcommand)]
enum DataCommand {
    /// Read and check a dataset, and with `--write` save it into the site and wire it into
    /// site.json. Targets: buildings, trees, walkways, trips, terrain or data:<name>.
    Add {
        site: PathBuf,
        #[arg(long)]
        target: String,
        /// A GeoJSON, CSV, Shapefile (zipped) or GeoTIFF file. Leave out with --osm or --elevation.
        #[arg(long)]
        file: Option<PathBuf>,
        /// Fetch it from OpenStreetMap for the table's area (buildings, trees, walkways, data:roads).
        #[arg(long)]
        osm: bool,
        /// Fetch free elevation for the ground (terrain).
        #[arg(long)]
        elevation: bool,
        /// Save it; without this only the report is printed and nothing changes.
        #[arg(long)]
        write: bool,
        /// Leave out what lies well outside the table.
        #[arg(long)]
        crop: bool,
        /// Read the first coordinate as latitude.
        #[arg(long)]
        swap: bool,
        /// The terrain has the buildings raised in it: set the ground under them back.
        #[arg(long)]
        flatten: bool,
        /// The coordinate system of a terrain GeoTIFF that does not say, such as EPSG:3006.
        #[arg(long)]
        crs: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Copy a picture (PNG, JPEG, WebP, GIF) or video (MP4, WebM) into data/media/.
    Media {
        site: PathBuf,
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Copy a sound (WAV, MP3, OGG, M4A) into data/sounds/.
    Sound {
        site: PathBuf,
        file: PathBuf,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum LayerCommand {
    /// Create `<site>/layers/<id>/`: layer.json, src/index.ts, Swedish words and a build script.
    New {
        /// The layer's id, for example energy-flows.
        id: String,
        #[arg(long, default_value = ".")]
        site: PathBuf,
        /// Its name on buttons and in the palette. Default: from the id.
        #[arg(long)]
        name: Option<String>,
    },
    /// Bundle each site layer's src/index.ts into dist/index.js (needs Node 20+ on this computer).
    Build {
        /// Only this layer.
        id: Option<String>,
        #[arg(long, default_value = ".")]
        site: PathBuf,
        /// Rebuild on every change (one layer).
        #[arg(long)]
        watch: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Logs go to stderr, so `--json` output on stdout stays machine-readable.
    tracing_subscriber::fmt().with_target(false).with_writer(std::io::stderr).init();
    match Cli::parse().command {
        Command::Dev { site, layers, web, port, lan, public_url, backend, relay } => {
            let backend = Backend::parse(&backend).context("backend must be auto, gpu or cpu")?;
            let ip = if lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
            let host = mrs_host::start(HostConfig {
                site_dir: site,
                layers_dir: layers,
                web_dir: web,
                bind: SocketAddr::from((ip, port)),
                backend,
                session: mrs_host::SessionOptions { public_url, ..Default::default() },
                sources: std::sync::Arc::new(open_sources()),
            })
            .await?;
            if let Some(url) = relay {
                let token = std::env::var("MRS_RELAY_TOKEN").context("--relay needs the relay's token in MRS_RELAY_TOKEN")?;
                host.connect_relay(mrs_host::relay::RelayLink { url, authorization: format!("Bearer {token}") });
            }
            let code = host.state.hub.session().code;
            tracing::info!("host listening on http://{} (session code {code})", host.addr);
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = host.wait() => {}
            }
            Ok(())
        }
        Command::Migrate { site } => migrate(&site),
        Command::Export { site, out, layers } => export(site, &out, layers).await,
        Command::Import { file, into } => import(&file, &into),
        Command::StarterPack { site, out, features, apps, canvas, px_per_cm, json } => {
            starter_pack(&site, &out, &features, &apps, &canvas, px_per_cm, json)
        }
        Command::Validate { site } => validate(&site).map(|_| ()),
        Command::Prepare { site } => prepare(&site),
        Command::NewSite { dir, name, lon, lat, width_m, height_m, rotation_deg } => {
            new_site(&dir, name, lon, lat, width_m, height_m, rotation_deg)
        }
        Command::Bench { site } => bench(&site),
        Command::Layer { action: LayerCommand::New { id, site, name } } => {
            let dir = layer::new(&site, &id, name.as_deref())?;
            println!("Made {}. Build it with `mrstudio layer build {id} --site {}`.", dir.display(), site.display());
            Ok(())
        }
        Command::Layer { action: LayerCommand::Build { id, site, watch } } => layer::build(&site, id.as_deref(), watch),
        Command::Data { action } => data(action).await,
    }
}

/// The desktop app's sources, so keys added in its Sources page work here too. Keys stay
/// in the operating system's keychain. `MRS_SOURCES` names another sources.json.
fn open_sources() -> mrs_host::Sources {
    use mrs_host::sources::{app_config_dir, Keychain, Sources};
    let path = std::env::var_os("MRS_SOURCES").map(PathBuf::from).or_else(|| app_config_dir().map(|d| d.join("sources.json")));
    match path.map(|p| (Sources::open(p.clone(), Box::new(Keychain)), p)) {
        Some((Ok(sources), path)) => {
            tracing::info!("sources from {}", path.display());
            sources
        }
        Some((Err(e), path)) => {
            tracing::warn!("{} could not be read ({e}); no sources", path.display());
            Sources::in_memory()
        }
        None => Sources::in_memory(),
    }
}

/// Starts the table's host for a moment, so the package lists the sources its layers use.
async fn export(site: PathBuf, out: &Path, layers: PathBuf) -> anyhow::Result<()> {
    let host = mrs_host::start(HostConfig {
        site_dir: site,
        layers_dir: layers,
        web_dir: None,
        bind: SocketAddr::from(([127, 0, 0, 1], 0)),
        backend: Backend::Cpu,
        session: mrs_host::SessionOptions::default(),
        sources: std::sync::Arc::new(open_sources()),
    })
    .await?;
    let exported = host.state.export_table(out, env!("CARGO_PKG_VERSION"));
    host.stop(std::time::Duration::from_secs(2)).await;
    let exported = exported.map_err(anyhow::Error::msg)?;
    println!("Wrote {} ({} files, {} bytes).", exported.path.display(), exported.files, exported.bytes);
    for left in &exported.left_out {
        println!("  left out {left} (it looks like a key or a link outside the table)");
    }
    print_sources(&exported.sources, "The other computer needs these sources, set up in Sources and keys:");
    Ok(())
}

fn import(file: &Path, into: &Path) -> anyhow::Result<()> {
    let imported = mrs_site::package::import(file, into)?;
    println!("Opened '{}' as {} ({} files).", imported.name, imported.dir.display(), imported.files);
    if let Some(upgraded) = &imported.upgraded {
        println!("  {upgraded}");
    }
    let missing = mrs_host::missing_sources(&open_sources(), &imported.sources);
    print_sources(&missing, "Not set up on this computer yet (add them in Sources and keys):");
    for problem in &imported.problems {
        println!("  problem: {problem}");
    }
    Ok(())
}

fn print_sources(sources: &[mrs_site::package::SourceNeed], heading: &str) {
    if sources.is_empty() {
        return;
    }
    println!("{heading}");
    for s in sources {
        let name = if s.name.is_empty() { s.id.clone() } else { format!("{} ({})", s.name, s.id) };
        println!("  {name}: used by {}", s.layers.join(", "));
    }
}

fn migrate(dir: &Path) -> anyhow::Result<()> {
    match mrs_site::migrate::upgrade_site(dir)? {
        None => println!("{} is already site format {}.", dir.display(), mrs_site::FORMAT),
        Some(done) => {
            println!("Upgraded {} from site format {} to {}:", dir.display(), done.from, done.to);
            for change in &done.changes {
                println!("  {change}");
            }
            println!("The original is kept as site.format-{}.json.", done.from);
        }
    }
    Ok(())
}

fn validate(dir: &Path) -> anyhow::Result<(Site, mrs_engine::SceneData)> {
    let site = Site::load(dir)?;
    let started = Instant::now();
    let (scene, stats) = site.bake()?;
    let grid = scene.grid;
    println!("{} ({})", site.manifest.name, site.manifest.id);
    println!("  grid       {} x {} cells at {} m, rotation {} deg", grid.width, grid.height, grid.cell_m, grid.rotation_deg);
    println!(
        "  buildings  {} ({} without a height, {} outside the extent)",
        stats.buildings, stats.buildings_without_height, stats.buildings_outside
    );
    if site.manifest.scene.mesh.is_some() {
        println!("  mesh       {} triangles covering {:.1}% of cells", stats.mesh_triangles, stats.mesh_coverage * 100.0);
    }
    if stats.terrain_missing_cells > 0 {
        println!("  terrain    {} cells are outside the terrain raster and took its lowest elevation", stats.terrain_missing_cells);
    }
    println!("  trees      {}", stats.trees);
    if site.manifest.scene.water.is_some() {
        println!("  water      {:.1}% of cells", stats.water_fraction * 100.0);
    }
    if stats.terrain_flattened_cells > 0 {
        println!("  terrain    {} cells under footprints set to the ground beside them", stats.terrain_flattened_cells);
    }
    println!("  built area {:.1}% of cells, highest point {:.1} m", stats.solid_fraction * 100.0, stats.max_height_m);
    let layer = |l: &mrs_site::LayerRef| {
        let name = if l.id == mrs_site::LayerRef::default_id(&l.r#use) { l.id.clone() } else { format!("{} ({})", l.id, l.r#use) };
        let items: Vec<&str> = l.items.iter().map(|i| i.id.as_str()).collect();
        let steps = l.steps.as_ref().map_or(0, |s| s.sequence.len());
        match (items.is_empty(), steps) {
            (true, 0) => name,
            (true, n) => format!("{name} [{n} steps]"),
            (false, 0) => format!("{name} [+ {}]", items.join(", ")),
            (false, n) => format!("{name} [+ {}; {n} steps]", items.join(", ")),
        }
    };
    println!("  layers     {}", site.manifest.layers.iter().map(layer).collect::<Vec<_>>().join(", "));
    if !site.manifest.custom.is_empty() {
        println!("  custom     {}", site.manifest.custom.keys().cloned().collect::<Vec<_>>().join(", "));
    }
    println!("  baked in {:.0} ms", started.elapsed().as_secs_f64() * 1e3);
    if stats.buildings == 0 && site.manifest.scene.buildings.is_some() {
        bail!("no building falls inside the extent; check origin and extent");
    }
    if site.manifest.scene.mesh.is_some() && stats.mesh_coverage == 0.0 {
        bail!("the mesh does not touch the extent; check its anchor, unit_m and bearing_deg");
    }
    Ok((site, scene))
}

fn prepare(dir: &Path) -> anyhow::Result<()> {
    let (site, scene) = validate(dir)?;
    let out = site.dir.join("scene");
    std::fs::create_dir_all(&out)?;
    for (name, raster) in [("dtm", &scene.dtm), ("dsm", &scene.dsm), ("canopy", &scene.canopy)] {
        let bytes: Vec<u8> = raster.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(out.join(format!("{name}.f32")), bytes)?;
    }
    let meta =
        json!({ "grid": scene.grid, "rasters": ["dtm", "dsm", "canopy"], "encoding": "f32 little endian, row-major, row 0 at the top" });
    std::fs::write(out.join("scene.json"), serde_json::to_string_pretty(&meta)?)?;
    println!("  wrote {}", out.display());
    Ok(())
}

fn new_site(dir: &Path, name: Option<String>, lon: f64, lat: f64, width_m: f64, height_m: f64, rotation_deg: f64) -> anyhow::Result<()> {
    let fallback = dir.file_name().and_then(|n| n.to_str()).context("the folder needs a name")?.to_string();
    mrs_site::create::create(dir, &name.unwrap_or(fallback), lon, lat, width_m, height_m, rotation_deg)?;
    println!("Created {}.", dir.display());
    println!("Next: put building footprints (GeoJSON, WGS84, with a height property) in {}/data/", dir.display());
    println!("and add \"buildings\": {{ \"path\": \"data/buildings.geojson\" }} under \"scene\" in site.json.");
    Ok(())
}

fn bench(dir: &Path) -> anyhow::Result<()> {
    let (site, scene) = validate(dir)?;
    let origin = site.manifest.origin;
    for backend in [Backend::Gpu, Backend::Cpu] {
        let mut engine = match Engine::new(EngineConfig { backend }) {
            Ok(engine) => engine,
            Err(e) => {
                println!("{backend:?}: {e}");
                continue;
            }
        };
        engine.load_scene(scene.clone())?;
        let adapter = engine.info().adapter.unwrap_or_else(|| format!("cpu reference, {} threads", engine.context().threads));
        for (mode, field) in [("instant", "shadow"), ("day", "sun_hours")] {
            let params = json!({ "mode": mode, "time": "2026-06-21T09:00:00Z", "lat": origin.lat, "lon": origin.lon });
            let started = Instant::now();
            let job = engine.create_job("sunlight", &params)?;
            while engine.step(job, Duration::from_secs(1))?.state != JobState::Done {}
            engine.read_field(job, field)?;
            println!("  sunlight {mode:8} {:>8.1} ms  [{adapter}]", started.elapsed().as_secs_f64() * 1e3);
            engine.drop_job(job);
        }
        let job = engine.create_job("wind", &json!({}))?;
        let started = Instant::now();
        let mut status = engine.step(job, Duration::from_millis(50))?;
        while started.elapsed() < Duration::from_secs(3) && status.state != JobState::Done {
            status = engine.step(job, Duration::from_millis(50))?;
        }
        let rate = status.info["steps"].as_u64().unwrap_or(0) as f64 / started.elapsed().as_secs_f64();
        let domain = &status.info["lattice"]["domain"];
        println!("  wind     {rate:>8.0} steps/s on a {} x {} lattice  [{adapter}]", domain[0], domain[1]);
        engine.drop_job(job);
        let job = engine.create_job("stormwater", &json!({ "pace": "fast" }))?;
        let started = Instant::now();
        let mut status = engine.step(job, Duration::from_millis(50))?;
        while started.elapsed() < Duration::from_secs(3) && status.state != JobState::Done {
            status = engine.step(job, Duration::from_millis(50))?;
        }
        let elapsed = started.elapsed().as_secs_f64();
        let rate = status.info["steps"].as_u64().unwrap_or(0) as f64 / elapsed;
        let storm = status.info["seconds"].as_f64().unwrap_or(0.0) / elapsed;
        let lattice = &status.info["lattice"];
        println!(
            "  storm    {rate:>8.0} steps/s, {storm:.0}x real time on a {} x {} lattice  [{adapter}]",
            lattice["width"], lattice["height"]
        );
        engine.drop_job(job);
    }
    Ok(())
}

/// `mrstudio data …`: the editor's Add data from the command line (#320). A refusal is printed
/// as the report (or `{ "error" }`) and exits with status 1; nothing is written then.
async fn data(action: DataCommand) -> anyhow::Result<()> {
    use mrs_site::import::{Options, Target};
    let print = |json: bool, value: serde_json::Value, words: String| {
        if json {
            println!("{value}");
        } else {
            println!("{words}");
        }
    };
    let refuse = |json: bool, value: serde_json::Value, words: String| -> anyhow::Result<()> {
        print(json, value, words);
        std::process::exit(1);
    };
    match action {
        DataCommand::Add { site, target, file, osm, elevation, write, crop, swap, flatten, crs, json } => {
            let parsed = Target::parse(&target).map_err(anyhow::Error::msg)?;
            let crs = match crs.as_deref().map(|c| c.trim().trim_start_matches("EPSG:").trim_start_matches("epsg:").parse::<u32>()) {
                None => None,
                Some(Ok(code)) => Some(code),
                Some(Err(_)) => bail!("--crs must look like EPSG:3006"),
            };
            let (bytes, filename) = match (file, osm, elevation) {
                (Some(path), false, false) => {
                    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
                    if bytes.len() > mrs_host::MAX_IMPORT_BYTES {
                        bail!("{} is larger than {} MB", path.display(), mrs_host::MAX_IMPORT_BYTES / 1_048_576);
                    }
                    (bytes, path.file_name().and_then(|n| n.to_str()).unwrap_or("data").to_string())
                }
                (None, true, false) => match mrs_host::data::osm_for(&site, &parsed).await {
                    Ok(bytes) => (bytes, "openstreetmap.geojson".to_string()),
                    Err(report) => return refuse(json, serde_json::to_value(&report)?, report.summary.clone()),
                },
                (None, false, true) => match mrs_host::data::elevation_for(&site, &parsed).await {
                    Ok(bytes) => (bytes, "free-elevation.tif".to_string()),
                    Err(report) => return refuse(json, serde_json::to_value(&report)?, report.summary.clone()),
                },
                _ => bail!("give one of --file, --osm or --elevation"),
            };
            let site_dir = site.clone();
            let mut report = tokio::task::spawn_blocking(move || {
                mrs_host::data::import_file(&site_dir, &target, &filename, &bytes, Options { crop, swap, crs, flatten }, write)
            })
            .await?
            .map_err(anyhow::Error::msg)?;
            if elevation {
                mrs_host::data::elevation_note(&mut report);
            }
            let words = format!("{}{}", report.summary, if report.ok && !write { " (checked only; add --write to save it)" } else { "" });
            if !report.ok {
                return refuse(json, serde_json::to_value(&report)?, words);
            }
            print(json, serde_json::to_value(&report)?, words);
            Ok(())
        }
        DataCommand::Media { site, file, json } => keep(&site, &file, json, mrs_site::media::save),
        DataCommand::Sound { site, file, json } => keep(&site, &file, json, mrs_site::sound::save),
    }
}

/// Copies a picture, video or sound into the site with the same checks as the editor.
fn keep(site: &Path, file: &Path, json: bool, save: fn(&Path, &str, &[u8]) -> Result<String, String>) -> anyhow::Result<()> {
    if !site.join("site.json").exists() {
        bail!("{} has no site.json", site.display());
    }
    let bytes = std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    match save(site, name, &bytes) {
        Ok(path) => {
            if json {
                println!("{}", json!({ "path": path }));
            } else {
                println!("Saved {path}");
            }
            Ok(())
        }
        Err(error) => {
            if json {
                println!("{}", json!({ "error": error }));
                std::process::exit(1);
            }
            bail!(error)
        }
    }
}

/// `mrstudio starter-pack` (#450).
fn starter_pack(
    site: &Path,
    out: &Path,
    features: &[String],
    apps: &[String],
    canvas: &str,
    px_per_cm: f64,
    json: bool,
) -> anyhow::Result<()> {
    use mrs_site::starter::{self, Options};
    let mut options = Options { px_per_cm, ..Options::default() };
    let words = |list: &[String]| serde_json::Value::from(list.iter().map(|s| s.trim().to_ascii_lowercase()).collect::<Vec<_>>());
    if !features.is_empty() {
        options.features = serde_json::from_value(words(features)).map_err(|e| anyhow::anyhow!("--features: {e}"))?;
    }
    if !apps.is_empty() {
        options.apps = serde_json::from_value(words(apps)).map_err(|e| anyhow::anyhow!("--apps: {e}"))?;
    }
    options.canvas =
        serde_json::from_value(serde_json::Value::from(canvas.to_ascii_lowercase())).map_err(|e| anyhow::anyhow!("--canvas: {e}"))?;
    let result =
        mrs_site::Site::load(site).map_err(anyhow::Error::from).and_then(|s| starter::write(&s, &options, out).map_err(anyhow::Error::msg));
    match (result, json) {
        (Ok(written), true) => println!("{}", serde_json::to_string(&serde_json::json!({ "ok": true, "path": out, "written": written }))?),
        (Ok(written), false) => {
            println!("Wrote {} ({} files, {} KB).", out.display(), written.files.len(), written.bytes.div_ceil(1024));
            for note in written.notes {
                println!("  {note}");
            }
        }
        (Err(e), true) => println!("{}", serde_json::to_string(&serde_json::json!({ "ok": false, "error": format!("{e:#}") }))?),
        (Err(e), false) => return Err(e),
    }
    Ok(())
}
