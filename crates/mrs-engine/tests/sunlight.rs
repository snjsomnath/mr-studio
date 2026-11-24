//! Sunlight kernel: physical sanity on the CPU reference, and GPU/CPU parity.

use std::time::Duration;

use mrs_engine::{testing, Backend, Engine, EngineConfig, EngineError, Field, Grid, JobState, SceneData};
use serde_json::{json, Value};

const LAT: f64 = 57.6884;
const LON: f64 = 11.9778;

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

fn run(engine: &mut Engine, params: Value, field: &str) -> Field {
    let job = engine.create_job("sunlight", &params).unwrap();
    for _ in 0..10_000 {
        if engine.step(job, Duration::from_millis(50)).unwrap().state == JobState::Done {
            let field = engine.read_field(job, field).unwrap();
            engine.drop_job(job);
            return field;
        }
    }
    panic!("job did not finish");
}

fn params(mode: &str, time: &str) -> Value {
    json!({ "mode": mode, "time": time, "lat": LAT, "lon": LON })
}

/// One 20 m tall, 20 m wide box in the middle of flat ground, 1 m cells.
fn box_scene(rotation_deg: f32) -> SceneData {
    let grid = Grid { width: 200, height: 200, cell_m: 1.0, rotation_deg };
    let mut scene = SceneData::flat(grid);
    for row in 90..110 {
        for col in 90..110 {
            scene.dsm[row * 200 + col] = 20.0;
        }
    }
    scene
}

#[test]
fn shadow_falls_north_at_noon_with_the_right_length() {
    let mut engine = engine(Backend::Cpu, box_scene(0.0)).unwrap();
    // Solar noon on the summer solstice: sun due south at 55.75 degrees.
    let shadow = run(&mut engine, params("instant", "2026-06-21T11:14:00Z"), "shadow");
    let at = |col: usize, row: usize| shadow.data[row * 200 + col];
    // Expected shadow length is 20 / tan(55.75 deg) = 13.6 m, towards the north (row 0).
    assert_eq!(at(100, 85), 0.0, "5 m north of the box is shaded");
    assert_eq!(at(100, 78), 0.0, "12 m north of the box is shaded");
    assert_eq!(at(100, 74), 1.0, "16 m north of the box is lit");
    assert_eq!(at(100, 115), 1.0, "south of the box is lit");
    assert_eq!(at(100, 100), 1.0, "the roof is lit");
    assert_eq!(at(60, 100), 1.0, "west of the box is lit at noon");
}

#[test]
fn rotating_the_grid_rotates_the_shadow() {
    // With "up" pointing east, north is to the left: the noon shadow falls towards column 0.
    let mut engine = engine(Backend::Cpu, box_scene(90.0)).unwrap();
    let shadow = run(&mut engine, params("instant", "2026-06-21T11:14:00Z"), "shadow");
    let at = |col: usize, row: usize| shadow.data[row * 200 + col];
    assert_eq!(at(85, 100), 0.0);
    assert_eq!(at(74, 100), 1.0);
    assert_eq!(at(115, 100), 1.0);
    assert_eq!(at(100, 85), 1.0);
}

#[test]
fn night_is_dark_and_sun_hours_match_day_length() {
    let mut engine = engine(Backend::Cpu, box_scene(0.0)).unwrap();
    let night = run(&mut engine, params("instant", "2026-06-21T23:30:00Z"), "shadow");
    assert!(night.data.iter().all(|v| *v == 0.0));

    let hours = run(&mut engine, params("day", "2026-06-21T12:00:00Z"), "sun_hours");
    // Open ground far from the box sees the whole day: about 17.5 h at this latitude in June.
    let open = hours.data[20 * 200 + 20];
    assert!((17.0..18.2).contains(&open), "open ground got {open} h");
    assert_eq!(open, hours.max);
    // Just north of the box loses the middle of the day.
    let shaded = hours.data[85 * 200 + 100];
    assert!(shaded < open - 2.0, "north side got {shaded} h");

    let winter = run(&mut engine, params("day", "2026-12-21T12:00:00Z"), "sun_hours");
    let open = winter.data[20 * 200 + 20];
    assert!((5.5..7.0).contains(&open), "winter open ground got {open} h");
}

