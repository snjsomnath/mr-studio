//! The watchdog (#79): keeps a presented table running with nobody at the computer.
//!
//! Every few seconds it looks at the running table:
//! - the table's server stopped by itself: the table is started again, and presented again
//!   if it was;
//! - a table or controller window has not said it is alive for 30 s (a blank page, a crashed
//!   or frozen renderer): it is reloaded, and after two reloads that did not help, all the
//!   windows are opened again;
//! - the engine recovered from a failure or a lost GPU: noted in the operator log (the host
//!   already restarted it, and the windows reloaded themselves);
//! - the nightly restart time came: the table is started anew.
//!
//! Everything it does goes to the operator log, never onto the visitors' screens.

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use mrs_host::AppState;
use tauri::{AppHandle, Manager};

use crate::{is_presenting, launch, open_editor, show, usual_displays, Running, Shell, EDITOR};

/// How often the watchdog looks.
const EVERY: Duration = Duration::from_secs(2);
/// A window that has not said it is alive for this long is reloaded. Pages say so every 2 s,
/// so a dead window is back within about 10 s.
const SILENT: Duration = Duration::from_secs(8);
/// A window that just opened or was reloaded gets this long to load and say it is alive.
const SETTLE: Duration = Duration::from_secs(30);
/// After this many reloads that did not bring a window back, every window is opened again.
const RELOADS: u32 = 2;

#[derive(Default)]
struct Watch {
    /// The host the counts below belong to.
    host: Option<Weak<AppState>>,
    /// Host incidents already written to the operator log.
    seen: u64,
    windows: HashMap<String, WindowWatch>,
    /// The day the nightly restart last ran, so it runs once.
    nightly: Option<chrono::NaiveDate>,
}

struct WindowWatch {
    since: Instant,
    reloaded: Option<Instant>,
    reloads: u32,
}

pub async fn run(app: AppHandle) {
    let mut watch = Watch::default();
    let mut every = tokio::time::interval(EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        every.tick().await;
        check(&app, &mut watch).await;
    }
}

async fn check(app: &AppHandle, watch: &mut Watch) {
    let shell = app.state::<Shell>();
    let Some(running) = shell.running.lock().unwrap().clone() else {
        watch.windows.clear();
        return;
    };
    // A table that is starting or stopping holds the lock; it is looked at next time.
    let host = match shell.host.try_lock() {
        Ok(host) => host.as_ref().map(|h| (h.state.clone(), h.is_serving())),
        Err(_) => return,
    };
    let Some((state, serving)) = host else { return };
    if !watch.host.as_ref().and_then(Weak::upgrade).is_some_and(|h| Arc::ptr_eq(&h, &state)) {
        *watch = Watch { host: Some(Arc::downgrade(&state)), nightly: watch.nightly, ..Default::default() };
    }

    let (incidents, total) = state.health.incidents_after(watch.seen);
    watch.seen = total;
    for (_, message) in incidents {
        shell.operator.note(message);
    }

    let presenting = is_presenting(app);
    if !serving {
        shell.operator.note(format!("The server of '{}' stopped by itself. Starting the table again.", running.name));
        restart(app, &running, presenting).await;
        return;
    }
    if presenting {
        windows(app, &state, watch, &running).await;
    } else {
        watch.windows.clear();
    }
    nightly(app, watch, &running, presenting).await;
}

/// Reloads a table or controller window that stopped saying it is alive.
async fn windows(app: &AppHandle, state: &AppState, watch: &mut Watch, running: &Running) {
    let shell = app.state::<Shell>();
    let now = Instant::now();
    let open: Vec<_> = app.webview_windows().into_iter().filter(|(label, _)| label.starts_with("surface-")).collect();
    watch.windows.retain(|label, _| open.iter().any(|(l, _)| l == label));
    state.health.forget(|label| open.iter().any(|(l, _)| l == label));
    let beats = state.health.windows();
    let mut reopen = false;
    for (label, window) in &open {
        let entry = watch.windows.entry(label.clone()).or_insert(WindowWatch { since: now, reloaded: None, reloads: 0 });
        let beat = beats.iter().find(|b| &b.window == label);
        let quiet = match beat {
            Some(beat) => beat.age,
            None => now.duration_since(entry.since),
        };
        // Loading after an opening or a reload: judged once it has spoken or the time is up.
        let started = entry.reloaded.unwrap_or(entry.since);
        let spoke_since = beat.is_some_and(|b| b.age < now.duration_since(started));
        let settling = !spoke_since && now.duration_since(started) < SETTLE;
        if quiet < SILENT {
            // Alive again after a reload: the next failure starts the count afresh.
            if spoke_since {
                entry.reloads = 0;
            }
            continue;
        }
        if settling {
            continue;
        }
        if entry.reloads >= RELOADS {
            reopen = true;
            break;
        }
        let role = label.rsplit('-').next().unwrap_or("table");
        shell.operator.note(format!("The {role} window has not answered for {} s. Reloading it.", quiet.as_secs()));
        let url = format!("http://127.0.0.1:{}/{role}", running.port).parse().expect("a valid surface address");
        // A navigation, not a script: it works even when the page's script has stopped.
        if let Err(e) = window.navigate(url) {
            shell.operator.note(format!("The {role} window could not be reloaded ({e})."));
        }
        entry.reloaded = Some(now);
        entry.reloads += 1;
    }
    if reopen {
        shell.operator.note("A window still did not answer after two reloads. Opening the windows again.");
        watch.windows.clear();
        match usual_displays(app).and_then(|displays| show(app, &displays)) {
            Ok(()) => {}
            Err(e) => shell.operator.note(format!("The windows could not be opened again: {e:#}")),
        }
    }
}

/// The nightly restart, for a table that runs for weeks: once a day, at the chosen minute.
async fn nightly(app: &AppHandle, watch: &mut Watch, running: &Running, presenting: bool) {
    let shell = app.state::<Shell>();
    let Some(at) = shell.settings().nightly_restart else { return };
    let now = chrono::Local::now();
    if !presenting || now.format("%H:%M").to_string() != at || watch.nightly == Some(now.date_naive()) {
        return;
    }
    watch.nightly = Some(now.date_naive());
    shell.operator.note(format!("Nightly restart of '{}'.", running.name));
    restart(app, running, true).await;
}

/// Starts the table again and puts it back on the screens it was on.
async fn restart(app: &AppHandle, running: &Running, present: bool) {
    let shell = app.state::<Shell>();
    let started = launch(app, running.site.clone(), running.lan).await;
    let shown = started.and_then(|()| if present { usual_displays(app).and_then(|d| show(app, &d)) } else { Ok(()) });
    match shown {
        Ok(()) => {
            shell.operator.note(format!("'{}' is running again{}.", running.name, if present { " and presented" } else { "" }));
            if app.get_webview_window(EDITOR).is_some() {
                let _ = open_editor(app, "edit");
            }
        }
        Err(e) => shell.operator.note(format!("'{}' could not be started again: {e:#}", running.name)),
    }
}
