//! How a running table is doing, for running unattended (#79).
//!
//! Each table and controller window says it is alive every few seconds over its WebSocket,
//! with the frame rate it draws at. The desktop app's watchdog reads that to reload a window
//! that went blank or froze. Incidents (an engine restarted after a failure, a lost GPU) are
//! kept here for the operator log.
//!
//! Errors in the windows (a layer that throws, a script error) are sent here too (#260), so
//! the app's log has them on a computer where nobody has the developer tools open.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

/// Incidents kept; the oldest go first.
const KEPT: usize = 500;
/// Window errors kept for diagnostics.
const ERRORS_KEPT: usize = 200;
/// Errors one window may report in a minute; the rest are dropped.
const ERRORS_PER_MINUTE: u32 = 30;
/// The same error again within this long only counts up.
const SAME_ERROR: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct Health {
    incidents: Mutex<Incidents>,
    beats: Mutex<HashMap<String, Beat>>,
    errors: Mutex<Errors>,
}

#[derive(Default)]
struct Errors {
    list: VecDeque<(Instant, WindowError)>,
    /// Errors reported in the current minute, by who reported them.
    budget: HashMap<String, (Instant, u32)>,
}

/// An error a window reported (#260).
#[derive(Debug, Clone, Serialize)]
pub struct WindowError {
    /// Seconds since 1970 when it first happened.
    pub at: u64,
    /// The surface's role: table, tv, dev, phone, guide.
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// The layer instance it came from, when it came from one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// How many times it happened within a minute of the first.
    pub count: u32,
}

impl WindowError {
    /// Builds one from what a window sent, cut to sensible sizes. None without a message.
    pub fn from_report(role: &str, report: &serde_json::Value) -> Option<Self> {
        let text = |key: &str, most: usize| report[key].as_str().map(|s| s.trim()).filter(|s| !s.is_empty()).map(|s| s.chars().take(most).collect::<String>());
        Some(Self {
            at: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            role: role.to_string(),
            window: text("window", 120),
            layer: text("layer", 120),
            message: text("message", 500)?,
            stack: text("stack", 4000),
            count: 1,
        })
    }

    /// One line for a log.
    pub fn line(&self) -> String {
        let place = match (&self.window, &self.layer) {
            (_, Some(layer)) => format!("{} window, layer '{layer}'", self.role),
            (Some(window), None) => format!("{} window ({window})", self.role),
            (None, None) => format!("{} window", self.role),
        };
        format!("{place}: {}", self.message)
    }
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

    /// A window reported an error. True when it is new: not the same as one in the last
    /// minute and within the window's allowance, so it is worth a line in the logs.
    pub fn error(&self, from: &str, error: WindowError) -> bool {
        let now = Instant::now();
        let mut errors = self.errors.lock().unwrap();
        let budget = errors.budget.entry(from.to_string()).or_insert((now, 0));
        if now.duration_since(budget.0) > Duration::from_secs(60) {
            *budget = (now, 0);
        }
        budget.1 += 1;
        if budget.1 > ERRORS_PER_MINUTE {
            return false;
        }
        if errors.budget.len() > 256 {
            errors.budget.retain(|_, (since, _)| now.duration_since(*since) < Duration::from_secs(60));
        }
        let same = errors.list.iter_mut().rev().take_while(|(at, _)| now.duration_since(*at) < SAME_ERROR).find(|(_, e)| {
            e.role == error.role && e.layer == error.layer && e.message == error.message
        });
        if let Some((_, same)) = same {
            same.count += 1;
            return false;
        }
        errors.list.push_back((now, error));
        while errors.list.len() > ERRORS_KEPT {
            errors.list.pop_front();
        }
        true
    }

    /// The window errors kept, oldest first.
    pub fn errors(&self) -> Vec<WindowError> {
        self.errors.lock().unwrap().list.iter().map(|(_, e)| e.clone()).collect()
    }

    /// The last `most` incidents, oldest first, with when they happened (seconds since 1970).
    pub fn recent_incidents(&self, most: usize) -> Vec<(u64, String)> {
        let incidents = self.incidents.lock().unwrap();
        let skip = incidents.list.len().saturating_sub(most);
        incidents
            .list
            .iter()
            .skip(skip)
            .map(|(at, m)| (at.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0), m.clone()))
            .collect()
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
    fn window_errors_are_counted_once_and_kept_to_an_allowance() {
        let health = Health::default();
        let report = |message: &str| WindowError::from_report("table", &serde_json::json!({ "message": message, "layer": "trees" })).unwrap();
        assert!(health.error("surface-1", report("boom")));
        // The same error again only counts up.
        assert!(!health.error("surface-1", report("boom")));
        assert_eq!(health.errors()[0].count, 2);
        assert_eq!(health.errors()[0].line(), "table window, layer 'trees': boom");
        // A window that keeps throwing new errors is cut off after its allowance.
        for n in 0..ERRORS_PER_MINUTE + 10 {
            health.error("surface-2", report(&format!("new {n}")));
        }
        assert_eq!(health.errors().len(), 1 + ERRORS_PER_MINUTE as usize);
        // A report without a message is no error.
        assert!(WindowError::from_report("tv", &serde_json::json!({ "message": "  " })).is_none());
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
