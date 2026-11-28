//! Windows and displays: the shell's own windows, listing displays, placing the table, the
//! controller and the editor on them, presenting and full screen (#541).

use super::*;

pub(crate) fn open_home_window(app: &AppHandle) -> anyhow::Result<()> {
    if app.state::<Shell>().operator_mode.is_on() {
        return operator_mode::open_window(app);
    }
    let window = match app.get_webview_window(HOME) {
        Some(window) => window,
        None => WebviewWindowBuilder::new(app, HOME, WebviewUrl::App("home.html".into()))
            .title("MR Studio")
            .inner_size(1040.0, 720.0)
            .min_inner_size(760.0, 560.0)
            .center()
            .build()?,
    };
    window.set_always_on_top(is_presenting(app))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub(crate) fn open_launcher(app: &AppHandle) -> anyhow::Result<()> {
    open_launcher_at(app, None)
}

/// File › Settings (#393), opened at one of its pages (`setup`, `calibration`, `colour`, ...) when named.
pub(crate) fn open_launcher_at(app: &AppHandle, page: Option<&str>) -> anyhow::Result<()> {
    if app.state::<Shell>().operator_mode.is_on() {
        return operator_mode::open_window(app);
    }
    let page = page.filter(|p| p.chars().all(|c| c.is_ascii_lowercase()));
    let window = match app.get_webview_window(LAUNCHER) {
        Some(window) => {
            // An open window goes to the page asked for, the way its address would.
            if let Some(page) = page {
                window.eval(format!("document.querySelector('[role=tab][data-tab=\"{page}\"]')?.click()"))?;
            }
            window
        }
        None => WebviewWindowBuilder::new(
            app,
            LAUNCHER,
            WebviewUrl::App(page.map_or_else(|| String::from("index.html"), |p| format!("index.html#{p}")).into()),
        )
        .title("MR Studio · Settings")
        .inner_size(launcher_size(app).0, launcher_size(app).1)
        .min_inner_size(820.0, 560.0)
        .center()
        .build()
        .inspect(|window| {
            // The size it is left at is the size it opens at next time (#558).
            let handle = app.clone();
            let watched = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(_) = event {
                    if let (Ok(size), Ok(scale)) = (watched.inner_size(), watched.scale_factor()) {
                        let logical = size.to_logical::<f64>(scale);
                        let path = handle.state::<Shell>().config_dir.join("settings-window.json");
                        let _ = std::fs::write(path, format!("{{\"width\":{:.0},\"height\":{:.0}}}", logical.width, logical.height));
                    }
                }
            });
        })?,
    };
    // A fullscreen surface may cover the display the launcher is on.
    window.set_always_on_top(is_presenting(app))?;
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Sources and keys (#41) is a page of Settings, opened in place like the others (#593).
pub(crate) fn open_sources_window(app: &AppHandle) -> anyhow::Result<()> {
    open_launcher_at(app, Some("sources"))
}

/// The size File › Settings opens at (#558): where it was last left, else most of the display it
/// opens on, so the screens, Present and Calibration pages have room; never smaller than before.
pub(crate) fn launcher_size(app: &AppHandle) -> (f64, f64) {
    const DEFAULT: (f64, f64) = (1080.0, 720.0);
    let saved = std::fs::read_to_string(app.state::<Shell>().config_dir.join("settings-window.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| Some((v.get("width")?.as_f64()?, v.get("height")?.as_f64()?)));
    let monitor = app.primary_monitor().ok().flatten().map(|m| {
        let size = m.size().to_logical::<f64>(m.scale_factor());
        (size.width, size.height)
    });
    let fit = |(w, h): (f64, f64)| match monitor {
        Some((mw, mh)) => (w.min(mw * 0.95).max(820.0), h.min(mh * 0.9).max(560.0)),
        None => (w, h),
    };
    match (saved, monitor) {
        (Some(size), _) => fit(size),
        (None, Some((mw, mh))) => fit(((mw * 0.8).max(DEFAULT.0).min(1680.0), (mh * 0.85).max(DEFAULT.1).min(1100.0))),
        (None, None) => DEFAULT,
    }
}

pub(crate) fn list_displays(app: &AppHandle) -> anyhow::Result<Vec<Display>> {
    let primary = app.primary_monitor()?;
    let is_primary = |m: &tauri::Monitor| primary.as_ref().is_some_and(|p| p.position() == m.position() && p.name() == m.name());
    let monitors = app.available_monitors()?;
    #[cfg(windows)]
    let models = models::models();
    // macOS only gives "Monitor #<model number>" (#579): the system's own names and sizes instead (#612).
    #[cfg(target_os = "macos")]
    let screens = mac_displays::screens(app);
    #[cfg(target_os = "macos")]
    let screen = |name: Option<&String>| name.and_then(|n| mac_displays::model_number(n)).and_then(|model| screens.get(&model));
    let model = |name: Option<&String>| -> Option<String> {
        #[cfg(windows)]
        if let Some((_, model)) = models.iter().find(|(system, _)| Some(system) == name) {
            return Some(model.clone());
        }
        #[cfg(target_os = "macos")]
        if let Some(screen) = screen(name) {
            return Some(screen.name.clone());
        }
        name.filter(|n| !n.is_empty() && !n.starts_with(r"\\.\") && !n.starts_with("Monitor #")).cloned()
    };
    let displays = monitors.iter().enumerate().map(|(index, m)| {
        let model = model(m.name());
        let kind = model.as_deref().and_then(Kind::guess);
        #[cfg(target_os = "macos")]
        let kind = kind.or_else(|| screen(m.name()).and_then(mac_displays::kind_by_size));
        Display {
            index,
            name: m.name().cloned(),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
            primary: is_primary(m),
            kind,
            model,
        }
    });
    Ok(displays.collect())
}

/// Names for macOS displays, which the window library calls "Monitor #<model number>" (#579).
#[cfg(target_os = "macos")]
pub(crate) mod mac_displays {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    use objc2_foundation::{ns_string, NSNumber};
    use tauri::AppHandle;

    use crate::config::Kind;

    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayModelNumber(display: u32) -> u32;
        fn CGDisplayIsBuiltin(display: u32) -> i32;
        fn CGDisplayScreenSize(display: u32) -> CGSize;
    }

    /// What macOS says about one display.
    pub struct Screen {
        /// The name the system shows, such as "LG TV SSCR2" or "EPSON PJ" (#612).
        pub name: String,
        /// Width in millimetres from the display's own data; 0 when it gives none.
        pub width_mm: f64,
    }

    /// Every active display by model number. The names come from AppKit, which answers only
    /// on the main thread, so from elsewhere the question is sent there and waited for briefly.
    pub fn screens(app: &AppHandle) -> HashMap<u32, Screen> {
        let names = match MainThreadMarker::new() {
            Some(mtm) => names(mtm),
            None => {
                let (tx, rx) = mpsc::channel();
                let asked = app.run_on_main_thread(move || {
                    if let Some(mtm) = MainThreadMarker::new() {
                        let _ = tx.send(names(mtm));
                    }
                });
                if asked.is_ok() {
                    rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default()
                } else {
                    HashMap::new()
                }
            }
        };
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: the list has room for the 16 displays asked for, and `count` says how many were written.
        if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) } != 0 {
            return HashMap::new();
        }
        let mut out = HashMap::new();
        for &id in &ids[..(count as usize).min(ids.len())] {
            // SAFETY: plain queries on display ids the system just listed.
            let (model, builtin, size) = unsafe { (CGDisplayModelNumber(id), CGDisplayIsBuiltin(id) != 0, CGDisplayScreenSize(id)) };
            let name = if builtin {
                "Built-in display".to_string()
            } else {
                names.get(&id).filter(|n| !n.trim().is_empty()).cloned().unwrap_or_else(|| "External display".into())
            };
            out.insert(model, Screen { name, width_mm: if size.width.is_finite() { size.width } else { 0.0 } });
        }
        out
    }

    /// The system's display names by display id: what System Settings › Displays shows.
    fn names(mtm: MainThreadMarker) -> HashMap<u32, String> {
        let mut out = HashMap::new();
        for screen in NSScreen::screens(mtm).iter() {
            let description = screen.deviceDescription();
            let Some(number) = description.objectForKey(ns_string!("NSScreenNumber")) else { continue };
            let Ok(number) = Retained::downcast::<NSNumber>(number) else { continue };
            out.insert(number.unsignedIntValue(), screen.localizedName().to_string());
        }
        out
    }

    /// The display's model number from the window library's "Monitor #<model number>".
    pub fn model_number(name: &str) -> Option<u32> {
        name.strip_prefix("Monitor #")?.trim().parse().ok()
    }

    /// When the name says nothing (#612): over a metre across is a TV. A projector reports
    /// no size or a made-up one, so it is never guessed from size.
    pub fn kind_by_size(screen: &Screen) -> Option<Kind> {
        (screen.width_mm > 1000.0 && screen.name != "Built-in display").then_some(Kind::Tv)
    }
}

/// Opens one surface of the running site in a normal window, for looking at it beside the editor.
pub(crate) fn show_view(app: &AppHandle, role: &str) -> anyhow::Result<()> {
    anyhow::ensure!(["table", "tv", "dev", "phone", "help"].contains(&role), "'{role}' is not a view");
    let running = app.state::<Shell>().running.lock().clone().context("no site is open")?;
    let label = format!("view-{role}");
    let window = match app.get_webview_window(&label) {
        Some(window) => window,
        None => {
            let url = format!("http://127.0.0.1:{}/{role}", running.port).parse().expect("valid view url");
            let (width, height) = match role {
                "phone" => (420.0, 800.0),
                "help" => (1040.0, 760.0),
                _ => (1100.0, 700.0),
            };
            // Help (#271) is about the app, not the table, so its title does not name the table.
            let title = if role == "help" { "MR Studio Help".to_string() } else { format!("MR Studio · {} · {role}", running.name) };
            // The page's Full screen control (#198) reaches the shell here: WKWebView on macOS has no
            // requestFullscreen (#420). It fills the table's window while presenting, else this one.
            let handle = app.clone();
            let me = label.clone();
            WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
                .title(title)
                .inner_size(width, height)
                .initialization_script("window.__MRS_SHELL__ = true;")
                .on_navigation(move |url| match url.path().strip_prefix("/__shell/") {
                    Some("fullscreen") => {
                        let handle = handle.clone();
                        let me = me.clone();
                        drop(tauri::async_runtime::spawn(async move {
                            report(if table_window(&handle).is_some() {
                                toggle_table_fullscreen(&handle)
                            } else {
                                toggle_view_fullscreen(&handle, &me)
                            })
                        }));
                        false
                    }
                    Some(action) => {
                        shell_action(&handle, action);
                        false
                    }
                    None => true,
                })
                .build()?
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

pub(crate) fn close_surfaces(app: &AppHandle) -> anyhow::Result<()> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("surface-") {
            window.destroy()?;
        }
    }
    app.state::<Shell>().surfaces.lock().clear();
    Ok(())
}

pub(crate) fn is_presenting(app: &AppHandle) -> bool {
    app.webview_windows().keys().any(|label| label.starts_with("surface-"))
}

/// Puts the running site on the displays: one window per entry of `displays`, replacing
/// the ones that are open.
pub(crate) fn show(app: &AppHandle, displays: &Displays) -> anyhow::Result<()> {
    let port = app.state::<Shell>().running.lock().as_ref().map(|r| r.port).context("no site is open")?;
    close_surfaces(app)?;
    open_surfaces(app, port, displays)
}

/// The displays to present on when nobody says: the saved choice while it fits what is
/// connected, else the table and the controller fullscreen on displays of their own.
pub(crate) fn usual_displays(app: &AppHandle) -> anyhow::Result<Displays> {
    let saved = Displays::read(&app.state::<Shell>().displays_path()).unwrap_or_else(|e| {
        tracing::warn!("displays.json: {e}; presenting on the suggested displays");
        None
    });
    Ok(Displays::usual(saved, &list_displays(app)?))
}

/// Opens the running site in the editor window, at `page` of the host: `edit` for the
/// editor, `edit?welcome=1` for a table that was just created, `new` for the new-table wizard.
pub(crate) fn open_editor(app: &AppHandle, page: &str) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    if shell.operator_mode.is_on() {
        return operator_mode::open_window(app);
    }
    let running = shell.running.lock().clone().context("no site is open")?;
    // A read-only copy stays read-only however the editor is reopened: after operator mode,
    // Present, a reload or the Window menu (#575). The copy is what says so, not the page asked for.
    let page = match is_read_only_copy(app, &running.site) && page != "new" && !page.contains("readonly=1") {
        true => format!("{page}{}readonly=1", if page.contains('?') { '&' } else { '?' }),
        false => page.to_string(),
    };
    let page = page.as_str();
    let url: tauri::Url = format!("http://127.0.0.1:{}/{page}", running.port).parse().context("the editor's address")?;
    let title = if page == "new" {
        "MR Studio · New table".to_string()
    } else if page.contains("readonly=1") {
        format!("MR Studio · {} (read-only)", running.name)
    } else {
        format!("MR Studio · {}", running.name)
    };
    let stale = shell.editor_stale.swap(false, Ordering::Relaxed);
    let window = match app.get_webview_window(EDITOR) {
        Some(window) => {
            if stale || window.url().ok().as_ref() != Some(&url) {
                window.navigate(url)?;
            }
            window.set_title(&title)?;
            window
        }
        None => {
            let handle = app.clone();
            let builder = WebviewWindowBuilder::new(app, EDITOR, WebviewUrl::External(url));
            #[cfg(not(target_os = "macos"))]
            let builder = builder.menu(file_menu::editor_menu(app)?);
            let window = builder
                .title(title)
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .initialization_script(EDITOR_BAR)
                // Licence reminders (#729): only when licensing is shown and there is one.
                .initialization_script(format!(
                    "window.__MRS_LICENCE_REMINDER__ = {};\n{LICENCE_BANNER}",
                    serde_json::to_string(&licence::editor_reminder(&app.state::<Shell>())).unwrap_or_else(|_| "null".into())
                ))
                .on_navigation(move |url| match url.path().strip_prefix("/__shell/") {
                    Some(action) => {
                        shell_action(&handle, action);
                        false
                    }
                    None => true,
                })
                .build()?;
            // Closing the editor leads back to Home, as closing a document does. While the table
            // is being presented it asks whether the show stops too (#656): the projector and the
            // controller would otherwise keep running with no window left that names them. In
            // operator mode the show only stops with the PIN, so nothing is asked. The page first
            // gets a moment to keep a picture of the map for the table's card on Home (#131).
            let handle = app.clone();
            window.on_window_event(move |event| {
                let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
                api.prevent_close();
                let Some(editor) = handle.get_webview_window(EDITOR) else { return };
                let _ = editor.eval("window.mrsBeforeLeave && window.mrsBeforeLeave()");
                let handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(700)).await;
                    if is_presenting(&handle) && !handle.state::<Shell>().operator_mode.is_on() {
                        match ask_stop_presenting(&handle).await {
                            CloseChoice::Cancel => return,
                            CloseChoice::Keep => {}
                            CloseChoice::Stop => {
                                if let Err(e) = stop_presenting(handle.clone()).await {
                                    tracing::warn!("could not stop presenting: {e}");
                                }
                            }
                        }
                    }
                    if !is_presenting(&handle) {
                        report(open_home_window(&handle));
                    }
                    if let Some(editor) = handle.get_webview_window(EDITOR) {
                        report(editor.destroy().map_err(anyhow::Error::from));
                    }
                });
            });
            window
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// What the person picked when the editor closed during a show (#656).
pub(crate) enum CloseChoice {
    Stop,
    Keep,
    Cancel,
}

pub(crate) const CLOSE_TITLE: &str = "Stop presenting too?";
pub(crate) const CLOSE_STOP: &str = "Stop presenting";
pub(crate) const CLOSE_KEEP: &str = "Keep presenting";
pub(crate) const CLOSE_CANCEL: &str = "Cancel";

/// Asks, when the editor closes while the table is on the screens, whether the show stops too.
pub(crate) async fn ask_stop_presenting(app: &AppHandle) -> CloseChoice {
    let name = app.state::<Shell>().running.lock().as_ref().map(|r| r.name.clone()).unwrap_or_else(|| "The table".into());
    let mut asking = app
        .dialog()
        .message(format!(
            "{name} is still on the projector and the controller.\n\nStop presenting closes them and goes back to Home. Keep presenting leaves the show running on its own: press Esc on the projector or the controller, or Ctrl+Shift+E, to bring the editor back."
        ))
        .title(CLOSE_TITLE)
        .kind(tauri_plugin_dialog::MessageDialogKind::Info)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::YesNoCancelCustom(CLOSE_STOP.into(), CLOSE_KEEP.into(), CLOSE_CANCEL.into()));
    if let Some(editor) = app.get_webview_window(EDITOR) {
        asking = asking.parent(&editor);
    }
    use tauri_plugin_dialog::MessageDialogResult as Pressed;
    match tokio::task::spawn_blocking(move || asking.blocking_show_with_result()).await {
        Ok(Pressed::Yes) => CloseChoice::Stop,
        Ok(Pressed::No) => CloseChoice::Keep,
        Ok(Pressed::Custom(label)) if label == CLOSE_STOP => CloseChoice::Stop,
        Ok(Pressed::Custom(label)) if label == CLOSE_KEEP => CloseChoice::Keep,
        _ => CloseChoice::Cancel,
    }
}

/// Closes the shell's own pages once a site is in front.
pub(crate) fn close_shell_pages(app: &AppHandle) {
    for label in [HOME, LAUNCHER] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.close();
        }
    }
}