#[test]
fn trees_dim_but_do_not_block() {
    let grid = Grid { width: 100, height: 100, cell_m: 1.0, rotation_deg: 0.0 };
    let mut scene = SceneData::flat(grid);
    for row in 45..55 {
        for col in 45..55 {
            scene.canopy[row * 100 + col] = 12.0;
        }
    }
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let with = run(&mut engine, params("instant", "2026-06-21T11:14:00Z"), "shadow");
    let v = with.data[42 * 100 + 50];
    assert!(v > 0.0 && v < 1.0, "north of the trees should be dimmed, got {v}");
    let mut p = params("instant", "2026-06-21T11:14:00Z");
    p["trees"] = json!(false);
    let without = run(&mut engine, p, "shadow");
    assert_eq!(without.data[42 * 100 + 50], 1.0);
}

#[test]
fn tree_shade_is_reported_apart_from_building_shade() {
    // A box building and, beside it, a clump of trees.
    let mut scene = box_scene(0.0);
    for row in 95..105 {
        for col in 30..40 {
            scene.canopy[row * 200 + col] = 12.0;
        }
    }
    let mut engine = engine(Backend::Cpu, scene).unwrap();
    let noon = "2026-06-21T11:14:00Z";
    let light = run(&mut engine, params("instant", noon), "shadow");
    let tree = run(&mut engine, params("instant", noon), "tree_shade");
    // Every cell is lit, shaded by a building, or has lost exactly what the trees took.
    let mut tree_cells = 0;
    for (l, t) in light.data.iter().zip(&tree.data) {
        assert!((l + t - 1.0).abs() < 1e-5 || (*l == 0.0 && *t == 0.0), "light {l} tree {t}");
        tree_cells += (*t > 0.0) as usize;
    }
    assert!(tree_cells > 50, "the clump should shade the ground north of it, got {tree_cells} cells");
    // The building's own shadow is not tree shade.
    let building_shadow = (0..200 * 200).filter(|&i| light.data[i] == 0.0).count();
    assert!(building_shadow > 50);

    let mut p = params("instant", noon);
    p["trees"] = json!(false);
    assert!(run(&mut engine, p, "tree_shade").data.iter().all(|t| *t == 0.0));

    // Over a day the hours lost to trees are part of the daylight, never more.
    let hours = run(&mut engine, params("day", "2026-06-21T12:00:00Z"), "sun_hours");
    let lost = run(&mut engine, params("day", "2026-06-21T12:00:00Z"), "tree_shade_hours");
    assert!(lost.data.iter().any(|t| *t > 1.0));
    assert!(hours.data.iter().zip(&lost.data).all(|(h, t)| h + t <= hours.max + 1e-3));
}

#[test]
fn params_are_validated_and_changes_restart() {
    let mut engine = engine(Backend::Cpu, box_scene(0.0)).unwrap();
    assert!(matches!(engine.create_job("sunlight", &json!({ "mode": "instant" })), Err(EngineError::InvalidParams(_))));
    assert!(matches!(engine.create_job("sunlight", &json!({ "time": "nope", "lat": 0, "lon": 0 })), Err(EngineError::InvalidParams(_))));
    assert!(matches!(engine.create_job("nope", &json!({})), Err(EngineError::UnknownKernel(_))));

    let job = engine.create_job("sunlight", &params("instant", "2026-06-21T11:14:00Z")).unwrap();
    let first = engine.step(job, Duration::from_millis(50)).unwrap();
    assert_eq!(first.state, JobState::Done);
    // Stepping a finished job does nothing.
    assert_eq!(engine.step(job, Duration::from_millis(50)).unwrap().revision, first.revision);
    // The wrong field for the mode is an error, not a panic.
    assert!(matches!(engine.read_field(job, "sun_hours"), Err(EngineError::UnknownField(_))));
    // A new time restarts the job and produces a new revision.
    engine.set_params(job, &json!({ "time": "2026-06-21T16:00:00Z" })).unwrap();
    let second = engine.step(job, Duration::from_millis(50)).unwrap();
    assert!(second.revision > first.revision);
    let afternoon = engine.read_field(job, "shadow").unwrap();
    // In the afternoon the sun is in the west, so the shadow falls east.
    assert_eq!(afternoon.data[100 * 200 + 115], 0.0);
}

