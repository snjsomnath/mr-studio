//! Wind kernel: physics on the CPU reference, job behaviour, and GPU/CPU parity.

use std::time::Duration;

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

fn flat(width: u32, height: u32, cell_m: f32, rotation_deg: f32) -> SceneData {
    SceneData::flat(Grid { width, height, cell_m, rotation_deg })
}

/// Flat ground with one 20 m tall box.
fn with_box(mut scene: SceneData, cols: std::ops::Range<usize>, rows: std::ops::Range<usize>) -> SceneData {
    let width = scene.grid.width as usize;
    for row in rows {
        for col in cols.clone() {
            scene.dsm[row * width + col] = 20.0;
        }
    }
    scene
}

fn steps(status: &JobStatus) -> u64 {
    status.info["steps"].as_u64().unwrap()
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

/// Exactly `count` steps: a zero budget runs one step per call.
fn run_exactly(engine: &mut Engine, job: JobId, count: u64) -> JobStatus {
    let mut status = engine.step(job, Duration::ZERO).unwrap();
    for _ in 1..count {
        status = engine.step(job, Duration::ZERO).unwrap();
    }
    status
}

fn at(field: &Field, col: usize, row: usize) -> f32 {
    field.data[row * field.width as usize + col]
}

fn close(a: f32, b: f32, tolerance: f32) -> bool {
    (a - b).abs() <= tolerance
}

#[test]
fn channel_flow_matches_poiseuille() {
    // A body force between two walls gives a parabolic profile with a known peak.
    let (height, viscosity, force) = (16usize, 0.15f32, 1e-5f32);
    let mut engine = engine(Backend::Cpu, flat(32, height as u32, 1.0, 0.0)).unwrap();
    let job = engine
        .create_job("wind", &json!({ "boundary": "channel", "force": [force, 0.0], "viscosity": viscosity, "resolution": 32 }))
        .unwrap();
    let status = run(&mut engine, job, 20_000);
    assert_eq!(status.state, JobState::Done, "the channel should settle");
    let lattice = status.info["lattice_speed"].as_f64().unwrap() as f32 / 5.0;
    let u = engine.read_field(job, "u").unwrap();
    let v = engine.read_field(job, "v").unwrap();
    assert_eq!((u.width, u.height), (32, height as u32));
    let peak = force * (height * height) as f32 / (8.0 * viscosity);
    for row in 0..height {
        // Walls sit half a cell outside the first and last rows.
        let y = row as f32 + 0.5;
        let expected = force / (2.0 * viscosity) * y * (height as f32 - y);
        let got = at(&u, 7, row) * lattice;
        assert!(close(got, expected, 0.01 * peak), "row {row}: {got} vs {expected}");
        assert!(at(&v, 7, row).abs() * lattice < 1e-3 * peak);
    }
}

#[test]
fn uniform_wind_stays_uniform_and_follows_the_compass() {
    // (grid rotation, wind from, expected u, expected v) with u to the right and v down the table.
    let h = 5.0 * std::f32::consts::FRAC_1_SQRT_2;
    let cases = [
        (0.0, 270.0, 5.0, 0.0),  // from the west: towards the right
        (0.0, 0.0, 0.0, 5.0),    // from the north: down the table
        (0.0, 225.0, h, -h),     // from the south-west: right and up
        (90.0, 0.0, 5.0, 0.0),   // "up" is east, so south is to the right
        (90.0, 270.0, 0.0, -5.0), // and east is up
    ];
    for boundary in ["periodic", "open"] {
        for (rotation, from, eu, ev) in cases {
            let mut engine = engine(Backend::Cpu, flat(64, 40, 2.0, rotation)).unwrap();
            let job = engine.create_job("wind", &json!({ "boundary": boundary, "direction_deg": from, "resolution": 64 })).unwrap();
            run(&mut engine, job, 300);
            let (u, v, speed) =
                (engine.read_field(job, "u").unwrap(), engine.read_field(job, "v").unwrap(), engine.read_field(job, "speed").unwrap());
            assert_eq!((u.width, u.height, u.units), (64, 40, "m/s"));
            for (col, row) in [(0, 0), (32, 20), (63, 39), (5, 30)] {
                let what = format!("{boundary}, rotation {rotation}, from {from}, cell ({col}, {row})");
                assert!(close(at(&u, col, row), eu, 0.02), "{what}: u {}", at(&u, col, row));
                assert!(close(at(&v, col, row), ev, 0.02), "{what}: v {}", at(&v, col, row));
                assert!(close(at(&speed, col, row), 5.0, 0.02), "{what}: speed {}", at(&speed, col, row));
            }
            // The display range is fixed by the wind speed, so colours do not jump.
            assert_eq!((speed.min, speed.max, u.min, u.max), (0.0, 12.5, -12.5, 12.5));
        }
    }
}

#[test]
fn air_stops_at_a_building_speeds_up_beside_it_and_leaves_a_wake() {
    // A 20 m box in a 240 m by 160 m site, wind from the west.
    let scene = with_box(flat(120, 80, 2.0, 0.0), 55..65, 35..45);
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let job = engine.create_job("wind", &json!({ "speed": 5, "direction_deg": 270, "resolution": 120 })).unwrap();
    let status = run(&mut engine, job, 4000);
    assert!(status.info["peak_mps"].as_f64().unwrap() > 5.0);
    let speed = engine.read_field(job, "speed").unwrap();
    let u = engine.read_field(job, "u").unwrap();
    assert_eq!((speed.width, speed.height), (120, 80));
    assert_eq!(at(&speed, 60, 40), 0.0, "no flow inside the building");
    assert!(close(at(&speed, 3, 40), 5.0, 0.6), "far upstream is the free wind, got {}", at(&speed, 3, 40));
    assert!(at(&speed, 53, 40) < 2.5, "the air stagnates in front, got {}", at(&speed, 53, 40));
    assert!(at(&speed, 60, 20) > 5.5, "the air speeds up beside it, got {}", at(&speed, 60, 20));
    assert!(at(&speed, 70, 40) < 2.5, "there is a wake behind, got {}", at(&speed, 70, 40));
    assert!(at(&u, 100, 40) < at(&u, 100, 10), "the wake still shows 70 m downstream");
    // The box sits on the centre line, so the flow is mirrored about it.
    for col in [40, 60, 80, 110] {
        let (above, below) = (at(&speed, col, 20), at(&speed, col, 59));
        assert!(close(above, below, 0.02 * above.max(1.0)), "column {col}: {above} vs {below}");
    }
}

#[test]
fn trees_slow_the_wind_without_blocking_it() {
    let mut scene = flat(120, 80, 2.0, 0.0);
    for row in 30..50 {
        for col in 50..70 {
            scene.canopy[row * 120 + col] = 10.0;
        }
    }
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let job = engine.create_job("wind", &json!({ "resolution": 120 })).unwrap();
    let status = run(&mut engine, job, 3000);
    let speed = engine.read_field(job, "speed").unwrap();
    let inside = at(&speed, 65, 40);
    assert!(inside > 0.5 && inside < 4.0, "the grove slows the wind, got {inside}");
    assert!(at(&speed, 60, 15) > 5.0, "air goes around the grove, got {}", at(&speed, 60, 15));

    // Turning trees off keeps the flow and lets it recover; nothing restarts.
    engine.set_params(job, &json!({ "trees": false })).unwrap();
    let after = run(&mut engine, job, steps(&status) + 3000);
    assert!(steps(&after) > steps(&status));
    let recovered = at(&engine.read_field(job, "speed").unwrap(), 65, 40);
    assert!(recovered > inside + 0.5 && recovered > 4.0, "without trees the wind returns, got {recovered}");
}

#[test]
fn params_are_validated_and_only_restart_what_they_invalidate() {
    let scene = with_box(flat(48, 32, 4.0, 0.0), 22..26, 14..18);
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    assert!(matches!(engine.create_job("wind", &json!({ "speed": "fast" })), Err(EngineError::InvalidParams(_))));
    assert!(matches!(engine.create_job("wind", &json!({ "gusts": true })), Err(EngineError::InvalidParams(_))));
    assert!(matches!(engine.create_job("wind", &json!({ "boundary": "closed" })), Err(EngineError::InvalidParams(_))));
    assert!(matches!(engine.create_job("wind", &json!([1, 2])), Err(EngineError::InvalidParams(_))));

    // Defaults work, and a field exists before the first step.
    let job = engine.create_job("wind", &json!({})).unwrap();
    assert!(engine.read_field(job, "speed").unwrap().data.iter().all(|v| *v == 0.0), "the run starts from rest");
    assert!(matches!(engine.read_field(job, "pressure"), Err(EngineError::UnknownField(_))));

    // A steady flow settles and then costs nothing.
    let settled = run(&mut engine, job, 50_000);
    assert_eq!(settled.state, JobState::Done, "flow around a small box should settle, change {}", settled.info["change"]);
    assert_eq!(settled.progress, 1.0);
    let again = engine.step(job, Duration::from_millis(20)).unwrap();
    assert_eq!((again.revision, steps(&again)), (settled.revision, steps(&settled)));
    let before = engine.read_field(job, "speed").unwrap();

    // Unchanged values do nothing.
    engine.set_params(job, &json!({ "speed": 5, "trees": true })).unwrap();
    assert_eq!(engine.step(job, Duration::ZERO).unwrap().revision, settled.revision);

    // A faster wind only rescales the result: no new steps, a new revision.
    engine.set_params(job, &json!({ "speed": 10 })).unwrap();
    let faster = engine.step(job, Duration::from_millis(20)).unwrap();
    assert_eq!((faster.state, steps(&faster)), (JobState::Done, steps(&settled)));
    assert!(faster.revision > settled.revision);
    let after = engine.read_field(job, "speed").unwrap();
    assert_eq!(after.max, 25.0);
    assert!(close(at(&after, 5, 5), 2.0 * at(&before, 5, 5), 1e-3));

    // Out-of-range numbers are clamped, not refused.
    engine.set_params(job, &json!({ "speed": 500 })).unwrap();
    assert_eq!(engine.read_field(job, "speed").unwrap().max, 50.0);

    // A gentle breeze changes the lattice speed, and a new direction changes the lattice: both start over.
    engine.set_params(job, &json!({ "speed": 2 })).unwrap();
    let breeze = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!((breeze.state, steps(&breeze)), (JobState::Running, 1));
    run(&mut engine, job, 50);
    engine.set_params(job, &json!({ "direction_deg": 0 })).unwrap();
    let turned = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!(steps(&turned), 1);
    assert!(close(turned.info["wind"]["v"].as_f64().unwrap() as f32, 1.0, 1e-6), "wind from the north blows down the table");
    // Bearings wrap.
    engine.set_params(job, &json!({ "direction_deg": 360 })).unwrap();
    assert_eq!(steps(&engine.step(job, Duration::ZERO).unwrap()), 2);
}

#[test]
fn resolution_sets_the_lattice_and_fields_cover_the_site() {
    let mut engine = engine(Backend::Cpu, with_box(flat(500, 300, 1.0, 0.0), 200..260, 120..180)).unwrap();
    let job = engine.create_job("wind", &json!({ "resolution": 100 })).unwrap();
    let status = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!(status.info["lattice"], json!({ "width": 100, "height": 60, "cell_m": 5.0, "factor": 5, "domain": [225, 96] }));
    let speed = engine.read_field(job, "speed").unwrap();
    assert_eq!((speed.width, speed.height, speed.data.len()), (100, 60, 6000));
    engine.set_params(job, &json!({ "resolution": 250 })).unwrap();
    let status = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!((status.info["lattice"]["width"].as_u64(), status.info["lattice"]["factor"].as_u64()), (Some(250), Some(2)));
    let speed = engine.read_field(job, "speed").unwrap();
    assert_eq!((speed.width, speed.height), (250, 150));
    // The box covers the same share of the field at either resolution.
    assert_eq!(at(&speed, 115, 75), 0.0);
}

#[test]
fn a_new_scene_reaches_running_jobs() {
    let mut engine = engine(Backend::Cpu, flat(120, 80, 2.0, 0.0)).unwrap();
    let job = engine.create_job("wind", &json!({ "resolution": 120 })).unwrap();
    run(&mut engine, job, 50);
    assert!(close(at(&engine.read_field(job, "speed").unwrap(), 60, 40), 5.0, 0.05));
    engine.load_scene(with_box(flat(120, 80, 2.0, 0.0), 55..65, 35..45)).unwrap();
    let status = engine.step(job, Duration::ZERO).unwrap();
    assert_eq!(steps(&status), 1, "the run starts over on the new scene");
    assert_eq!(at(&engine.read_field(job, "speed").unwrap(), 60, 40), 0.0);
}

/// GPU and CPU run the same algorithm in single precision. They differ only in
/// rounding (the GPU may fuse multiply-adds), so after hundreds of steps the
/// fields agree to a small fraction of the wind speed.
#[test]
fn gpu_matches_cpu_reference() {
    const STEPS: u64 = 300;
    const TOLERANCE_MPS: f32 = 0.005;
    let cases: [(f32, Value); 4] = [
        (0.0, json!({ "direction_deg": 270, "resolution": 160 })),
        (-92.6, json!({ "direction_deg": 200, "resolution": 160, "speed": 12 })),
        (0.0, json!({ "direction_deg": 45, "resolution": 80, "trees": false, "viscosity": 0.08 })),
        (0.0, json!({ "boundary": "channel", "force": [2e-6, 0.0], "resolution": 160 })),
    ];
    for (rotation, params) in cases {
        let scene = testing::town(160, 96, 4.0, rotation);
        let Some(mut gpu) = engine(Backend::Gpu, scene.clone()) else { return };
        let mut cpu = engine(Backend::Cpu, scene).unwrap();
        let (gj, cj) = (gpu.create_job("wind", &params).unwrap(), cpu.create_job("wind", &params).unwrap());
        let (gs, cs) = (run_exactly(&mut gpu, gj, STEPS), run_exactly(&mut cpu, cj, STEPS));
        assert_eq!((steps(&gs), steps(&cs)), (STEPS, STEPS));
        assert_eq!(gs.info["lattice"], cs.info["lattice"]);
        let change = |s: &JobStatus| s.info["change"].as_f64().unwrap();
        assert!((change(&gs) - change(&cs)).abs() < 1e-4 * change(&cs).max(1.0), "convergence measure differs for {params}");
        for name in ["u", "v", "speed"] {
            let (g, c) = (gpu.read_field(gj, name).unwrap(), cpu.read_field(cj, name).unwrap());
            assert_eq!((g.width, g.height, g.min, g.max), (c.width, c.height, c.min, c.max));
            let worst = g.data.iter().zip(&c.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < TOLERANCE_MPS, "{name} differs by {worst} m/s for {params}");
            if name != "v" {
                assert!(c.data.iter().any(|v| v.abs() > 0.05), "{name} should not be empty for {params}");
            }
        }
        // Changing a param mid-run takes the same path on both.
        for engine_job in [(&mut gpu, gj), (&mut cpu, cj)] {
            engine_job.0.set_params(engine_job.1, &json!({ "trees": false, "viscosity": 0.05 })).unwrap();
        }
        run_exactly(&mut gpu, gj, 20);
        run_exactly(&mut cpu, cj, 20);
        let (g, c) = (gpu.read_field(gj, "speed").unwrap(), cpu.read_field(cj, "speed").unwrap());
        let worst = g.data.iter().zip(&c.data).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(worst < TOLERANCE_MPS, "after a param change speed differs by {worst} m/s for {params}");
    }
}
