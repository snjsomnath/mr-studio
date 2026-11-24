//! "Install command line tool" (#370): puts the `mrstudio` command that ships inside the app
//! (#320) on this computer's PATH, so a Terminal, a script or an AI assistant can type
//! `mrstudio validate`, `mrstudio data add` or `mrstudio layer build`.
//!
//! - macOS: a link `/usr/local/bin/mrstudio` to `MR Studio.app/Contents/MacOS/mrstudio`. When
//!   that folder needs an administrator, macOS asks for the password once. The link follows the
//!   app through updates, because an update replaces the app in the same place.
//! - Windows: the install folder is added to the user's own PATH (no administrator needed).
//!   Terminals opened afterwards find `mrstudio.exe`.
//! - Linux: a link in `~/.local/bin`.
//!
//! Remove takes it away again, and only ever what points at this app.

use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

use serde::Serialize;

#[cfg(not(windows))]
const EXE: &str = "mrstudio";
#[cfg(windows)]
const EXE: &str = "mrstudio.exe";

/// What the Command line page shows.
#[derive(Serialize, Debug)]
pub struct CliState {
    /// The command that came with this app, if it did (a `cargo run` may not have one).
    pub bundled: Option<PathBuf>,
    /// Where the install puts it: the link on macOS and Linux, the folder on Windows.
    pub target: PathBuf,
    /// The install is in place and points at this app's command.
    pub installed: bool,
    /// Something else is at `target`, such as a link to another copy of the app.
    pub other: Option<String>,
    /// Whether installing will ask for an administrator's password (macOS).
    pub needs_admin: bool,
    /// The first `mrstudio` a new Terminal would find right now, if any.
    pub found: Option<PathBuf>,
    pub os: &'static str,
}

/// The command beside the app's own program.
fn bundled() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let cli = exe.parent()?.join(EXE);
    cli.is_file().then_some(cli)
}

#[cfg_attr(windows, allow(dead_code))]
fn same(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The first `mrstudio` on this process's PATH. The app's own PATH can be older than a new
/// Terminal's, so the page reads `installed` first and this only as a hint.
fn on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(EXE)).find(|c| c.is_file())
}

#[cfg(target_os = "macos")]
fn link() -> PathBuf {
    PathBuf::from("/usr/local/bin/mrstudio")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn link() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".local/bin/mrstudio")
}

pub fn state() -> CliState {
    let bundled = bundled();
    let found = on_path();
    #[cfg(unix)]
    {
        let target = link();
        let mut installed = false;
        let mut other = None;
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            let points_at = std::fs::read_link(&target).ok();
            installed = match (&points_at, &bundled) {
                (Some(to), Some(cli)) => same(to, cli),
                _ => false,
            };
            if !installed {
                other = Some(match points_at {
                    Some(to) => format!("{} points at {}", target.display(), to.display()),
                    None if meta.is_file() => format!("{} is a separate copy of mrstudio", target.display()),
                    None => format!("{} is already taken", target.display()),
                });
            }
        }
        let folder = target.parent().map(Path::to_path_buf).unwrap_or_default();
        let needs_admin = cfg!(target_os = "macos") && !writable(&folder);
        CliState { bundled, target, installed, other, needs_admin, found, os: std::env::consts::OS }
    }
    #[cfg(windows)]
    {
        let target = bundled.as_ref().and_then(|c| c.parent().map(Path::to_path_buf)).unwrap_or_default();
        let installed = bundled.is_some() && windows::user_path().map(|p| windows::contains(&p, &target)).unwrap_or(false);
        CliState { bundled, target, installed, other: None, needs_admin: false, found, os: std::env::consts::OS }
    }
}