#[test]
fn a_new_scene_reaches_running_jobs() {
    let mut engine = engine(Backend::Cpu, SceneData::flat(Grid { width: 200, height: 200, cell_m: 1.0, rotation_deg: 0.0 })).unwrap();
    let job = engine.create_job("sunlight", &params("instant", "2026-06-21T11:14:00Z")).unwrap();
    engine.step(job, Duration::from_millis(50)).unwrap();
    assert_eq!(engine.read_field(job, "shadow").unwrap().data[85 * 200 + 100], 1.0);
    engine.load_scene(box_scene(0.0)).unwrap();
    engine.step(job, Duration::from_millis(50)).unwrap();
    assert_eq!(engine.read_field(job, "shadow").unwrap().data[85 * 200 + 100], 0.0);
}

/// Fraction of cells where the two backends differ by more than `tolerance`.
fn mismatch(a: &Field, b: &Field, tolerance: f32) -> f64 {
    assert_eq!((a.width, a.height), (b.width, b.height));
    let differing = a.data.iter().zip(&b.data).filter(|(x, y)| (**x - **y).abs() > tolerance).count();
    differing as f64 / a.data.len() as f64
}

/// GPU and CPU run the same algorithm. Floating point contraction on the GPU can flip a
/// cell that sits exactly on a shadow edge, so the tolerance is a small fraction of cells.
#[test]
fn gpu_matches_cpu_reference() {
    for rotation in [0.0, -92.6] {
        let scene = testing::town(320, 192, 2.0, rotation);
        let Some(mut gpu) = engine(Backend::Gpu, scene.clone()) else { return };
        let mut cpu = engine(Backend::Cpu, scene).unwrap();
        for time in ["2026-06-21T07:30:00Z", "2026-06-21T11:14:00Z", "2026-12-21T12:30:00Z", "2026-03-20T16:00:00Z"] {
            let (g, c) = (run(&mut gpu, params("instant", time), "shadow"), run(&mut cpu, params("instant", time), "shadow"));
            let m = mismatch(&g, &c, 0.02);
            assert!(m < 0.002, "instant {time} rotation {rotation}: {:.4}% of cells differ", m * 100.0);
            let (g, c) = (run(&mut gpu, params("instant", time), "tree_shade"), run(&mut cpu, params("instant", time), "tree_shade"));
            let m = mismatch(&g, &c, 0.02);
            assert!(m < 0.002, "tree shade {time} rotation {rotation}: {:.4}% of cells differ", m * 100.0);
        }
        let mut p = params("day", "2026-06-21T12:00:00Z");
        p["step_minutes"] = json!(30);
        let (g, c) = (run(&mut gpu, p.clone(), "sun_hours"), run(&mut cpu, p, "sun_hours"));
        assert_eq!(g.max, c.max);
        // Half a sample of slack per cell.
        let m = mismatch(&g, &c, 0.51);
        assert!(m < 0.002, "day rotation {rotation}: {:.4}% of cells differ", m * 100.0);
    }
}

