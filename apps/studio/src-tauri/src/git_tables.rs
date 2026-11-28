//! Tables kept in a git repository (#570): Home gets one from a repository's address, and
//! picks up new versions from it. Publishing a table is then a push from wherever it is made.
//!
//! The defaults are the careful ones, until the questions in #570 are settled: this computer
//! only follows the repository (a pull is fast-forward only and refused when the table was
//! changed here), never while the table is on the screens, and only when someone presses
//! Update. Signing in is git's own (Git Credential Manager, an SSH key or a token in the
//! address), so no password passes through MR Studio. What belongs to this computer
//! (calibration, colour, .mrstudio) is not in the repository and is left as it is.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

/// What Home shows for a table that follows a repository.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct GitState {
    /// Where it comes from, without any sign-in in it: `git.chalmers.se/group/table`.
    pub remote: String,
    /// New versions in the repository not yet here. None when the repository could not be reached.
    pub behind: Option<u32>,
    /// Files changed on this computer that the repository does not have.
    pub changed_here: Vec<String>,
    /// Why the repository could not be reached, in words.
    pub problem: Option<String>,
}

fn git(dir: Option<&Path>, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new("git");
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    // Never stop to ask for a password in a terminal nobody sees.
    command.args(args).env("GIT_TERMINAL_PROMPT", "0").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // no console window
    }
    let child = command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "Git is not installed on this computer. Install it from git-scm.com, then try again.".to_string(),
        _ => format!("git could not start: {e}"),
    })?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(child.wait_with_output());
    });
    let output = receive
        .recv_timeout(timeout)
        .map_err(|_| "The repository did not answer in time. Check the address and the network.".to_string())?
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim_end().to_string())
    } else {
        let said = String::from_utf8_lossy(&output.stderr);
        Err(plain(said.trim()))
    }
}

/// Git's own words, made into advice where we know what they mean.
fn plain(said: &str) -> String {
    let lower = said.to_ascii_lowercase();
    if lower.contains("authentication") || lower.contains("could not read username") || lower.contains("permission denied") {
        "The repository wants a sign-in. Sign in once with git on this computer (or use an address with a read-only token), then try again."
            .into()
    } else if lower.contains("not found") || lower.contains("does not exist") {
        "There is no repository at that address, or this computer may not read it.".into()
    } else if lower.contains("could not resolve host") || lower.contains("unable to access") {
        "The repository could not be reached. Check the network.".into()
    } else {
        said.lines().last().unwrap_or("git failed").to_string()
    }
}

/// An address without the sign-in in it, for showing.
pub fn shown(remote: &str) -> String {
    let rest = remote.split_once("://").map_or(remote, |(_, rest)| rest);
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    rest.trim_end_matches(".git").trim_end_matches('/').to_string()
}

/// The folder name a repository address suggests: `.../chalmers-table.git` → `chalmers-table`.
pub fn folder_for(remote: &str) -> Option<String> {
    let last = shown(remote).rsplit(['/', ':']).next()?.to_string();
    let clean: String = last.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.')).collect();
    (!clean.trim().is_empty() && clean != "." && clean != "..").then(|| clean.trim().to_string())
}

/// Whether the folder is a table that follows a repository.
pub fn follows(table: &Path) -> bool {
    table.join(".git").exists()
}

/// Gets the table at `remote` into a new folder in `into`. Large files kept with Git LFS come
/// too when Git LFS is installed; a table that needs it says so when it is not.
pub fn clone(remote: &str, into: &Path) -> Result<PathBuf, String> {
    let name = folder_for(remote).ok_or("That does not look like a repository's address.")?;
    let mut target = into.join(&name);
    let mut n = 2;
    while target.exists() {
        target = into.join(format!("{name} {n}"));
        n += 1;
    }
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let target_text = target.to_string_lossy().to_string();
    git(None, &["clone", "--", remote, &target_text], Duration::from_secs(600))?;
    if !target.join("site.json").is_file() {
        let _ = std::fs::remove_dir_all(&target);
        return Err("That repository is not a table: it has no site.json at the top.".into());
    }
    lfs_check(&target)?;
    Ok(target)
}

/// A table whose large files are in Git LFS needs Git LFS here, or its videos and rasters are
/// only pointers.
fn lfs_check(table: &Path) -> Result<(), String> {
    let uses_lfs = std::fs::read_to_string(table.join(".gitattributes")).is_ok_and(|a| a.contains("filter=lfs"));
    if uses_lfs && git(Some(table), &["lfs", "version"], Duration::from_secs(20)).is_err() {
        return Err("This table keeps its large files with Git LFS, which is not installed here. Install Git LFS (git-lfs.com), then press Update on the table.".into());
    }
    if uses_lfs {
        git(Some(table), &["lfs", "pull"], Duration::from_secs(600))?;
    }
    Ok(())
}