/// Whether this user can make a file in `folder` (a missing folder counts as not).
#[cfg(unix)]
fn writable(folder: &Path) -> bool {
    let probe = folder.join(format!(".mrstudio-probe-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Puts the command on the PATH. `Ok(false)` when the person cancelled the password prompt.
pub fn install() -> anyhow::Result<bool> {
    let Some(cli) = bundled() else {
        anyhow::bail!("This copy of MR Studio has no mrstudio command beside it. Install the app from its installer (or build it with scripts/stage-cli.mjs).");
    };
    #[cfg(unix)]
    {
        let target = link();
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            if !meta.file_type().is_symlink() {
                anyhow::bail!("{} is a separate copy of mrstudio, not a link. Delete it first, then install again.", target.display());
            }
        }
        let folder = target.parent().map(Path::to_path_buf).unwrap_or_default();
        let direct = std::fs::create_dir_all(&folder).and_then(|_| {
            let _ = std::fs::remove_file(&target);
            std::os::unix::fs::symlink(&cli, &target)
        });
        match direct {
            Ok(()) => Ok(true),
            #[cfg(target_os = "macos")]
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                let script = format!("mkdir -p {} && ln -sfn {} {}", sh(&folder), sh(&cli), sh(&target));
                as_admin(&script)
            }
            Err(e) => Err(anyhow::anyhow!("could not link {}: {e}", target.display())),
        }
    }
    #[cfg(windows)]
    {
        let folder = cli.parent().map(Path::to_path_buf).unwrap_or_default();
        windows::add(&folder)?;
        Ok(true)
    }
}

/// Takes the command off the PATH again, if it is this app's.
pub fn remove() -> anyhow::Result<bool> {
    #[cfg(unix)]
    {
        let target = link();
        let ours = bundled().is_some_and(|cli| std::fs::read_link(&target).is_ok_and(|to| same(&to, &cli)));
        // A link whose app has gone (moved or deleted) is ours to tidy too.
        let dangling = std::fs::read_link(&target).is_ok() && !target.exists();
        if !ours && !dangling {
            return Ok(true);
        }
        match std::fs::remove_file(&target) {
            Ok(()) => Ok(true),
            #[cfg(target_os = "macos")]
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => as_admin(&format!("rm -f {}", sh(&target))),
            Err(e) => Err(anyhow::anyhow!("could not remove {}: {e}", target.display())),
        }
    }
    #[cfg(windows)]
    {
        if let Some(folder) = bundled().and_then(|c| c.parent().map(Path::to_path_buf)) {
            windows::remove(&folder)?;
        }
        Ok(true)
    }
}

/// A path as one single-quoted shell word.
#[cfg(unix)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sh(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

/// Runs a shell line as an administrator, after macOS's own password prompt.
#[cfg(target_os = "macos")]
fn as_admin(script: &str) -> anyhow::Result<bool> {
    let quoted = script.replace('\\', "\\\\").replace('"', "\\\"");
    let apple = format!("do shell script \"{quoted}\" with prompt \"MR Studio wants to add the mrstudio command to /usr/local/bin.\" with administrator privileges");
    let out = Command::new("/usr/bin/osascript").arg("-e").arg(apple).output()?;
    if out.status.success() {
        return Ok(true);
    }
    let error = String::from_utf8_lossy(&out.stderr);
    // -128 is "User canceled".
    if error.contains("-128") {
        return Ok(false);
    }
    anyhow::bail!("{}", error.trim())
}

#[cfg(windows)]
mod windows {
    //! The user's PATH lives in the registry (HKCU\Environment). PowerShell reads and writes it
    //! without expanding `%USERPROFILE%`-style entries, keeps its type, and tells running
    //! programs (Explorer, new terminals) that it changed.
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    const NO_WINDOW: u32 = 0x0800_0000;

    const READ: &str = "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment');\
        if($k){[Console]::Out.Write($k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))}";

    // MRS_DIR is the folder; MRS_ADD is 1 to add it, 0 to take it out. Setting a variable that
    // does not exist to nothing is the documented way to broadcast WM_SETTINGCHANGE from .NET.
    const WRITE: &str = "$d=$env:MRS_DIR.TrimEnd('\\');\
        $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');\
        $p=$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);\
        $parts=@($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $d) });\
        if($env:MRS_ADD -eq '1'){ $parts += $d };\
        $k.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString);\
        [Environment]::SetEnvironmentVariable('MRSTUDIO_PATH_CHANGED', $null, 'User')";

    fn powershell(script: &str, dir: Option<(&Path, bool)>) -> anyhow::Result<String> {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).creation_flags(NO_WINDOW);
        if let Some((dir, add)) = dir {
            cmd.env("MRS_DIR", dir).env("MRS_ADD", if add { "1" } else { "0" });
        }
        let out = cmd.output()?;
        if !out.status.success() {
            anyhow::bail!("PowerShell could not change the PATH: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn user_path() -> anyhow::Result<String> {
        powershell(READ, None)
    }

    pub fn contains(path: &str, folder: &Path) -> bool {
        let want = folder.display().to_string().trim_end_matches('\\').to_lowercase();
        path.split(';').any(|p| p.trim_end_matches('\\').to_lowercase() == want)
    }

    pub fn add(folder: &Path) -> anyhow::Result<()> {
        powershell(WRITE, Some((folder, true))).map(drop)
    }

    pub fn remove(folder: &Path) -> anyhow::Result<()> {
        powershell(WRITE, Some((folder, false))).map(drop)
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn finds_the_folder_whatever_its_case_or_slash() {
            let p = r"C:\Windows;C:\Users\a\AppData\Local\MR Studio\;%USERPROFILE%\bin";
            assert!(super::contains(p, std::path::Path::new(r"c:\users\a\appdata\local\mr studio")));
            assert!(!super::contains(p, std::path::Path::new(r"C:\Users\a\AppData\Local")));
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(sh(Path::new("/Applications/MR Studio.app/x")), "'/Applications/MR Studio.app/x'");
        assert_eq!(sh(Path::new("/a/it's")), r"'/a/it'\''s'");
    }
}