#[test]
fn a_probe_gives_one_place_its_day() {
    let mut engine = engine(Backend::Cpu, box_scene(0.0)).unwrap();
    let day = params("day", "2026-06-21T12:00:00Z");
    let field =
        run(&mut engine, json!({ "mode": "day", "time": "2026-06-21T12:00:00Z", "lat": LAT, "lon": LON, "step_minutes": 5 }), "sun_hours");
    // Cell (col 100, row 85) sits 5 m north of the box: its centre is east 0.5 m, north 15 - 0.5 m.
    let north_of_box = engine.probe("sunlight", &day, 0.5, 14.5).unwrap();
    let hours = north_of_box["sun_hours"].as_f64().unwrap() as f32;
    assert!((hours - field.data[85 * 200 + 100]).abs() < 0.01, "probe {hours} h, field {} h", field.data[85 * 200 + 100]);
    let light: Vec<f64> = north_of_box["light"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(light.len(), 288, "every 5 minutes for a day");
    // Lit in the morning, in the box's shadow at noon, lit again in the evening.
    let noon = light.len() / 2;
    assert_eq!(light[noon], 0.0);
    assert!(light[..noon].contains(&1.0) && light[noon..].contains(&1.0));
    assert_eq!(north_of_box["roof"], false);

    let roof = engine.probe("sunlight", &day, 0.5, 0.5).unwrap();
    assert_eq!(roof["roof"], true);
    let open = engine.probe("sunlight", &day, -80.0, 80.0).unwrap();
    let daylight = open["daylight_hours"].as_f64().unwrap();
    assert!((open["sun_hours"].as_f64().unwrap() - daylight).abs() < 0.1, "open ground sees the whole day");
    assert!(open["first_sun"].as_f64().unwrap() < open["last_sun"].as_f64().unwrap());

    assert!(engine.probe("sunlight", &day, 500.0, 0.0).is_err(), "off the table");
    assert!(engine.probe("wind", &day, 0.0, 0.0).is_err(), "unknown or no probe");
}

#[test]
fn a_window_counts_only_the_sun_inside_it() {
    let mut engine = engine(Backend::Cpu, box_scene(0.0)).unwrap();
    // The evening of midsummer, 17 to 21 local time (UTC+2): four hours of open sky.
    let mut evening = params("day", "2026-06-21T10:00:00Z");
    evening["from"] = json!("2026-06-21T15:00:00Z");
    evening["until"] = json!("2026-06-21T19:00:00Z");
    let hours = run(&mut engine, evening, "sun_hours");
    let at = |col: usize, row: usize| hours.data[row * 200 + col];
    assert!((at(20, 20) - 4.0).abs() < 0.3, "open ground gets the whole window: {}", at(20, 20));
    // East of the box is in its shadow in the evening; west of it is not.
    assert!(at(120, 100) < 1.0, "east of the box loses the evening sun: {}", at(120, 100));
    assert!((at(80, 100) - 4.0).abs() < 0.3, "west of the box keeps it: {}", at(80, 100));
    // The morning window gives the other side's sun instead.
    let mut morning = params("day", "2026-06-21T10:00:00Z");
    morning["from"] = json!("2026-06-21T04:00:00Z");
    morning["until"] = json!("2026-06-21T08:00:00Z");
    let hours = run(&mut engine, morning, "sun_hours");
    assert!(hours.data[100 * 200 + 80] < 1.0, "west of the box is in its morning shadow");
    // Changing the window on an open job recounts it, as the controller does.
    let mut evening = params("day", "2026-06-21T10:00:00Z");
    evening["from"] = json!("2026-06-21T15:00:00Z");
    evening["until"] = json!("2026-06-21T19:00:00Z");
    let job = engine.create_job("sunlight", &evening).unwrap();
    let finish = |engine: &mut Engine| {
        while engine.step(job, Duration::from_millis(50)).unwrap().state != JobState::Done {}
        engine.read_field(job, "sun_hours").unwrap()
    };
    assert!((finish(&mut engine).data[100 * 200 + 80] - 4.0).abs() < 0.3);
    engine.set_params(job, &json!({ "from": "2026-06-21T04:00:00Z", "until": "2026-06-21T08:00:00Z" })).unwrap();
    let hours = finish(&mut engine);
    assert!(hours.data[100 * 200 + 80] < 1.0 && (hours.data[100 * 200 + 120] - 4.0).abs() < 0.3, "the window moved to the morning");
    engine.drop_job(job);
    assert!(matches!(
        engine.create_job("sunlight", &json!({ "time": "2026-06-21T10:00:00Z", "lat": LAT, "lon": LON, "from": true })),
        Err(EngineError::InvalidParams(_))
    ));
}
