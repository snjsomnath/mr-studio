//! The File menu's actions: save as, export, share by email or folder, the starter pack,
//! and quitting (#541).

use super::*;

/// The File menu, from the editor page's own File button and its keys (#130).
/// `checked` says the page has already made sure nothing is still being saved; without
/// it an action that leaves the table, or Save, is handed to the page to check first.
#[tauri::command]
pub(crate) fn file_action(app: AppHandle, action: String, checked: Option<bool>) -> Result<(), String> {
    if !file_menu::ACTIONS.contains(&action.as_str()) {
        return Err(format!("'{action}' is not a File menu action"));
    }
    if checked == Some(true) {
        perform_file_action(&app, &action);
    } else {
        run_file_action(&app, &action);
    }
    Ok(())
}

/// Runs one File menu action. Off the event loop: windows are opened and closed, and a
/// dialog waits for the person.
pub(crate) fn run_file_action(app: &AppHandle, action: &str) {
    if !app.state::<Shell>().file_debounce.allow(action) {
        return;
    }
    // Save, and anything that leaves the table, goes past the editor page first: it waits for
    // a change still on its way to the host and asks if one could not be saved. It then
    // calls `file_action` with `checked`. Close only when the editor is the window in front.
    if let Some(editor) = app.get_webview_window(EDITOR) {
        let ask = match action {
            "save" | "save_as" | "export" | "share" | "home" | "open" | "new" => true,
            "close" => editor.is_focused().unwrap_or(false),
            _ => false,
        };
        if ask {
            file_menu::tell_editor(app, EDITOR, json!({ "action": "ask", "then": action }));
            return;
        }
    }
    perform_file_action(app, action);
}

pub(crate) fn perform_file_action(app: &AppHandle, action: &str) {
    let app = app.clone();
    let action = action.to_string();
    tauri::async_runtime::spawn(async move {
        let done = match action.as_str() {
            "new" => {
                let shell = app.state::<Shell>();
                match new_table(app.clone(), shell).await {
                    // Without the editor's wizard, Home asks the first questions.
                    Ok(false) => open_home_window(&app),
                    Ok(true) => Ok(()),
                    Err(e) => Err(anyhow::anyhow!(e)),
                }
            }
            "open" | "home" => open_home_window(&app),
            "settings" => open_launcher(&app),
            // Every change is written as it is made, and the page has checked that nothing is
            // still on its way: Save has nothing left to write. With the revision history
            // (#72) it will also mark a save point here.
            "save" => Ok(()),
            "save_as" => save_as(&app).await,
            "export" => export_table(&app).await,
            "share" => share_table(&app).await,
            "reveal" => {
                let site = app.state::<Shell>().running.lock().as_ref().map(|r| r.site.join("site.json"));
                match site {
                    Some(site) => app.opener().reveal_item_in_dir(site).map_err(anyhow::Error::from),
                    None => Ok(()),
                }
            }
            "close" => close_focused(&app),
            other => Err(anyhow::anyhow!("unknown File action '{other}'")),
        };
        if let Err(e) = done {
            tracing::error!("File > {action}: {e:#}");
            file_menu::tell_editor(&app, EDITOR, json!({ "action": "problem", "message": format!("{e:#}") }));
        }
    });
}

/// Close: the editor goes back to Home, as closing a document does; another of the app's
/// own windows just closes. The table and TV windows are left alone (Esc and the way back
/// on them are for that).
pub(crate) fn close_focused(app: &AppHandle) -> anyhow::Result<()> {
    let focused = app.webview_windows().into_iter().find(|(_, w)| w.is_focused().unwrap_or(false));
    match focused {
        Some((label, window)) if label == EDITOR => {
            open_home_window(app)?;
            window.close()?;
        }
        Some((label, window)) if !label.starts_with("surface-") => window.close()?,
        _ => {}
    }
    Ok(())
}

