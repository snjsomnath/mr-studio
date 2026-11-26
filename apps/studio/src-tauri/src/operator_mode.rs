//! Operator mode (#394): the exhibition computer runs the table with a small window of its own in
//! place of the editor. Present and stop, which screen is which, restart a stuck screen, and how
//! the table is doing. Leaving it takes a PIN, so visitors at the controller or the table's
//! computer never reach the editor or the desktop.
//!
//! A forgotten PIN is never a lock-out: "Forgot the PIN" asks for this computer's own password,
//! and so does starting the app with Shift held. `mrstudio operator off` turns it off from a
//! terminal. The editor itself is unchanged; this only adds ways in and one way out.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

/// Wrong PINs in a row before the window waits.
const TRIES: u32 = 5;
/// How long it waits after that many.
const WAIT: Duration = Duration::from_secs(30);

/// Operator mode's state while the app runs.
#[derive(Default)]
pub struct OperatorMode {
    on: AtomicBool,
    wrong: AtomicU32,
    blocked_until: Mutex<Option<Instant>>,
}

impl OperatorMode {
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    pub fn set(&self, on: bool) {
        self.on.store(on, Ordering::SeqCst);
        if !on {
            self.wrong.store(0, Ordering::SeqCst);
        }
    }

    /// Checks a PIN against the saved hash, with a pause after several wrong ones.
    pub fn check(&self, pin: &str, saved: Option<&str>) -> Result<(), String> {
        if let Some(until) = *self.blocked_until.lock().unwrap() {
            let now = Instant::now();
            if now < until {
                return Err(format!("Too many wrong PINs. Try again in {} seconds.", (until - now).as_secs() + 1));
            }
        }
        let Some(saved) = saved else {
            // No PIN set yet: leaving is free, and the window says so.
            return Ok(());
        };
        if verify_pin(pin, saved) {
            self.wrong.store(0, Ordering::SeqCst);
            *self.blocked_until.lock().unwrap() = None;
            return Ok(());
        }
        let wrong = self.wrong.fetch_add(1, Ordering::SeqCst) + 1;
        if wrong >= TRIES {
            self.wrong.store(0, Ordering::SeqCst);
            *self.blocked_until.lock().unwrap() = Some(Instant::now() + WAIT);
            return Err(format!("That PIN is not right. Wait {} seconds before trying again.", WAIT.as_secs()));
        }
        Err("That PIN is not right.".into())
    }
}

/// A PIN is 4 to 8 digits.
pub fn valid_pin(pin: &str) -> bool {
    (4..=8).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

/// The PIN as saved: `sha256$<salt>$<hex of sha256(salt:pin)>`.
pub fn hash_pin(pin: &str) -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let salt = hex(&Sha256::digest(format!("{nanos}:{}", std::process::id()).as_bytes())[..8]);
    format!("sha256${salt}${}", digest(&salt, pin))
}

pub fn verify_pin(pin: &str, saved: &str) -> bool {
    let mut parts = saved.splitn(3, '$');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("sha256"), Some(salt), Some(hash)) => {
            let ours = digest(salt, pin);
            // The same time whatever the answer.
            ours.len() == hash.len() && ours.bytes().zip(hash.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
        }
        _ => false,
    }
}