pub(crate) fn open_surfaces(app: &AppHandle, port: u16, displays: &Displays) -> anyhow::Result<()> {
    let connected = list_displays(app)?;
    let shell = app.state::<Shell>();
    let generation = shell.generation.fetch_add(1, Ordering::Relaxed);
    let colours = ColourConfig::read(&shell.colour_path());
    for (n, spec) in displays.windows.iter().enumerate() {
        let target = spec.display.resolve(&connected).or_else(|| {
            // A window with no display named (the dev window) simply belongs on the primary one.
            if spec.display != Default::default() {
                tracing::warn!("no display matches {:?} for the {} window; using the primary display", spec.display, spec.role);
            }
            connected.iter().find(|d| d.primary).or(connected.first())
        });
        let url = format!("http://127.0.0.1:{port}/{}", spec.role).parse().expect("valid surface url");
        let handle = app.clone();
        let label = format!("surface-{generation}-{n}-{}", spec.role);
        // The colour pass for this display is in place before the page draws anything.
        let colour = target.map(|d| colours.for_display(d)).unwrap_or_default();
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
            .title(format!("MR Studio · {}", spec.role))
            .inner_size(1400.0, 840.0)
            .visible(false);
        // The window is made on its own display, already its size when it is to fill it, so
        // the system knows its screen before full screen starts (#270). A move afterwards is
        // asynchronous on macOS and full screen would size it to the screen it left.
        #[cfg(target_os = "macos")]
        let builder = match target {
            Some(d) => {
                let (x, y, w, h) = logical_frame(d);
                let inset = if spec.fullscreen { 0.0 } else { 60.0 };
                let builder = builder.position(x + inset, y + inset);
                if spec.fullscreen {
                    builder.inner_size(w, h).decorations(false)
                } else {
                    builder
                }
            }
            None => builder,
        };
        let window = builder
            .initialization_script(format!(
                // The window's name, which its page sends with each sign of life (#79).
                "window.__MRS_SHELL__ = true;\nwindow.__MRS_WINDOW__ = {};\nwindow.__MRS_OPERATOR__ = {};\n{SHORTCUTS}\n{}\n{}\n{}",
                serde_json::to_string(&label).expect("a label is a string"),
                shell.operator_mode.is_on(),
                colour::SCRIPT,
                colour.script(),
                // The way back. A table with a controller beside it is seen by visitors, so
                // there it shows only when the pointer goes to the top edge (#295).
                if spec.role == "table" && displays.windows.len() > 1 {
                    format!("window.__MRS_EXIT_QUIET__ = true;\n{SURFACE_EXIT}")
                } else {
                    SURFACE_EXIT.to_string()
                }
            ))
            .on_navigation(move |url| match url.path().strip_prefix("/__shell/") {
                Some(action) => {
                    shell_action(&handle, action);
                    false
                }
                None => true,
            })
            .build()?;
        place(&window, target, spec)?;
        if spec.role == "table" {
            shell.table_fullscreen.store(spec.fullscreen, Ordering::Relaxed);
        }
        if let Some(d) = target {
            shell.surfaces.lock().push((label, d.index));
        }
        tracing::info!("{} window on display {:?}", spec.role, target.map(|d| (d.index, d.name.as_deref().unwrap_or(""))));
    }
    focus_surface(app, &connected);
    let name = shell.running.lock().as_ref().map(|r| r.name.clone()).unwrap_or_default();
    let roles: Vec<&str> = displays.windows.iter().map(|w| w.role.as_str()).collect();
    shell.operator.note(format!("Presenting '{name}' ({}).", roles.join(", ")));
    Ok(())
}