/// Save As: the person names the copy in the system's save dialog, the table's folder is
/// copied there with its own id and name, and the editor switches to the copy. The original
/// stays as it was.
pub(crate) async fn save_as(app: &AppHandle) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    let Some(running) = shell.running.lock().clone() else { return Ok(()) };
    let folder = file_menu::default_folder(&running.site, &shell.sites_folders);
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Save table as").set_directory(&folder).set_file_name(format!("{} copy", running.name));
    if let Some(window) = app.get_webview_window(EDITOR) {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = send.send(path);
    });
    let Some(target) = receive.await.ok().flatten() else { return Ok(()) };
    let target = target.into_path().context("the chosen place is not a folder on this computer")?;
    let name = file_menu::name_from(&target).context("Give the table a name.")?;
    // The dialog may have added an extension; the folder is named as the table is.
    let target = target.with_file_name(&name);
    file_menu::copy_table(&running.site, &target, &name)?;
    tracing::info!("saved '{}' as '{name}' in {}", running.name, target.display());
    shell.allow(|allowed| allowed.copied(&sites::canonical(running.site.clone()), &sites::canonical(target.clone())));
    // A copy outside the sites folder is remembered, so Home lists it.
    let mut settings = shell.settings();
    let in_sites_folder = shell.sites_folders.iter().any(|f| target.parent() == Some(f.as_path()));
    let target = sites::canonical(target);
    if !in_sites_folder && !settings.sites.contains(&target) {
        settings.sites.push(target.clone());
        settings.write(&shell.settings_path())?;
    }
    // The editor reloads on the copy, whose name is in its title.
    open_site(app.clone(), app.state::<Shell>(), target, None).await.map_err(|e| anyhow::anyhow!(e))
}

/// Export table… (#85): one `.mrstable` file of the open table, to take to another computer.
/// The editor says where it went and which sources the other computer has to set up.
pub(crate) async fn export_table(app: &AppHandle) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    let Some(running) = shell.running.lock().clone() else { return Ok(()) };
    let state = shell.host.lock().await.as_ref().map(|h| h.state.clone()).context("the table is not running")?;
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export table")
        .set_file_name(format!("{}.{}", mrs_site::package::folder_name(&running.name), mrs_site::package::EXTENSION))
        .add_filter("MR Studio table", &[mrs_site::package::EXTENSION]);
    if let Ok(documents) = app.path().document_dir() {
        dialog = dialog.set_directory(documents);
    }
    if let Some(window) = app.get_webview_window(EDITOR) {
        dialog = dialog.set_parent(&window);
    }
    dialog.save_file(move |path| {
        let _ = send.send(path);
    });
    let Some(target) = receive.await.ok().flatten() else { return Ok(()) };
    if !licence::may_leave(app, &running.site, "Export").await? {
        return Ok(());
    }
    let mut target = target.into_path().context("the chosen place is not a folder on this computer")?;
    if !target.extension().is_some_and(|e| e.eq_ignore_ascii_case(mrs_site::package::EXTENSION)) {
        target.set_extension(mrs_site::package::EXTENSION);
    }
    let version = app.package_info().version.to_string();
    let out = target.clone();
    let stamp = licence::export_stamp(&shell);
    let exported =
        tokio::task::spawn_blocking(move || state.export_table_stamped(&out, &version, stamp)).await?.map_err(anyhow::Error::msg)?;
    tracing::info!("exported '{}' to {} ({} files, {} bytes)", running.name, target.display(), exported.files, exported.bytes);
    let file = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let detail = if exported.sources.is_empty() {
        "It needs nothing else on the other computer.".to_string()
    } else {
        let names: Vec<String> = exported.sources.iter().map(|s| if s.name.is_empty() { s.id.clone() } else { s.name.clone() }).collect();
        format!("On the other computer, set up {} in Sources and keys. The keys did not go in the file.", names.join(", "))
    };
    crate::notify::job_done(app, EDITOR, &format!("Exported {}", running.name), &format!("{file} is ready to take to another computer."));
    file_menu::tell_editor(
        app,
        EDITOR,
        json!({ "action": "exported", "message": format!("Exported to {file}"), "detail": detail, "path": target }),
    );
    Ok(())
}

