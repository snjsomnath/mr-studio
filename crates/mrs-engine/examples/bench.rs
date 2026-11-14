//! Times the kernels on both backends: `cargo run --release -p mrs-engine --example bench`.

use std::time::{Duration, Instant};

use mrs_engine::{testing, Backend, Engine, EngineConfig, JobState};
use serde_json::json;

fn main() {
    for (width, height, cell) in [(500u32, 300u32, 2.0f32), (1000, 600, 1.0), (2000, 1200, 0.5)] {
        for backend in [Backend::Gpu, Backend::Cpu] {
            let Ok(mut engine) = Engine::new(EngineConfig { backend }) else {
                println!("{backend:?}: not available");
                continue;
            };
            engine.load_scene(testing::town(width, height, cell, 0.0)).unwrap();
            let adapter = engine.info().adapter.unwrap_or_else(|| "cpu reference".into());
            for (mode, field) in [("instant", "shadow"), ("day", "sun_hours")] {
                let params = json!({ "mode": mode, "time": "2026-06-21T09:00:00Z", "lat": 57.6884, "lon": 11.9778 });
                let started = Instant::now();
                let job = engine.create_job("sunlight", &params).unwrap();
                while engine.step(job, Duration::from_secs(1)).unwrap().state != JobState::Done {}
                let field = engine.read_field(job, field).unwrap();
                let elapsed = started.elapsed();
                let mean = field.data.iter().sum::<f32>() / field.data.len() as f32;
                println!("{width}x{height} {mode:8} {:>9.1} ms  mean {mean:.3}  [{adapter}]", elapsed.as_secs_f64() * 1e3);
                engine.drop_job(job);
            }
            // Wind is iterative: what matters is how many lattice cells it updates per second.
            let job = engine.create_job("wind", &json!({ "resolution": width / 2 })).unwrap();
            let started = Instant::now();
            let mut status = engine.step(job, Duration::from_millis(50)).unwrap();
            while started.elapsed() < Duration::from_secs(3) {
                status = engine.step(job, Duration::from_millis(50)).unwrap();
            }
            let steps = status.info["steps"].as_u64().unwrap();
            let domain = &status.info["lattice"]["domain"];
            let cells = domain[0].as_u64().unwrap() * domain[1].as_u64().unwrap();
            let rate = steps as f64 / started.elapsed().as_secs_f64();
            println!(
                "{width}x{height} wind     {rate:>9.0} steps/s on {}x{} cells = {:.0} million cell updates/s  [{adapter}]",
                domain[0],
                domain[1],
                rate * cells as f64 / 1e6
            );
            engine.drop_job(job);
        }
    }
}
