//! Stormwater kernel: physics on the CPU reference, job behaviour, real-time pacing and GPU/CPU parity.

use std::time::{Duration, Instant};

use mrs_engine::{testing, Backend, Engine, EngineConfig, EngineError, Field, Grid, JobId, JobState, JobStatus, SceneData};
use serde_json::{json, Value};

fn engine(backend: Backend, scene: SceneData) -> Option<Engine> {
    let mut engine = match Engine::new(EngineConfig { backend }) {
        Ok(engine) => engine,
        Err(EngineError::NoGpu(reason)) => {
            eprintln!("skipping: no GPU adapter ({reason})");
            return None;
        }
        Err(e) => panic!("{e}"),
    };
    engine.load_scene(scene).unwrap();
    Some(engine)
}

/// Ground shaped by `height(col, row)` in metres, nothing on it.
fn ground(width: u32, height: u32, cell_m: f32, shape: impl Fn(f32, f32) -> f32) -> SceneData {
    let mut scene = SceneData::flat(Grid { width, height, cell_m, rotation_deg: 0.0 });
    for row in 0..height {
        for col in 0..width {
            let i = (row * width + col) as usize;
            scene.dtm[i] = shape(col as f32, row as f32);
            scene.dsm[i] = scene.dtm[i];
        }
    }
    scene
}

/// A round bowl, 4 m deep at the centre, rising to the edges.
fn bowl(size: u32) -> SceneData {
    let c = size as f32 / 2.0;
    ground(size, size, 2.0, move |x, y| 4.0 * (((x - c) / c).powi(2) + ((y - c) / c).powi(2)).min(1.0))
}

fn fast(extra: Value) -> Value {
    let mut params = json!({ "pace": "fast", "infiltration_mm_h": 0 });
    params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    params
}

fn steps(status: &JobStatus) -> u64 {
    status.info["steps"].as_u64().unwrap()
}

/// Exactly `count` steps: a zero budget runs one step per call.
fn run_exactly(engine: &mut Engine, job: JobId, count: u64) -> JobStatus {
    let mut status = engine.step(job, Duration::ZERO).unwrap();
    for _ in 1..count {
        status = engine.step(job, Duration::ZERO).unwrap();
    }
    status
}

/// Steps until the job has done at least `count` steps or has settled.
fn run(engine: &mut Engine, job: JobId, count: u64) -> JobStatus {
    loop {
        let status = engine.step(job, Duration::from_millis(20)).unwrap();
        if steps(&status) >= count || status.state == JobState::Done {
            return status;
        }
    }
}

fn at(field: &Field, col: usize, row: usize) -> f32 {
    field.data[row * field.width as usize + col]
}

fn volume(field: &Field, cell_m: f32) -> f32 {
    field.data.iter().sum::<f32>() * cell_m * cell_m
}

#[test]
fn rain_into_a_bowl_conserves_water_and_pools_at_the_bottom() {
    // A wall around the edge, whose rain is not counted, so nothing can leave.
    let mut scene = bowl(64);
    for i in 0..64usize {
        for n in [i, 63 * 64 + i, i * 64, i * 64 + 63] {
            scene.dsm[n] = scene.dtm[n] + 10.0;
        }
    }
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let job = engine.create_job("stormwater", &fast(json!({ "rain_mm_h": 100, "resolution": 64, "roofs": false }))).unwrap();
    let status = run_exactly(&mut engine, job, 2000);
    let seconds = status.info["seconds"].as_f64().unwrap() as f32;
    let depth = engine.read_field(job, "depth").unwrap();
    assert_eq!((depth.width, depth.height), (64, 64));
    // Nothing leaves the bowl and nothing soaks in: what is on the ground is what fell.
    let fallen = 100.0 / 3_600_000.0 * seconds * (62.0 * 2.0) * (62.0 * 2.0);
    assert!((status.info["rain_m3"].as_f64().unwrap() as f32 - fallen).abs() < 1e-3 * fallen);
    let stored = volume(&depth, 2.0);
    assert!((stored - fallen).abs() < 0.01 * fallen, "stored {stored} m3, fell {fallen} m3");
    // The water has run to the bottom: the centre is far deeper than the rim.
    let (centre, rim) = (at(&depth, 32, 32), at(&depth, 32, 4));
    assert!(centre > 0.05, "the bottom of the bowl should pool, depth {centre}");
    assert!(centre > 10.0 * rim, "centre {centre} m should be much deeper than the rim {rim} m");
    // The pool's surface is close to level.
    let surface = |col: usize| at(&depth, col, 32) + 4.0 * ((col as f32 - 32.0) / 32.0).powi(2);
    assert!((surface(30) - surface(32)).abs() < 0.02, "the pool surface should be level");
}