/// Gives the keyboard to the surface on the screen the editor is on, else the table, so Esc
/// and the shortcuts reach a surface rather than the editor hidden behind it (#295). Once the
/// windows have settled, since full screen on macOS is applied after they are shown.
pub(crate) fn focus_surface(app: &AppHandle, connected: &[Display]) {
    let surfaces = app.state::<Shell>().surfaces.lock().clone();
    let editor_display = app.get_webview_window(EDITOR).and_then(|editor| {
        let at = editor.outer_position().ok()?;
        let size = editor.outer_size().ok()?;
        let (cx, cy) = (i64::from(at.x) + i64::from(size.width) / 2, i64::from(at.y) + i64::from(size.height) / 2);
        let inside = |d: &&Display| {
            (i64::from(d.x)..i64::from(d.x) + i64::from(d.width)).contains(&cx)
                && (i64::from(d.y)..i64::from(d.y) + i64::from(d.height)).contains(&cy)
        };
        connected.iter().find(inside).map(|d| d.index)
    });
    let label = editor_display
        .and_then(|index| surfaces.iter().find(|(_, d)| *d == index))
        .or_else(|| surfaces.iter().find(|(label, _)| label.ends_with("-table")))
        .or(surfaces.first())
        .map(|(label, _)| label.clone());
    let Some(label) = label else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for wait in [150, 600] {
            tokio::time::sleep(Duration::from_millis(wait)).await;
            if let Some(window) = app.get_webview_window(&label) {
                report(window.set_focus().map_err(anyhow::Error::from));
            }
        }
    });
}

