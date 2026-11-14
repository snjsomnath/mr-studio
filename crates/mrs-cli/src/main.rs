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
    /// Time a kernel on a site with each backend.
    Bench {
        #[arg(default_value = "sites/sample")]
        site: PathBuf,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    match Cli::parse().command {
        Command::Dev { site, layers, web, port, lan, public_url, backend } => {
            let backend = Backend::parse(&backend).context("backend must be auto, gpu or cpu")?;
            let ip = if lan { [0, 0, 0, 0] } else { [127, 0, 0, 1] };
            let host = mrs_host::start(HostConfig {
                site_dir: site,
                layers_dir: layers,
                web_dir: web,
                bind: SocketAddr::from((ip, port)),
                backend,
                session: mrs_host::SessionOptions { public_url, ..Default::default() },
            })
            .await?;
            let code = &host.state.hub.session().code;
            tracing::info!("host listening on http://{} (session code {code})", host.addr);
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = host.wait() => {}
            }
            Ok(())
        }
        Command::Validate { site } => validate(&site).map(|_| ()),
        Command::Prepare { site } => prepare(&site),
        Command::NewSite { dir, name, lon, lat, width_m, height_m, rotation_deg } => {
            new_site(&dir, name, lon, lat, width_m, height_m, rotation_deg)
        }
        Command::Bench { site } => bench(&site),
    }
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
    println!("  trees      {}", stats.trees);
    println!("  built area {:.1}% of cells, highest point {:.1} m", stats.solid_fraction * 100.0, stats.max_height_m);
    println!("  layers     {}", site.manifest.layers.iter().map(|l| l.r#use.as_str()).collect::<Vec<_>>().join(", "));
    println!("  baked in {:.0} ms", started.elapsed().as_secs_f64() * 1e3);
    if stats.buildings == 0 && site.manifest.scene.buildings.is_some() {
        bail!("no building falls inside the extent; check origin and extent");
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
    if dir.exists() {
        bail!("{} already exists", dir.display());
    }
    let id = dir.file_name().and_then(|n| n.to_str()).context("the folder needs a name")?.to_lowercase().replace([' ', '_'], "-");
    std::fs::create_dir_all(dir.join("data"))?;
    let manifest = json!({
        "format": mrs_site::FORMAT,
        "id": id,
        "name": name.unwrap_or_else(|| id.clone()),
        "origin": { "lon": lon, "lat": lat },
        "extent": { "width_m": width_m, "height_m": height_m, "rotation_deg": rotation_deg },
        "timezone": "Europe/Stockholm",
        "table": { "width_cm": 100, "height_cm": (100.0 * height_m / width_m * 100.0).round() / 100.0 },
        "scene": { "cell_m": 1 },
        "basemap": { "background": "#0b0e14", "style": null },
        "layers": [{ "use": "sunlight", "active": true }],
        "branding": { "title": "MR Studio" }
    });
    std::fs::write(dir.join("site.json"), serde_json::to_string_pretty(&manifest)? + "\n")?;
    Site::load(dir)?;
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
    }
    Ok(())
}
