//! The operator log (#79): one plain text file per day of what happened to the table while
//! nobody was watching. The app started, a table was presented or stopped, a window was
//! reloaded, the engine restarted, the nightly restart. A team reads it afterwards.
//!
//! It sits beside the app's technical log, as `operator-YYYY-MM-DD.log`, in local time.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Days of logs kept; older files are removed when a new day starts.
const KEEP_DAYS: usize = 90;

pub struct OperatorLog {
    dir: Option<PathBuf>,
    /// The day of the file written last, so old files are pruned once a day.
    day: Mutex<String>,
}

impl OperatorLog {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir, day: Mutex::new(String::new()) }
    }

    pub fn dir(&self) -> Option<&PathBuf> {
        self.dir.as_ref()
    }

    /// Writes one line, stamped with the local time. Never fails the caller.
    pub fn note(&self, text: impl AsRef<str>) {
        let text = text.as_ref();
        tracing::info!("operator: {text}");
        let Some(dir) = &self.dir else { return };
        let now = chrono::Local::now();
        let day = now.format("%Y-%m-%d").to_string();
        let written = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(dir)?;
            let mut file = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("operator-{day}.log")))?;
            writeln!(file, "{}  {text}", now.format("%H:%M:%S"))
        })();
        if let Err(e) = written {
            tracing::warn!("the operator log could not be written: {e}");
        }
        let mut last = self.day.lock().unwrap();
        if *last != day {
            *last = day;
            prune(dir);
        }
    }
}

fn prune(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut logs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("operator-") && n.to_string_lossy().ends_with(".log")))
        .collect();
    logs.sort();
    let extra = logs.len().saturating_sub(KEEP_DAYS);
    for old in logs.into_iter().take(extra) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_go_to_todays_file_and_old_days_are_pruned() {
        let dir = std::env::temp_dir().join(format!("mrs-operator-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for day in 1..=95 {
            std::fs::write(dir.join(format!("operator-2020-01-{day:03}.log")), "old\n").unwrap();
        }
        let log = OperatorLog::new(Some(dir.clone()));
        log.note("Presenting Lindholmen");
        log.note("The table window did not answer; reloaded it");
        let today = dir.join(format!("operator-{}.log", chrono::Local::now().format("%Y-%m-%d")));
        let text = std::fs::read_to_string(&today).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().nth(1).unwrap().ends_with("  The table window did not answer; reloaded it"));
        let left = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(left, KEEP_DAYS);
        assert!(today.exists(), "today's file is the newest and stays");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