/// A display's frame in points: what window positions and sizes are given in. A display's
/// pixel position is its point position times its own scale, so with a Retina laptop and a
/// 1x projector a pixel position read with the wrong scale lands on the wrong screen (#270).
pub(crate) fn logical_frame(d: &Display) -> (f64, f64, f64, f64) {
    let s = if d.scale > 0.0 { d.scale } else { 1.0 };
    (f64::from(d.x) / s, f64::from(d.y) / s, f64::from(d.width) / s, f64::from(d.height) / s)
}

/// Puts a window on its display: borderless fullscreen, or a normal window near its corner.
/// A fullscreen window is checked again once the system has settled and put back when it
/// does not cover its display.
pub(crate) fn place(window: &WebviewWindow, display: Option<&Display>, spec: &WindowSpec) -> tauri::Result<()> {
    if !spec.fullscreen {
        // Elsewhere positions are in the desktop's own pixels, so this is exact.
        #[cfg(not(target_os = "macos"))]
        if let Some(d) = display {
            let inset = (60.0 * d.scale) as i32;
            window.set_position(PhysicalPosition::new(d.x + inset, d.y + inset))?;
        }
        return window.show();
    }
    cover(window, display)?;
    if let Some(d) = display.cloned() {
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
            for wait in [400, 1200] {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                match covers(&window, &d) {
                    Ok(true) => return,
                    Ok(false) => {
                        tracing::warn!(
                            "the {} window is at {:?} {:?}, not on display {} at {},{} {}x{}; putting it back",
                            window.label(),
                            window.outer_position().ok(),
                            window.outer_size().ok(),
                            d.index,
                            d.x,
                            d.y,
                            d.width,
                            d.height
                        );
                        report(recover(&window, &d).map_err(anyhow::Error::from));
                    }
                    // The window was closed in the meantime.
                    Err(_) => return,
                }
            }
        });
    }
    Ok(())
}

