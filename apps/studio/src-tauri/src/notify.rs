//! Notifications when a long job finishes while MR Studio is not in front (#702): a table
//! exported or packed to share, or data brought in from OpenStreetMap. The computer's own
//! notification (a Windows toast, macOS Notification Centre). None while a window of the app
//! is in front, where the editor already says so, and none while presenting, so a show on the
//! table and controller is never interrupted. Clicking it brings MR Studio forward, and the
//! window the job belonged to comes to the front.

use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/// The window a notification was about, until MR Studio comes forward or it is old news.
#[derive(Default)]
pub struct Waiting(Mutex<Option<(String, Instant)>>);

/// A notification left unanswered this long no longer moves windows when the app comes forward.
const FORGET_AFTER: Duration = Duration::from_secs(15 * 60);

/// Why a finished job gets no notification, if it gets none.
pub fn quiet_reason(in_front: bool, presenting: bool) -> Option<&'static str> {
    if presenting {
        Some("presenting")
    } else if in_front {
        Some("in front")
    } else {
        None
    }
}

/// Tells the person that `title` is done, when they are elsewhere. `window` is the window to
/// bring forward when they come back.
pub fn job_done(app: &AppHandle, window: &str, title: &str, body: &str) {
    let in_front = app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
    if let Some(reason) = quiet_reason(in_front, crate::screens::is_presenting(app)) {
        tracing::debug!("no notification for '{title}': {reason}");
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!("could not show a notification: {e}");
        return;
    }
    if let Some(waiting) = app.try_state::<Waiting>() {
        *waiting.0.lock() = Some((window.to_string(), Instant::now()));
    }
}

/// A window of the app came forward: when the person is answering a notification, the window
/// the job belonged to comes to the front instead of whichever one the system picked.
pub fn focused(app: &AppHandle, label: &str) {
    let Some(waiting) = app.try_state::<Waiting>() else { return };
    let Some((window, at)) = waiting.0.lock().take() else { return };
    if window == label || at.elapsed() > FORGET_AFTER {
        return;
    }
    if let Some(w) = app.get_webview_window(&window) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// `job_finished { title, body }`: the editor finished something long (#702), such as bringing
/// data in. It belongs to the window that asks.
#[tauri::command]
pub(crate) fn job_finished(app: AppHandle, window: WebviewWindow, title: String, body: String) {
    job_done(&app, window.label(), &title, &body);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_when_elsewhere_and_not_presenting() {
        assert_eq!(quiet_reason(false, false), None);
        assert_eq!(quiet_reason(true, false), Some("in front"));
        assert_eq!(quiet_reason(false, true), Some("presenting"));
        assert_eq!(quiet_reason(true, true), Some("presenting"));
    }
}
