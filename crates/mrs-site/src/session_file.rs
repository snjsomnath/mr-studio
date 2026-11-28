//! A recorded session as one file (#529): `<name>.mrsession`, a zip of the recording's folder
//! and a frozen copy of the table it was recorded on, so it plays on a computer that never had
//! the table. It is never a `.mrstable` and never becomes a table: opening one adds it to the
//! recordings only, with its table copy inside the recording's own folder.
//!
//! Inside: `mrsession.json` (what it is, made by which app), the recording's files at the top
//! (`recording.json`, `start.json`, `log.jsonl`, `checkpoints.jsonl`, `notes.json` and whatever
//! the phones sent), and the table under `table/`. The same rules as a `.mrstable` apply: no
//! hidden files, history or secrets go in, and nothing unpacks outside its folder.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::package::{refused, stored, table_files, unpack, PackageError, MAX_UNPACKED};

/// The file extension, without the dot.
pub const EXTENSION: &str = "mrsession";
/// The description file at the top of the zip.
pub const ABOUT: &str = "mrsession.json";
/// The newest session file format this build writes and reads.
pub const FORMAT: u32 = 1;
/// The table copy's folder, in the file and in an opened recording's folder.
pub const TABLE: &str = "table";
/// Without media, pictures larger than this stay behind (videos always do).
const LARGE_PICTURE: u64 = 4 * 1024 * 1024;

/// What `mrsession.json` says.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionAbout {
    pub format: u32,
    /// The recording's id, which is also its folder's name.
    pub id: String,
    pub name: String,
    pub table_id: String,
    pub table_name: String,
    /// The MR Studio version that exported it.
    pub app: String,
    /// Seconds since 1970.
    pub exported: u64,
    /// False for Export without media: `left_out` names what playback will miss.
    pub media: bool,
    #[serde(default)]
    pub left_out: Vec<String>,
}

/// What an export wrote.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionExported {
    pub path: PathBuf,
    pub files: usize,
    pub bytes: u64,
    /// Media left out by Export without media, relative to the table.
    pub left_out: Vec<String>,
}

/// What opening one did.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SessionOpened {
    /// The recording's new folder in the recordings folder.
    pub dir: PathBuf,
    pub about: SessionAbout,
}

fn is_video(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["mp4", "m4v", "mov", "webm", "avi", "mkv"].iter().any(|ext| lower.rsplit_once('.').is_some_and(|(_, e)| e == *ext))
}

fn is_picture(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["png", "jpg", "jpeg", "webp", "tif", "tiff", "avif"].iter().any(|ext| lower.rsplit_once('.').is_some_and(|(_, e)| e == *ext))
}