/// Full screen on the display the window is on.
pub(crate) fn cover(window: &WebviewWindow, display: Option<&Display>) -> tauri::Result<()> {
    // macOS: the system's fullscreen moves the window to a space of its own with an
    // animation, and two of those fight each other. Simple fullscreen just covers the
    // display the window is on, including the menu bar and the Dock.
    #[cfg(target_os = "macos")]
    {
        let _ = display;
        window.show()?;
        window.set_simple_fullscreen(true)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.set_decorations(false)?;
        match display {
            Some(d) => {
                window.set_position(PhysicalPosition::new(d.x, d.y))?;
                window.set_fullscreen_on_monitor(PhysicalPosition::new(
                    f64::from(d.x) + f64::from(d.width) / 2.0,
                    f64::from(d.y) + f64::from(d.height) / 2.0,
                ))?
            }
            None => window.set_fullscreen(true)?,
        }
        window.show()?;
    }
    Ok(())
}

/// The window covers its display, within a few pixels.
pub(crate) fn covers(window: &WebviewWindow, d: &Display) -> tauri::Result<bool> {
    let at = window.outer_position()?;
    let size = window.outer_size()?;
    let near = |a: i64, b: i64| (a - b).abs() <= 4;
    Ok(near(at.x.into(), d.x.into())
        && near(at.y.into(), d.y.into())
        && near(size.width.into(), d.width.into())
        && near(size.height.into(), d.height.into()))
}