#[test]
fn a_lake_takes_the_runoff_and_stays_off_the_flood_map() {
    // The walled bowl again, but its bottom is a lake (#343): what runs into it is gone.
    let mut scene = bowl(64);
    for i in 0..64usize {
        for n in [i, 63 * 64 + i, i * 64, i * 64 + 63] {
            scene.dsm[n] = scene.dtm[n] + 10.0;
        }
    }
    for row in 24..40usize {
        for col in 24..40usize {
            scene.water[row * 64 + col] = 1;
        }
    }
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let job = engine.create_job("stormwater", &fast(json!({ "rain_mm_h": 100, "resolution": 64, "roofs": false }))).unwrap();
    run_exactly(&mut engine, job, 2000);
    let depth = engine.read_field(job, "depth").unwrap();
    assert_eq!(at(&depth, 32, 32), 0.0, "the lake is not flooded ground");
    let status = engine.step(job, Duration::ZERO).unwrap();
    let fallen = status.info["rain_m3"].as_f64().unwrap() as f32;
    assert!(volume(&depth, 2.0) < 0.5 * fallen, "most of the rain should have run into the lake");
}

#[test]
fn water_runs_downhill_and_leaves_at_the_edge() {
    // Falls 1 m in 20 towards the right of the table.
    let scene = ground(80, 40, 2.0, |x, _| 8.0 - 0.1 * x);
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let job = engine.create_job("stormwater", &fast(json!({ "rain_mm_h": 120, "resolution": 80 }))).unwrap();
    let status = run_exactly(&mut engine, job, 3000);
    let (u, v) = (engine.read_field(job, "u").unwrap(), engine.read_field(job, "v").unwrap());
    let depth = engine.read_field(job, "depth").unwrap();
    let mean = |f: &Field| f.data.iter().sum::<f32>() / f.data.len() as f32;
    assert!(mean(&u) > 0.01, "water should run right, mean u {}", mean(&u));
    assert!(mean(&v).abs() < 0.1 * mean(&u), "water should not run sideways, mean v {}", mean(&v));
    // Depth grows downslope as the flow gathers.
    assert!(at(&depth, 70, 20) > at(&depth, 10, 20), "the foot of the slope should be wetter");
    // Water drains off the table: far less is stored than has fallen.
    let fallen = status.info["rain_m3"].as_f64().unwrap() as f32;
    assert!(volume(&depth, 2.0) < 0.5 * fallen, "most water should have left at the edge");
    assert!(u.data.iter().chain(&v.data).all(|s| s.abs() <= 6.0));
}

#[test]
fn roofs_drain_to_the_ground_beside_them_and_buildings_stay_dry() {
    // A bowl with a building on one slope.
    let mut scene = bowl(64);
    for row in 10..22 {
        for col in 26..38 {
            let i = row * 64 + col;
            scene.dsm[i] = scene.dtm[i] + 15.0;
        }
    }
    let water = |roofs: bool| {
        let mut engine = engine(Backend::Cpu, scene.clone()).unwrap();
        let job = engine.create_job("stormwater", &fast(json!({ "rain_mm_h": 100, "resolution": 64, "roofs": roofs }))).unwrap();
        run_exactly(&mut engine, job, 1500);
        engine.read_field(job, "depth").unwrap()
    };
    let (with, without) = (water(true), water(false));
    for row in 10..22 {
        for col in 26..38 {
            assert_eq!(at(&with, col, row), 0.0, "no water inside the building");
        }
    }
    // The roof's rain reaches the ground: more water on the site with roofs draining.
    let roof_area = 12.0 * 12.0 * 4.0;
    let gained = volume(&with, 2.0) - volume(&without, 2.0);
    assert!(gained > 0.0, "draining roofs should add water");
    let expected = roof_area * 100.0 / 3_600_000.0;
    assert!(
        gained > 0.5 * expected * 1.0,
        "roof water {gained} m3 per second of rain is too little (one second of roof rain is {expected} m3)"
    );
}

#[test]
fn infiltration_soaks_up_light_rain_and_a_dry_site_settles() {
    let mut engine = engine(Backend::Cpu, bowl(32)).unwrap();
    let job =
        engine.create_job("stormwater", &json!({ "pace": "fast", "rain_mm_h": 4, "infiltration_mm_h": 10, "resolution": 32 })).unwrap();
    let status = run(&mut engine, job, 50_000);
    assert_eq!(status.state, JobState::Done, "a site that soaks up all its rain should settle");
    let depth = engine.read_field(job, "depth").unwrap();
    assert!(depth.data.iter().all(|&d| d == 0.0), "all the rain should soak in");
    assert!(status.info["seconds"].as_f64().unwrap() >= 300.0);
}