/// Share by email (#372): packs the open table as `export_table` does, into
/// `Documents/MR Studio/Shared/<name>.mrstable` (the mail app may read it after this returns,
/// so it stays), and opens a new message with it attached in the computer's mail app. When no
/// mail app takes the file, the file is shown in Finder or Explorer and a plain new message
/// opens, to drag it into. Big files are the mail app's call: Outlook offers a OneDrive link.
pub(crate) async fn share_table(app: &AppHandle) -> anyhow::Result<()> {
    let shell = app.state::<Shell>();
    let Some(running) = shell.running.lock().clone() else { return Ok(()) };
    let state = shell.host.lock().await.as_ref().map(|h| h.state.clone()).context("the table is not running")?;
    if !licence::may_leave(app, &running.site, "Share").await? {
        return Ok(());
    }
    let folder = app.path().document_dir().context("this computer has no Documents folder")?.join("MR Studio").join("Shared");
    std::fs::create_dir_all(&folder).with_context(|| format!("could not make {}", folder.display()))?;
    let target = folder.join(format!("{}.{}", mrs_site::package::folder_name(&running.name), mrs_site::package::EXTENSION));
    file_menu::tell_editor(app, EDITOR, json!({ "action": "sharing", "message": format!("Packing {}…", running.name) }));
    let version = app.package_info().version.to_string();
    let out = target.clone();
    let stamp = licence::export_stamp(&shell);
    let exported =
        tokio::task::spawn_blocking(move || state.export_table_stamped(&out, &version, stamp)).await?.map_err(anyhow::Error::msg)?;
    tracing::info!("shared '{}' as {} ({} bytes)", running.name, target.display(), exported.bytes);
    let size = megabytes(exported.bytes);
    crate::notify::job_done(app, EDITOR, &format!("{} is packed", running.name), &format!("{size}, ready to share."));
    // Ask before any mail window opens (#578): the size, and for a big table a way that is
    // not email, since most mail servers refuse attachments over 20 to 25 MB.
    let message = match ask_how_to_share(app, &running.name, &size, exported.bytes).await? {
        ShareBy::Email => mail_with(app, &target, mail::letter(&running.name), &running.name, &size).await?,
        ShareBy::Folder => {
            app.opener().reveal_item_in_dir(&target)?;
            json!({
                "action": "exported",
                "message": format!("{} is in the Shared folder ({size})", running.name),
                "detail": "Send it by OneDrive, WeTransfer or a USB stick. The other computer opens it with File › Open.",
                "path": target,
            })
        }
        ShareBy::Nothing => json!({ "action": "exported" }),
    };
    file_menu::tell_editor(app, EDITOR, message);
    Ok(())
}

/// Over this, a table is likely too big to email (Outlook takes 20 MB, Gmail 25 MB).
pub(crate) const MAIL_LIMIT: u64 = 20 * 1024 * 1024;

pub(crate) enum ShareBy {
    Email,
    Folder,
    Nothing,
}

pub(crate) const SHARE_EMAIL: &str = "Email it";
pub(crate) const SHARE_CANCEL: &str = "Cancel";
pub(crate) const SHARE_FOLDER: &str = if cfg!(target_os = "macos") {
    "Show in Finder"
} else if cfg!(windows) {
    "Show in Explorer"
} else {
    "Show in folder"
};

/// How the packed table goes out: by email, from its folder, or not at all (#578).
pub(crate) async fn ask_how_to_share(app: &AppHandle, name: &str, size: &str, bytes: u64) -> anyhow::Result<ShareBy> {
    use tauri_plugin_dialog::{MessageDialogButtons as Buttons, MessageDialogResult as Pressed};
    let big = bytes > MAIL_LIMIT;
    let text = if big {
        format!(
            "{name} is packed: {size}. That is likely too big for email: most mail servers refuse attachments over 20 to 25 MB.\n\nShow it in its folder to send it by OneDrive, WeTransfer or a USB stick, or try email anyway."
        )
    } else {
        format!("{name} is packed: {size}. Attach it to a new email, or show it in its folder to send it another way.")
    };
    let asking = app
        .dialog()
        .message(text)
        .title(format!("Share {name}"))
        .kind(if big { tauri_plugin_dialog::MessageDialogKind::Warning } else { tauri_plugin_dialog::MessageDialogKind::Info })
        .buttons(if big {
            Buttons::YesNoCancelCustom(SHARE_FOLDER.into(), SHARE_EMAIL.into(), SHARE_CANCEL.into())
        } else {
            Buttons::YesNoCancelCustom(SHARE_EMAIL.into(), SHARE_FOLDER.into(), SHARE_CANCEL.into())
        });
    let pressed = tokio::task::spawn_blocking(move || asking.blocking_show_with_result()).await?;
    let label = match pressed {
        Pressed::Custom(label) => label,
        Pressed::Yes | Pressed::Ok => (if big { SHARE_FOLDER } else { SHARE_EMAIL }).to_string(),
        Pressed::No => (if big { SHARE_EMAIL } else { SHARE_FOLDER }).to_string(),
        _ => SHARE_CANCEL.to_string(),
    };
    Ok(match label.as_str() {
        SHARE_EMAIL => ShareBy::Email,
        SHARE_FOLDER => ShareBy::Folder,
        _ => ShareBy::Nothing,
    })
}