/// Takes a window out of full screen, onto its display, and into full screen again.
pub(crate) fn recover(window: &WebviewWindow, d: &Display) -> tauri::Result<()> {
    let (x, y, w, h) = logical_frame(d);
    #[cfg(target_os = "macos")]
    {
        window.set_simple_fullscreen(false)?;
        window.set_decorations(false)?;
        window.set_position(tauri::LogicalPosition::new(x, y))?;
        window.set_size(tauri::LogicalSize::new(w, h))?;
        // The move above is asynchronous; full screen goes after it, on the main thread.
        let again = window.clone();
        window.run_on_main_thread(move || {
            let _ = again.set_simple_fullscreen(true);
        })?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, w, h);
        window.set_fullscreen(false)?;
        cover(window, Some(d))?;
    }
    Ok(())
}

/// Puts the table's window into full screen on its display, or back into a window.
pub(crate) fn toggle_table_fullscreen(app: &AppHandle) -> anyhow::Result<()> {
    let Some(window) = table_window(app) else { return Ok(()) };
    let shell = app.state::<Shell>();
    let full = !shell.table_fullscreen.load(Ordering::Relaxed);
    let index = shell.surfaces.lock().iter().find(|(label, _)| label == window.label()).map(|(_, index)| *index);
    let display = index.and_then(|i| list_displays(app).ok()?.into_iter().find(|d| d.index == i));
    if full {
        match &display {
            Some(d) => recover(&window, d)?,
            None => cover(&window, None)?,
        }
    } else {
        #[cfg(target_os = "macos")]
        window.set_simple_fullscreen(false)?;
        #[cfg(not(target_os = "macos"))]
        window.set_fullscreen(false)?;
        window.set_decorations(true)?;
        window.set_size(tauri::LogicalSize::new(1400.0, 840.0))?;
        if let Some(d) = &display {
            let (x, y, _, _) = logical_frame(d);
            window.set_position(tauri::LogicalPosition::new(x + 60.0, y + 60.0))?;
        }
    }
    shell.table_fullscreen.store(full, Ordering::Relaxed);
    Ok(())
}