#[test]
fn params_are_validated_and_a_new_storm_starts_dry() {
    let mut engine = engine(Backend::Cpu, bowl(64)).unwrap();
    assert!(engine.create_job("stormwater", &json!({ "rain": 3 })).is_err());
    assert!(engine.create_job("stormwater", &json!({ "pace": "slow" })).is_err());
    assert!(engine.create_job("stormwater", &json!({ "roofs": 1 })).is_err());
    let job = engine.create_job("stormwater", &fast(json!({ "rain_mm_h": 500, "resolution": 32 }))).unwrap();
    let status = run_exactly(&mut engine, job, 200);
    assert_eq!(status.info["lattice"]["width"], 32);
    let wet = volume(&engine.read_field(job, "depth").unwrap(), 4.0);
    assert!(wet > 0.0);
    // Stopping the rain keeps the water.
    engine.set_params(job, &json!({ "rain_mm_h": 0 })).unwrap();
    let status = run_exactly(&mut engine, job, 10);
    assert_eq!(steps(&status), 210);
    let kept = volume(&engine.read_field(job, "depth").unwrap(), 4.0);
    assert!((kept - wet).abs() < 0.01 * wet, "stopping the rain should keep the water in the bowl");
    // A new storm dries the site.
    engine.set_params(job, &json!({ "storm": 1 })).unwrap();
    let status = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!(steps(&status), 1);
    assert_eq!(volume(&engine.read_field(job, "depth").unwrap(), 2.0), 0.0);
    // A finer lattice.
    engine.set_params(job, &json!({ "resolution": 64 })).unwrap();
    let status = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!(status.info["lattice"]["cell_m"], 2.0);
}

#[test]
fn realtime_pace_follows_the_wall_clock() {
    let mut engine = engine(Backend::Cpu, bowl(32)).unwrap();
    let job = engine.create_job("stormwater", &json!({ "speed": 120, "resolution": 32 })).unwrap();
    let started = Instant::now();
    let mut status = engine.step(job, Duration::from_millis(12)).unwrap();
    while started.elapsed() < Duration::from_millis(600) {
        status = engine.step(job, Duration::from_millis(12)).unwrap();
    }
    let wall = started.elapsed().as_secs_f64();
    let seconds = status.info["seconds"].as_f64().unwrap();
    let dt = status.info["dt"].as_f64().unwrap();
    assert!(seconds <= wall * 120.0 + dt, "ran ahead of the clock: {seconds} s of storm in {wall} s");
    assert!(seconds >= wall * 120.0 * 0.7, "fell behind the clock: {seconds} s of storm in {wall} s");
}

#[test]
fn gpu_matches_cpu_reference() {
    const STEPS: u64 = 400;
    let cases: [(f32, Value); 3] = [
        (0.0, fast(json!({ "rain_mm_h": 150, "resolution": 160 }))),
        (-92.6, fast(json!({ "rain_mm_h": 80, "resolution": 120, "infiltration_mm_h": 8, "manning": 0.05 }))),
        (0.0, fast(json!({ "rain_mm_h": 200, "resolution": 80, "roofs": false, "trees": false }))),
    ];
    for (rotation, params) in cases {
        let scene = testing::town(160, 96, 4.0, rotation);
        let Some(mut gpu) = engine(Backend::Gpu, scene.clone()) else { return };
        let mut cpu = engine(Backend::Cpu, scene).unwrap();
        let (gj, cj) = (gpu.create_job("stormwater", &params).unwrap(), cpu.create_job("stormwater", &params).unwrap());
        let (gs, cs) = (run_exactly(&mut gpu, gj, STEPS), run_exactly(&mut cpu, cj, STEPS));
        assert_eq!((steps(&gs), steps(&cs)), (STEPS, STEPS));
        assert_eq!(gs.info["lattice"], cs.info["lattice"]);
        assert_eq!(gs.info["dt"], cs.info["dt"]);
        for (name, tolerance) in [("depth", 1e-3f32), ("u", 0.02), ("v", 0.02)] {
            let (g, c) = (gpu.read_field(gj, name).unwrap(), cpu.read_field(cj, name).unwrap());
            assert_eq!((g.width, g.height, g.min, g.max), (c.width, c.height, c.min, c.max));
            let worst = g.data.iter().zip(&c.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < tolerance, "{name} differs by {worst} for {params}");
            assert!(c.data.iter().any(|v| v.abs() > 1e-3), "{name} should not be empty for {params}");
        }
        let (gv, cv) = (volume(&gpu.read_field(gj, "depth").unwrap(), 1.0), volume(&cpu.read_field(cj, "depth").unwrap(), 1.0));
        assert!((gv - cv).abs() < 1e-3 * cv, "stored water differs: {gv} vs {cv}");
    }
}