/// Opens a new message with `target` attached in the computer's mail app, or shows the file
/// and opens a plain new message to drag it into. Answers the editor's notice.
pub(crate) async fn mail_with(
    app: &AppHandle,
    target: &std::path::Path,
    letter: mail::Letter,
    what: &str,
    size: &str,
) -> anyhow::Result<serde_json::Value> {
    let fallback = mail::mailto(&letter);
    let (send, receive) = tokio::sync::oneshot::channel();
    let file = target.to_path_buf();
    // The macOS share service wants the main thread; MAPI waits while its window is open, so
    // the reply comes back over a channel rather than holding up the event loop.
    let compose = move || {
        let _ = send.send(mail::compose(&file, &letter));
    };
    if cfg!(target_os = "macos") {
        app.run_on_main_thread(compose)?;
    } else {
        std::thread::spawn(compose);
    }
    Ok(match receive.await.unwrap_or_else(|_| Err("the mail app did not answer".into())) {
        Ok(()) => json!({
            "action": "exported",
            "message": format!("{what} is attached to a new email ({size})"),
            "detail": "Add who it goes to and send it. If your mail app offers to send a big file as a link, that works too.",
            "path": target,
        }),
        Err(why) => {
            tracing::warn!("email: {why}; showing the file instead");
            app.opener().reveal_item_in_dir(target)?;
            app.opener().open_url(fallback, None::<&str>)?;
            json!({
                "action": "exported",
                "message": format!("Drag {} into the new email ({size})", target.file_name().unwrap_or_default().to_string_lossy()),
                "detail": format!("Your mail app could not take the file by itself ({why}), so it is shown in its folder."),
                "path": target,
            })
        }
    })
}

/// Export starter pack (#450): the editor's dialog chose what goes in; `how` is `save` (a save
/// dialog) or `email` (into `Documents/MR Studio/Shared`, attached to a new email). The pack
/// is made from the table's folder as it is now. An error goes back to the dialog.
#[tauri::command]
pub(crate) async fn starter_pack(app: AppHandle, options: mrs_site::starter::Options, how: String) -> Result<(), String> {
    let running = app.state::<Shell>().running.lock().clone().ok_or("No table is open.")?;
    let file_name = format!("{} starter pack.zip", mrs_site::package::folder_name(&running.name));
    let target = if how == "email" {
        let folder = app.path().document_dir().map_err(|e| e.to_string())?.join("MR Studio").join("Shared");
        std::fs::create_dir_all(&folder).map_err(|e| format!("could not make {}: {e}", folder.display()))?;
        folder.join(&file_name)
    } else {
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut dialog = app.dialog().file().set_title("Export starter pack").set_file_name(&file_name).add_filter("Zip archive", &["zip"]);
        if let Ok(documents) = app.path().document_dir() {
            dialog = dialog.set_directory(documents);
        }
        if let Some(window) = app.get_webview_window(EDITOR) {
            dialog = dialog.set_parent(&window);
        }
        dialog.save_file(move |path| {
            let _ = send.send(path);
        });
        let Some(chosen) = receive.await.ok().flatten() else { return Ok(()) };
        let mut chosen = chosen.into_path().map_err(|_| "the chosen place is not a folder on this computer".to_string())?;
        if !chosen.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
            chosen.set_extension("zip");
        }
        chosen
    };
    let (site, out) = (running.site.clone(), target.clone());
    let written = tokio::task::spawn_blocking(move || {
        let site = mrs_site::Site::load(&site).map_err(|e| e.to_string())?;
        mrs_site::starter::write(&site, &options, &out)
    })
    .await
    .map_err(|e| e.to_string())??;
    tracing::info!("starter pack of '{}' to {} ({} bytes)", running.name, target.display(), written.bytes);
    let size = megabytes(written.bytes);
    let message = if how == "email" {
        mail_with(&app, &target, mail::starter_letter(&running.name), &format!("The {} starter pack", running.name), &size)
            .await
            .map_err(|e| format!("{e:#}"))?
    } else {
        json!({
            "action": "exported",
            "message": format!("Saved {} ({size})", target.file_name().unwrap_or_default().to_string_lossy()),
            "detail": "Its README says how to use it in each program and how to bring the result back.",
            "path": target,
        })
    };
    file_menu::tell_editor(&app, EDITOR, message);
    Ok(())
}

/// "32 MB", "640 KB".
pub(crate) fn megabytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.0} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{} KB", bytes.div_ceil(1024))
    }
}

#[tauri::command]
pub(crate) fn quit(app: AppHandle) {
    app.exit(0);
}

// Colour: the final pass per display. See colour.rs.