/// A window opened from the editor's "Open in a window" in or out of full screen (#420).
pub(crate) fn toggle_view_fullscreen(app: &AppHandle, label: &str) -> anyhow::Result<()> {
    // macOS's simple full screen cannot be asked about, so the shell remembers which views it filled.
    static FULL: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());
    let Some(window) = app.get_webview_window(label) else { return Ok(()) };
    let mut full = FULL.lock();
    let on = !full.iter().any(|l| l == label);
    #[cfg(target_os = "macos")]
    window.set_simple_fullscreen(on)?;
    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(on)?;
    if on {
        full.push(label.to_string());
    } else {
        full.retain(|l| l != label);
    }
    Ok(())
}

pub(crate) fn shell_action(app: &AppHandle, action: &str) {
    let app = app.clone();
    // Operator mode (#394): Esc does nothing, and the keys and the button that lead to the editor,
    // Settings or Quit bring the operator window instead. The show goes on.
    if app.state::<Shell>().operator_mode.is_on() && matches!(action, "escape" | "setup" | "edit" | "quit") {
        if action != "escape" {
            drop(tauri::async_runtime::spawn(async move { report(operator_mode::open_window(&app)) }));
        }
        return;
    }
    match action {
        // Off the event loop: creating a window from inside a webview callback can deadlock on Windows.
        "setup" => drop(tauri::async_runtime::spawn(async move { report(open_launcher(&app)) })),
        // The editor's licence reminder (#729).
        "licence" => drop(tauri::async_runtime::spawn(async move { report(open_launcher_at(&app, Some("licence"))) })),
        // Back from the table to the editor.
        "edit" => drop(tauri::async_runtime::spawn(async move {
            // The editor first: with the surfaces gone and no other window, the app would quit.
            report(open_editor(&app, "edit").or_else(|_| open_home_window(&app)));
            report(close_surfaces(&app));
        })),
        // A page asked for a view of its own (the editor's "Open in a window").
        view if view.starts_with("window/") => {
            let role = view["window/".len()..].to_string();
            drop(tauri::async_runtime::spawn(async move { report(show_view(&app, &role)) }));
        }
        // Esc on a surface: the way back for the author, as in a slideshow. A table that
        // presents by itself after the computer started (#79) ignores it; everywhere else Esc
        // leaves, to the editor or to Home when no editor is open (#295).
        "escape" if app.get_webview_window(EDITOR).is_none() && std::env::args().any(|a| a == "--at-login") => {}
        "escape" => shell_action(&app, "edit"),
        "quit" => app.exit(0),
        // The controller's Full screen button (#198): the table's window in or out of full screen.
        "fullscreen" => {
            let app = app.clone();
            drop(tauri::async_runtime::spawn(async move { report(toggle_table_fullscreen(&app)) }));
        }
        other => tracing::warn!("unknown shell action '{other}'"),
    }
}

// The shell's commands. The launcher may call all of them and the editor window a few
// (`capabilities/`); Tauri refuses commands from every other page, such as the surfaces.