/// Asks the repository what is new. Reaches the network; a few seconds at most.
pub fn state(table: &Path) -> GitState {
    let remote = git(Some(table), &["remote", "get-url", "origin"], Duration::from_secs(10)).unwrap_or_default();
    let changed_here = changed_here(table);
    let fetched = git(Some(table), &["fetch", "--quiet", "origin"], Duration::from_secs(30));
    let behind = fetched
        .as_ref()
        .ok()
        .and_then(|_| git(Some(table), &["rev-list", "--count", "HEAD..@{u}"], Duration::from_secs(10)).ok())
        .and_then(|n| n.parse().ok());
    GitState { remote: shown(&remote), behind, changed_here, problem: fetched.err() }
}

/// Files changed here, leaving out what is this computer's own and never in a repository.
fn changed_here(table: &Path) -> Vec<String> {
    git(Some(table), &["status", "--porcelain", "--untracked-files=no"], Duration::from_secs(10))
        .unwrap_or_default()
        .lines()
        .map(|l| l.get(3..).unwrap_or(l).to_string())
        .filter(|f| !matches!(f.as_str(), "calibration.json") && !f.starts_with(".mrstudio"))
        .collect()
}

/// Takes the repository's newest version. Refused when the table was changed here: this
/// computer follows the repository and does not merge.
pub fn update(table: &Path) -> Result<u32, String> {
    let before = state(table);
    if let Some(problem) = before.problem {
        return Err(problem);
    }
    if !before.changed_here.is_empty() {
        return Err(format!(
            "This table was changed on this computer ({}), so it is not updated from the repository. Make the change in the repository instead, or use Duplicate to keep this version.",
            before.changed_here.join(", ")
        ));
    }
    let behind = before.behind.unwrap_or(0);
    if behind > 0 {
        git(Some(table), &["merge", "--ff-only", "@{u}"], Duration::from_secs(120)).map_err(|_| {
            "The repository's history changed in a way this computer cannot follow. Get the table again from the repository.".to_string()
        })?;
        lfs_check(table)?;
    }
    Ok(behind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn a_table_comes_from_a_repository_and_follows_it() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("mrs-git-tables-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // The repository, as a team would keep it.
        let work = dir.join("work");
        mrs_site::create::create(&work, "Chalmers", 11.97, 57.69, 400.0, 300.0, 0.0).unwrap();
        run(&work, &["init", "-q"]);
        run(&work, &["add", "."]);
        run(&work, &["commit", "-qm", "first"]);
        let remote = dir.join("chalmers-table.git");
        run(&dir, &["clone", "-q", "--bare", "work", "chalmers-table.git"]);
        run(&work, &["remote", "add", "origin", remote.to_str().unwrap()]);

        let here = clone(remote.to_str().unwrap(), &dir.join("sites")).unwrap();
        assert_eq!(here.file_name().unwrap(), "chalmers-table");
        assert!(follows(&here));
        assert_eq!(state(&here).behind, Some(0));

        // A new version is published.
        std::fs::write(work.join("notes.md"), "new").unwrap();
        run(&work, &["add", "."]);
        run(&work, &["commit", "-qm", "second"]);
        run(&work, &["push", "-q", "origin", "HEAD:main"]);
        assert_eq!(state(&here).behind, Some(1));
        // Calibration is this computer's: it does not stop an update.
        std::fs::write(here.join("calibration.json"), "{}").unwrap();
        assert_eq!(update(&here).unwrap(), 1);
        assert!(here.join("notes.md").is_file());

        // A table changed here is not updated over.
        std::fs::write(work.join("notes.md"), "newer").unwrap();
        run(&work, &["commit", "-qam", "third"]);
        run(&work, &["push", "-q", "origin", "HEAD:main"]);
        std::fs::write(here.join("site.json"), std::fs::read_to_string(here.join("site.json")).unwrap() + " ").unwrap();
        let refused = update(&here).unwrap_err();
        assert!(refused.contains("site.json"), "{refused}");

        assert!(clone(dir.join("nothing.git").to_str().unwrap(), &dir.join("sites")).is_err());
        assert_eq!(shown("https://oauth2:secret@git.chalmers.se/group/table.git"), "git.chalmers.se/group/table");
        assert_eq!(folder_for("git@github.com:me/lindholmen.git").as_deref(), Some("lindholmen"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
