//! How a running table is doing, for running unattended (#79).
//!
//! Each table and controller window says it is alive every few seconds over its WebSocket,
//! with the frame rate it draws at. The desktop app's watchdog reads that to reload a window
//! that went blank or froze. Incidents (an engine restarted after a failure, a lost GPU) are
//! kept here for the operator log.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

/// Incidents kept; the oldest go first.
const KEPT: usize = 500;

#[derive(Default)]
pub struct Health {
    incidents: Mutex<Incidents>,
    beats: Mutex<HashMap<String, Beat>>,
}

#[derive(Default)]
struct Incidents {
    list: VecDeque<(SystemTime, String)>,
    /// Every incident ever noted, so a reader can ask for the ones after the last it saw.
    total: u64,
}

struct Beat {
    role: String,
    at: Instant,
    fps: f64,
}

/// One window's last sign of life.
#[derive(Debug, Clone, Serialize)]
pub struct WindowBeat {
    /// The window's name in the desktop app (its label).
    pub window: String,
    pub role: String,
    /// How long ago it last said it was alive.
    #[serde(serialize_with = "seconds")]
    pub age: Duration,
    /// Frames it drew per second over the last beat.
    pub fps: f64,
}

fn seconds<S: serde::Serializer>(d: &Duration, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64(d.as_secs_f64())
}

impl Health {
    /// Notes something that happened and was recovered from.
    pub fn note(&self, message: impl Into<String>) {
        let mut incidents = self.incidents.lock().unwrap();
        incidents.list.push_back((SystemTime::now(), message.into()));
        incidents.total += 1;
        while incidents.list.len() > KEPT {
            incidents.list.pop_front();
        }
    }

    /// The incidents after the first `seen`, and how many there have been in all.
    pub fn incidents_after(&self, seen: u64) -> (Vec<(SystemTime, String)>, u64) {
        let incidents = self.incidents.lock().unwrap();
        let first = incidents.total - incidents.list.len() as u64;
        let skip = seen.saturating_sub(first) as usize;
        (incidents.list.iter().skip(skip).cloned().collect(), incidents.total)
    }

    /// A window said it is alive.
    pub fn beat(&self, window: &str, role: &str, fps: f64) {
        if window.is_empty() || window.len() > 120 {
            return;
        }
        let fps = if fps.is_finite() { fps.clamp(0.0, 1000.0) } else { 0.0 };
        self.beats.lock().unwrap().insert(window.to_string(), Beat { role: role.to_string(), at: Instant::now(), fps });
    }

    /// Every window that has said it is alive, with how long ago.
    pub fn windows(&self) -> Vec<WindowBeat> {
        let now = Instant::now();
        let mut list: Vec<_> = self
            .beats
            .lock()
            .unwrap()
            .iter()
            .map(|(window, b)| WindowBeat { window: window.clone(), role: b.role.clone(), age: now.duration_since(b.at), fps: b.fps })
            .collect();
        list.sort_by(|a, b| a.window.cmp(&b.window));
        list
    }

    /// Forgets windows that are gone, so a label is not kept for ever.
    pub fn forget(&self, keep: impl Fn(&str) -> bool) {
        self.beats.lock().unwrap().retain(|w, _| keep(w));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incidents_are_read_once_each_and_the_oldest_go_first() {
        let health = Health::default();
        health.note("one");
        health.note("two");
        let (new, total) = health.incidents_after(0);
        assert_eq!((new.len(), total), (2, 2));
        let (new, total) = health.incidents_after(total);
        assert!(new.is_empty() && total == 2);
        for n in 0..KEPT + 10 {
            health.note(format!("n{n}"));
        }
        let (new, total) = health.incidents_after(2);
        assert_eq!(new.len(), KEPT);
        assert_eq!(new.last().unwrap().1, format!("n{}", KEPT + 9));
        assert_eq!(total, (KEPT + 12) as u64);
    }

    #[test]
    fn a_window_beat_is_kept_with_its_age() {
        let health = Health::default();
        health.beat("surface-0-0-table", "table", 59.8);
        health.beat("", "tv", 60.0);
        let windows = health.windows();
        assert_eq!(windows.len(), 1);
        assert_eq!((windows[0].role.as_str(), windows[0].fps), ("table", 59.8));
        assert!(windows[0].age < Duration::from_secs(1));
        health.forget(|_| false);
        assert!(health.windows().is_empty());
    }
}