/// Packs the recording in `recording` and the table in `table` into `out`. `about` is filled in
/// by the caller except for `format`, `exported`, `media` and `left_out`.
pub fn export(recording: &Path, table: &Path, out: &Path, mut about: SessionAbout, media: bool) -> Result<SessionExported, PackageError> {
    if !recording.join("recording.json").is_file() {
        return Err(refused("that folder is not a recording (it has no recording.json)"));
    }
    if !table.join("site.json").is_file() {
        return Err(refused("the recording's table could not be found"));
    }
    let mut files = Vec::new();
    let mut secrets = Vec::new();
    table_files(recording, "", &mut files, &mut secrets)?;
    // An opened recording keeps its table copy inside; it goes in once, under table/, below.
    // So does the header an opened recording keeps from its file: a new one is written.
    files.retain(|(name, _)| !name.starts_with(&format!("{TABLE}/")) && name != ABOUT);
    let mut table_part = Vec::new();
    table_files(table, &format!("{TABLE}/"), &mut table_part, &mut secrets)?;
    let mut left_out = Vec::new();
    if !media {
        table_part.retain(|(name, path)| {
            let large = is_picture(name) && std::fs::metadata(path).is_ok_and(|m| m.len() > LARGE_PICTURE);
            let keep = !(is_video(name) || large);
            if !keep {
                left_out.push(name[TABLE.len() + 1..].to_string());
            }
            keep
        });
    }
    files.extend(table_part);
    about.format = FORMAT;
    about.media = media;
    about.left_out = left_out.clone();
    about.exported = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

    let partial = out.with_extension(format!("{EXTENSION}.partial"));
    let written = (|| -> Result<(), PackageError> {
        let mut zip = ZipWriter::new(File::create(&partial)?);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(ABOUT, deflated)?;
        zip.write_all((serde_json::to_string_pretty(&about).map_err(|e| refused(e.to_string()))? + "\n").as_bytes())?;
        for (name, path) in &files {
            let size = std::fs::metadata(path)?.len();
            let method = if stored(name) { CompressionMethod::Stored } else { CompressionMethod::Deflated };
            let options = SimpleFileOptions::default().compression_method(method).large_file(size >= u64::from(u32::MAX));
            zip.start_file(name.as_str(), options)?;
            io::copy(&mut File::open(path)?, &mut zip)?;
        }
        zip.finish()?.sync_all()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, out)?;
    Ok(SessionExported { path: out.to_path_buf(), files: files.len(), bytes: std::fs::metadata(out)?.len(), left_out })
}

/// Reads what a session file says about itself without unpacking it.
pub fn about(file: &Path) -> Result<SessionAbout, PackageError> {
    let mut zip = ZipArchive::new(File::open(file)?)?;
    let entry = zip.by_name(ABOUT).map_err(|_| refused("it is not a recorded session file (it has no mrsession.json)"))?;
    let about: SessionAbout =
        serde_json::from_reader(io::Read::take(entry, 1 << 20)).map_err(|e| refused(format!("its mrsession.json cannot be read ({e})")))?;
    Ok(about)
}

/// Opens a session file into `recordings`, as a recording of its own. A file made by a newer
/// MR Studio is refused, naming the version; one already there is refused rather than replaced.
pub fn open(file: &Path, recordings: &Path) -> Result<SessionOpened, PackageError> {
    let about = about(file)?;
    if about.format > FORMAT {
        return Err(refused(format!("it was made by a newer MR Studio ({}). Install that version or later to play it.", about.app)));
    }
    let id = about.id.as_str();
    if id.is_empty() || id.starts_with('.') || id.contains(['/', '\\', ':']) || id == ".." {
        return Err(refused("its recording id is not a folder name"));
    }
    let dir = recordings.join(id);
    if dir.exists() {
        return Err(refused(format!("“{}” is already in Recorded sessions", about.name)));
    }
    std::fs::create_dir_all(recordings)?;
    let partial = recordings.join(format!(".{id}.opening"));
    let _ = std::fs::remove_dir_all(&partial);
    let unpacked = (|| -> Result<(), PackageError> {
        let mut zip = ZipArchive::new(File::open(file)?)?;
        let declared: u64 = (0..zip.len()).filter_map(|i| zip.by_index_raw(i).ok().map(|e| e.size())).sum();
        if declared > MAX_UNPACKED {
            return Err(refused("it unpacks to more than 16 GB"));
        }
        unpack(&mut zip, &partial)?;
        if !partial.join("recording.json").is_file() || !partial.join(TABLE).join("site.json").is_file() {
            return Err(refused("it is missing the recording or its table"));
        }
        Ok(())
    })();
    if let Err(e) = unpacked {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(e);
    }
    std::fs::rename(&partial, &dir)?;
    Ok(SessionOpened { dir, about })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recording_goes_out_with_its_table_and_opens_as_a_recording_only() {
        let dir = std::env::temp_dir().join(format!("mrs-session-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let table = dir.join("Lindholmen");
        crate::create::create(&table, "Lindholmen", 11.9384, 57.7066, 400.0, 300.0, 0.0).unwrap();
        std::fs::create_dir_all(table.join("media")).unwrap();
        std::fs::write(table.join("media/walk.mp4"), [0u8; 64]).unwrap();
        std::fs::write(table.join("media/logo.png"), [137, 80, 78, 71]).unwrap();
        std::fs::write(table.join(".env"), "KEY=secret").unwrap();
        let recording = dir.join("here/2026-11-28-benches");
        std::fs::create_dir_all(&recording).unwrap();
        for (name, body) in [("recording.json", "{}"), ("start.json", "{}"), ("log.jsonl", "{\"t\":0}\n"), ("notes.json", "[]")] {
            std::fs::write(recording.join(name), body).unwrap();
        }
        let about = SessionAbout {
            id: "2026-11-28-benches".into(),
            name: "Benches".into(),
            table_id: "lindholmen".into(),
            app: "0.59.0".into(),
            ..Default::default()
        };

        let out = dir.join("Benches.mrsession");
        let full = export(&recording, &table, &out, about.clone(), true).unwrap();
        assert!(full.left_out.is_empty());
        let lean = export(&recording, &table, &dir.join("lean.mrsession"), about.clone(), false).unwrap();
        assert_eq!(lean.left_out, vec!["media/walk.mp4".to_string()], "without media, videos stay behind");
        assert!(!self::about(&dir.join("lean.mrsession")).unwrap().media);

        let there = dir.join("there");
        let opened = open(&out, &there).unwrap();
        assert_eq!(opened.dir, there.join("2026-11-28-benches"));
        assert!(opened.dir.join("log.jsonl").is_file() && opened.dir.join("notes.json").is_file());
        assert!(opened.dir.join("table/site.json").is_file() && opened.dir.join("table/media/walk.mp4").is_file());
        assert!(!opened.dir.join("table/.env").exists(), "no secrets travel");
        assert!(open(&out, &there).is_err(), "opened once");

        // Exported again from the computer that opened it: the table copy goes in once.
        let again = export(&opened.dir, &opened.dir.join(TABLE), &dir.join("again.mrsession"), about.clone(), true).unwrap();
        assert_eq!(again.files, full.files);

        // A newer format is refused with the version to install.
        let newer = dir.join("newer.mrsession");
        let mut zip = ZipWriter::new(File::create(&newer).unwrap());
        zip.start_file(ABOUT, SimpleFileOptions::default()).unwrap();
        zip.write_all(
            serde_json::to_string(&SessionAbout { format: 9, app: "3.0.0".into(), id: "x".into(), ..Default::default() })
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();
        assert!(open(&newer, &there).unwrap_err().to_string().contains("3.0.0"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