fn digest(salt: &str, pin: &str) -> String {
    hex(&Sha256::digest(format!("{salt}:{pin}").as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether Shift is held down now, for "start with Shift held to leave operator mode".
pub fn shift_held() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceFlagsState(state: i32) -> u64;
        }
        const COMBINED_SESSION_STATE: i32 = 0;
        const SHIFT: u64 = 0x0002_0000;
        // SAFETY: a plain query of the keyboard's modifier state; no pointers.
        unsafe { CGEventSourceFlagsState(COMBINED_SESSION_STATE) & SHIFT != 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
        // SAFETY: a plain query of one key's state.
        unsafe { (GetAsyncKeyState(VK_SHIFT as i32) as u16) & 0x8000 != 0 }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        false
    }
}

/// Checks this computer's own password for the person logged in: the way past a forgotten PIN.
/// macOS asks Directory Services about the logged-in account; Windows asks for a logon of it.
/// Elsewhere (a development computer) it is the password `sudo` asks for.
pub fn verify_computer_password(password: &str) -> Result<bool, String> {
    if password.is_empty() {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{LogonUserW, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let user = std::env::var("USERNAME").map_err(|_| "this computer did not say who is logged in".to_string())?;
        let domain = std::env::var("USERDOMAIN").unwrap_or_else(|_| ".".into());
        let (user, domain, password) = (wide(&user), wide(&domain), wide(password));
        let mut token = std::ptr::null_mut();
        // SAFETY: the strings are NUL-terminated and live through the call; the token is closed.
        let ok = unsafe {
            LogonUserW(user.as_ptr(), domain.as_ptr(), password.as_ptr(), LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, &mut token)
        };
        if ok != 0 {
            // SAFETY: a handle LogonUserW just gave us.
            unsafe { CloseHandle(token) };
        }
        Ok(ok != 0)
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let user = std::env::var("USER").map_err(|_| "this Mac did not say who is logged in".to_string())?;
        let status = Command::new("/usr/bin/dscl")
            .args([".", "-authonly", &user, password])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| format!("the password could not be checked ({e})"))?;
        Ok(status.success())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        // `-k` forgets any earlier yes, so the password is always asked; it reads it on stdin.
        let mut child = Command::new("/usr/bin/sudo")
            .args(["-k", "-S", "-p", "", "-v"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("the password could not be checked ({e})"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{password}");
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let _ = Command::new("/usr/bin/sudo").arg("-k").status();
        Ok(status.success())
    }
}

// ---- The window and its commands ----

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::{
    is_presenting, launch, list_displays, open_editor, open_home_window, report, show, text, usual_displays, Shell, EDITOR, HOME, LAUNCHER,
    SOURCES,
};

/// The operator window's label.
pub const WINDOW: &str = "operator";

/// Opens the operator window, or brings it forward.
pub fn open_window(app: &AppHandle) -> anyhow::Result<()> {
    open_window_at(app, "")
}

/// The same, at one of its pages: `shift` when the app started with Shift held.
pub fn open_window_at(app: &AppHandle, page: &str) -> anyhow::Result<()> {
    let window = match app.get_webview_window(WINDOW) {
        Some(window) => window,
        None => {
            let url = if page.is_empty() { "operator.html".to_string() } else { format!("operator.html#{page}") };
            let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App(url.into()))
                .title("MR Studio · Operator")
                .inner_size(760.0, 620.0)
                .min_inner_size(560.0, 480.0)
                .center()
                .build()?;
            // In operator mode the window does not close: leaving takes the PIN. It goes out of
            // the way instead. Once operator mode is off it closes as any window does.
            let handle = app.clone();
            window.on_window_event(move |event| {
                let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
                if handle.state::<Shell>().operator_mode.is_on() {
                    api.prevent_close();
                    if let Some(window) = handle.get_webview_window(WINDOW) {
                        let _ = window.minimize();
                    }
                }
            });
            window
        }
    };
    window.set_always_on_top(is_presenting(app))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Leaves operator mode for this session: to the editor, or Home with no table open, or quits.
fn leave(app: &AppHandle, quit: bool) -> Result<(), String> {
    let shell = app.state::<Shell>();
    shell.operator_mode.set(false);
    shell.operator.note(if quit { "Left operator mode and quit." } else { "Left operator mode for the editor." });
    if quit {
        app.exit(0);
        return Ok(());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The editor first: with no other window the app would quit.
        let has_table = app.state::<Shell>().running.lock().unwrap().is_some();
        report(if has_table { open_editor(&app, "edit") } else { open_home_window(&app) });
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.destroy();
        }
    });
    Ok(())
}

/// Home's and the editor's "Open operator mode": the operator window in place of the shell's
/// own pages, until the PIN is given. The table stays as it is.
#[tauri::command]
pub async fn open_operator(app: AppHandle, shell: State<'_, Shell>) -> Result<(), String> {
    shell.operator_mode.set(true);
    shell.operator.note("Operator mode opened.");
    open_window(&app).map_err(text)?;
    for label in [HOME, LAUNCHER, SOURCES] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
    // The editor closes the way its close button does, keeping a picture for Home.
    if let Some(editor) = app.get_webview_window(EDITOR) {
        let _ = editor.close();
    }
    Ok(())
}

#[derive(Serialize)]
pub struct OperatorState {
    on: bool,
    pin_set: bool,
    start: bool,
    /// The table open now, and the one the app presents when none is.
    table: Option<String>,
    last_table: Option<String>,
    presenting: bool,
    lan: bool,
    code: Option<String>,
    phones: usize,
    screens: Vec<Screen>,
    /// Layers that failed or are retrying, in words.
    problems: Vec<String>,
    version: String,
    mac: bool,
}

#[derive(Serialize)]
struct Screen {
    number: usize,
    name: String,
    primary: bool,
    /// What it shows: `table`, `tv` or `dev`.
    shows: Vec<String>,
    /// Frames a second of its window, and whether it said it was alive in the last 8 s.
    fps: Option<f64>,
    alive: Option<bool>,
}

#[tauri::command]
pub async fn operator_state(app: AppHandle, shell: State<'_, Shell>) -> Result<OperatorState, String> {
    let settings = shell.settings();
    let running = shell.running.lock().unwrap().clone();
    let state = shell.host.lock().await.as_ref().map(|h| h.state.clone());
    let beats = state.as_ref().map(|s| s.health.windows()).unwrap_or_default();
    let surfaces = shell.surfaces.lock().unwrap().clone();
    let screens = list_displays(&app)
        .map_err(text)?
        .into_iter()
        .map(|d| {
            let here: Vec<&String> = surfaces.iter().filter(|(_, at)| *at == d.index).map(|(label, _)| label).collect();
            let beat = beats.iter().find(|b| here.contains(&&b.window));
            Screen {
                number: d.index + 1,
                name: d.model.clone().or(d.name.clone()).unwrap_or_else(|| "Display".into()),
                primary: d.primary,
                shows: here.iter().map(|label| label.rsplit('-').next().unwrap_or("").to_string()).collect(),
                fps: beat.map(|b| b.fps),
                alive: (!here.is_empty()).then(|| beat.is_some_and(|b| b.age < Duration::from_secs(8))),
            }
        })
        .collect();
    let problems = state
        .as_ref()
        .map(|s| {
            s.hub
                .layer_health()
                .iter()
                .filter_map(|l| {
                    let health = l.get("health")?.as_object()?;
                    Some(format!(
                        "{}: {}",
                        l["id"].as_str().unwrap_or("a layer"),
                        health.get("reason").and_then(|r| r.as_str()).unwrap_or("not working")
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let last_table = settings.site.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string());
    Ok(OperatorState {
        on: shell.operator_mode.is_on(),
        pin_set: settings.operator_pin.is_some(),
        start: settings.operator_start,
        table: running.as_ref().map(|r| r.name.clone()),
        last_table,
        presenting: is_presenting(&app),
        lan: running.as_ref().is_some_and(|r| r.lan),
        code: running.as_ref().filter(|r| r.lan).map(|r| r.code.clone()),
        phones: state.as_ref().map(|s| s.hub.phones_connected()).unwrap_or(0),
        screens,
        problems,
        version: app.package_info().version.to_string(),
        mac: cfg!(target_os = "macos"),
    })
}

/// Present: the open table, or the last one when none is open, on the usual screens.
#[tauri::command]
pub async fn operator_present(app: AppHandle, shell: State<'_, Shell>) -> Result<(), String> {
    if shell.running.lock().unwrap().is_none() {
        let settings = shell.settings();
        let site = settings.site.clone().ok_or("No table has been opened on this computer yet. Leave operator mode and open one first.")?;
        launch(&app, site, settings.lan).await.map_err(|e| format!("{e:#}"))?;
    }
    shell.operator.note("Presented from the operator window.");
    crate::present(app.clone(), shell, None).await
}

/// Opens the screens' windows again: for a screen that went black or shows the wrong thing.
#[tauri::command]
pub async fn operator_restart_screens(app: AppHandle, shell: State<'_, Shell>) -> Result<(), String> {
    if !is_presenting(&app) {
        return Err("Nothing is on the screens. Press Present.".into());
    }
    shell.operator.note("Screens opened again from the operator window.");
    show(&app, &usual_displays(&app).map_err(text)?).map_err(text)
}

/// Sets the PIN. Changing one takes the one before.
#[tauri::command]
pub async fn operator_set_pin(shell: State<'_, Shell>, current: Option<String>, pin: String) -> Result<(), String> {
    if !valid_pin(&pin) {
        return Err("A PIN is 4 to 8 digits.".into());
    }
    let mut settings = shell.settings();
    shell.operator_mode.check(current.as_deref().unwrap_or(""), settings.operator_pin.as_deref())?;
    settings.operator_pin = Some(hash_pin(&pin));
    settings.write(&shell.settings_path()).map_err(text)?;
    shell.operator.note("The operator PIN was set.");
    Ok(())
}

/// Leaves operator mode with the PIN: to the editor, or `quit`.
#[tauri::command]
pub async fn operator_exit(app: AppHandle, shell: State<'_, Shell>, pin: String, quit: bool) -> Result<(), String> {
    let settings = shell.settings();
    shell.operator_mode.check(&pin, settings.operator_pin.as_deref())?;
    leave(&app, quit)
}

/// The way past a forgotten PIN: this computer's password, then a new PIN, or (with no `pin`,
/// after a start with Shift held) straight out to the editor.
#[tauri::command]
pub async fn operator_password(app: AppHandle, shell: State<'_, Shell>, password: String, pin: Option<String>) -> Result<(), String> {
    if let Some(pin) = &pin {
        if !valid_pin(pin) {
            return Err("A PIN is 4 to 8 digits.".into());
        }
    }
    let right = tauri::async_runtime::spawn_blocking(move || verify_computer_password(&password)).await.map_err(text)??;
    if !right {
        // A moment between tries, as a login window takes.
        tokio::time::sleep(Duration::from_secs(2)).await;
        return Err("That is not this computer's password.".into());
    }
    match pin {
        Some(pin) => {
            let mut settings = shell.settings();
            settings.operator_pin = Some(hash_pin(&pin));
            settings.write(&shell.settings_path()).map_err(text)?;
            shell.operator.note("The operator PIN was reset with this computer's password.");
            Ok(())
        }
        None => leave(&app, false),
    }
}

/// Settings' "Start in operator mode".
#[tauri::command]
pub async fn set_operator_start(shell: State<'_, Shell>, on: bool) -> Result<(), String> {
    let mut settings = shell.settings();
    settings.operator_start = on;
    settings.write(&shell.settings_path()).map_err(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_is_saved_salted_and_checked() {
        let saved = hash_pin("2468");
        assert!(saved.starts_with("sha256$"));
        assert!(!saved.contains("2468"));
        assert!(verify_pin("2468", &saved));
        assert!(!verify_pin("2469", &saved));
        assert!(!verify_pin("2468", "plain"));
        assert!(valid_pin("0000") && valid_pin("12345678"));
        assert!(!valid_pin("123") && !valid_pin("12a4") && !valid_pin("123456789"));
    }

    #[test]
    fn wrong_pins_make_it_wait() {
        let mode = OperatorMode::default();
        let saved = hash_pin("1357");
        for _ in 0..TRIES - 1 {
            assert_eq!(mode.check("0000", Some(&saved)), Err("That PIN is not right.".into()));
        }
        assert!(mode.check("0000", Some(&saved)).unwrap_err().contains("Wait 30 seconds"));
        // Even the right one waits now.
        assert!(mode.check("1357", Some(&saved)).unwrap_err().contains("Try again in"));
        // No PIN set: leaving is free.
        assert!(OperatorMode::default().check("", None).is_ok());
    }
}
