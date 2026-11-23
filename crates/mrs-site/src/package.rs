//! A table as one file (#85): `<name>.mrstable`, a zip of the table's folder.
//!
//! It holds site.json, the data, the pictures, the calibration and the custom layers, so a
//! table made on one computer opens on another with nothing else copied. It never holds a
//! secret: keys live in the computer's keychain and the list of outside services in the app's
//! own settings (#41). The revision history (#72), a git repository and other hidden files stay
//! behind, and so does anything named like a secret. `mrstable.json` at the top of the zip
//! says what the table is and which outside sources the receiving computer has to set up.
//!
//! Opening one unpacks it into a new folder (never over an existing table), brings site.json
//! up to this build's format, and reports what the table needs that it did not bring.

use std::fs::File;
use std::io::{self, Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::{migrate, Site};

/// The file extension, without the dot.
pub const EXTENSION: &str = "mrstable";
/// The description file at the top of the zip.
pub const ABOUT: &str = "mrstable.json";
/// The newest package format this build writes and reads.
pub const FORMAT: u32 = 1;
/// The most a package may unpack to, so a damaged or hostile file cannot fill the disk.
pub const MAX_UNPACKED: u64 = 16 * 1024 * 1024 * 1024;

/// What `mrstable.json` says.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct About {
    pub format: u32,
    pub name: String,
    pub id: String,
    /// When it was exported, in seconds since 1970.
    #[serde(default)]
    pub exported: u64,
    /// The MR Studio version that exported it.
    #[serde(default)]
    pub app: String,
    /// The outside sources (keys and services) its layers use. The receiving computer sets
    /// these up in Sources and keys; the package never carries the keys themselves.
    #[serde(default)]
    pub sources: Vec<SourceNeed>,
}

/// One outside source the table uses, as the exporting computer knew it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SourceNeed {
    /// The source's id, as the layers name it.
    pub id: String,
    /// What kind of service it is (`mapbox`, `wms`, `vasttrafik`...), when known.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// Its name on the exporting computer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// The layers that use it, by name.
    #[serde(default)]
    pub layers: Vec<String>,
}

/// What an export wrote.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Exported {
    pub path: PathBuf,
    pub files: usize,
    /// The size of the package file.
    pub bytes: u64,
    /// Files that were left out because they look like secrets, relative to the table folder.
    pub left_out: Vec<String>,
    pub sources: Vec<SourceNeed>,
}

/// What opening a package did.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Imported {
    /// The new table folder.
    pub dir: PathBuf,
    pub name: String,
    pub files: usize,
    /// "Brought up to date from site format 2 to 3", when site.json was older than this build.
    pub upgraded: Option<String>,
    /// What the package says the table needs from this computer.
    pub sources: Vec<SourceNeed>,
    /// What is wrong with the table as it arrived (a file a layer names that is not there...).
    pub problems: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("the table file is damaged or is not a table file ({0})")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    Refused(String),
}

fn refused(message: impl Into<String>) -> PackageError {
    PackageError::Refused(message.into())
}

/// Whether a file or folder stays out of the package. Hidden entries (`.git`, `.mrstudio`,
/// `.DS_Store`, `.env`...) always do; so do names that usually hold keys.
pub fn left_behind(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with('.')
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || lower == "sources.json"
        || lower.starts_with("credentials")
        || lower.starts_with("secrets")
        || [".pem", ".key", ".p12", ".pfx"].iter().any(|ext| lower.ends_with(ext))
        // An earlier export lying in the folder is not part of the table.
        || lower.ends_with(&format!(".{EXTENSION}"))
}

/// Whether a name is left out for looking like a secret, as opposed to being hidden or a leftover.
fn secret_looking(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    left_behind(name)
        && !matches!(lower.as_str(), ".git" | ".mrstudio" | ".ds_store" | "thumbs.db" | "desktop.ini" | ".gitignore")
        && !lower.ends_with(&format!(".{EXTENSION}"))
}

/// Already-compressed files are stored as they are: packing them again only costs time.
fn stored(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "m4v", "mov", "webm", "mp3", "m4a", "ogg", "zip", "gz", "pmtiles", "mbtiles",
        "glb", "ktx2",
    ]
    .iter()
    .any(|ext| lower.rsplit_once('.').is_some_and(|(_, e)| e == *ext))
}

/// Every file of the table, relative to `dir`, with '/' between parts, in a stable order.
fn table_files(dir: &Path, prefix: &str, files: &mut Vec<(String, PathBuf)>, left_out: &mut Vec<String>) -> io::Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = format!("{prefix}{name}");
        if left_behind(&name) {
            if secret_looking(&name) {
                left_out.push(relative);
            }
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            // A link may point anywhere on this computer; the package holds the table only.
            left_out.push(relative);
        } else if kind.is_dir() {
            table_files(&entry.path(), &format!("{relative}/"), files, left_out)?;
        } else if kind.is_file() {
            files.push((relative, entry.path()));
        }
    }
    Ok(())
}

/// Packs the table in `dir` into `out`. `sources` is what its layers use (the host knows; see
/// `site.sources`). The file is written beside `out` first and moved into place when complete,
/// so a failed export never leaves half a file under the chosen name.
pub fn export(dir: &Path, out: &Path, sources: Vec<SourceNeed>, app: &str) -> Result<Exported, PackageError> {
    let site = Site::load(dir).map_err(|e| refused(e.to_string()))?;
    let dir = &site.dir;
    if out.starts_with(dir) && out.parent().is_some_and(|p| p != dir) {
        return Err(refused("Save the table file outside the table's own folder."));
    }
    let mut files = Vec::new();
    let mut left_out = Vec::new();
    table_files(dir, "", &mut files, &mut left_out)?;
    let about = About {
        format: FORMAT,
        name: site.manifest.name.clone(),
        id: site.manifest.id.clone(),
        exported: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        app: app.to_string(),
        sources: sources.clone(),
    };

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
    Ok(Exported { path: out.to_path_buf(), files: files.len(), bytes: std::fs::metadata(out)?.len(), left_out, sources })
}

/// Reads what a package says about itself without unpacking it. A zip made by hand from a
/// table folder (site.json at the top, no mrstable.json) is read too.
pub fn about(file: &Path) -> Result<About, PackageError> {
    let mut zip = ZipArchive::new(File::open(file)?)?;
    read_about(&mut zip)
}

fn read_about<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Result<About, PackageError> {
    if let Ok(mut entry) = zip.by_name(ABOUT) {
        let mut text = String::new();
        entry.read_to_string(&mut text)?;
        let about: About = serde_json::from_str(&text).map_err(|e| refused(format!("its {ABOUT} could not be read ({e})")))?;
        if about.format > FORMAT {
            return Err(refused(format!(
                "this table file was made by a newer MR Studio (package format {}); this version reads up to {FORMAT}. Update MR Studio to open it.",
                about.format
            )));
        }
        return Ok(about);
    }
    let mut entry = zip.by_name("site.json").map_err(|_| refused("there is no site.json in it, so it is not a table"))?;
    let mut text = String::new();
    entry.read_to_string(&mut text)?;
    let site: serde_json::Value = serde_json::from_str(&text).map_err(|e| refused(format!("its site.json could not be read ({e})")))?;
    Ok(About {
        format: FORMAT,
        name: site["name"].as_str().unwrap_or("Table").to_string(),
        id: site["id"].as_str().unwrap_or_default().to_string(),
        ..About::default()
    })
}

/// A folder name from a table name: what the person would type, without the characters a
/// file system refuses.
pub fn folder_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c }).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = clean.trim_matches('.').trim().to_string();
    if clean.is_empty() {
        "Table".into()
    } else {
        clean
    }
}

/// The first free folder for `name` in `into`: "Lindholmen", then "Lindholmen 2", and so on.
fn free_folder(into: &Path, name: &str) -> PathBuf {
    let base = folder_name(name);
    let mut n = 1;
    loop {
        let candidate = if n == 1 { into.join(&base) } else { into.join(format!("{base} {n}")) };
        if !candidate.exists() && !into.join(format!(".{}.unpacking", candidate.file_name().unwrap().to_string_lossy())).exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Opens the package `file` as a new table folder in `into`. The folder is named after the
/// table; a table of that name already there is never touched, and the new one gets a number
/// and its own id. Unpacking happens in a hidden folder that is renamed when complete.
pub fn import(file: &Path, into: &Path) -> Result<Imported, PackageError> {
    let mut zip = ZipArchive::new(File::open(file)?)?;
    let about = read_about(&mut zip)?;
    std::fs::create_dir_all(into)?;
    let target = free_folder(into, &about.name);
    let folder = target.file_name().unwrap().to_string_lossy().to_string();
    let partial = into.join(format!(".{folder}.unpacking"));
    let unpacked = unpack(&mut zip, &partial);
    let files = match unpacked {
        Ok(files) => files,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&partial);
            return Err(e);
        }
    };
    if !partial.join("site.json").is_file() {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(refused("there is no site.json in it, so it is not a table"));
    }
    // A second copy of a table that is already here is its own table: its own id and a name
    // that tells the two apart on Home.
    let renamed = folder != folder_name(&about.name);
    let finish = (|| -> Result<Option<String>, PackageError> {
        let upgraded = migrate::upgrade_site(&partial)
            .map_err(|e| refused(e.to_string()))?
            .map(|u| format!("Brought up to date from site format {} to {}: {}", u.from, u.to, u.changes.join("; ")));
        if renamed {
            let path = partial.join("site.json");
            let mut site: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?).map_err(|e| refused(e.to_string()))?;
            site["name"] = folder.clone().into();
            site["id"] = crate::create::id_from(&folder).into();
            std::fs::write(&path, serde_json::to_string_pretty(&site).map_err(|e| refused(e.to_string()))? + "\n")?;
        }
        Ok(upgraded)
    })();
    let upgraded = match finish {
        Ok(upgraded) => upgraded,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&partial);
            return Err(e);
        }
    };
    std::fs::rename(&partial, &target)?;
    let problems = match Site::load(&target) {
        Ok(site) => site.problems(),
        Err(e) => vec![e.to_string()],
    };
    let name = if renamed { folder } else { about.name.clone() };
    Ok(Imported { dir: target, name, files, upgraded, sources: about.sources, problems })
}

fn unpack<R: Read + Seek>(zip: &mut ZipArchive<R>, to: &Path) -> Result<usize, PackageError> {
    std::fs::create_dir_all(to)?;
    let mut total = 0u64;
    let mut files = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(refused(format!("it names a file outside the table ({})", entry.name().unwrap_or_default())));
        };
        if relative.as_os_str().is_empty() || relative == Path::new(ABOUT) || entry.is_symlink() {
            continue;
        }
        // Hidden files and secrets are never written, even from a package made by hand.
        if relative.components().any(|c| left_behind(&c.as_os_str().to_string_lossy())) {
            continue;
        }
        let path = to.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&path)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        total += entry.size();
        if total > MAX_UNPACKED {
            return Err(refused("it unpacks to more than 16 GB, more than any table needs"));
        }
        let mut out = File::create(&path)?;
        // `take` holds each file to the size it declares, whatever the compressed data says.
        let size = entry.size();
        let copied = io::copy(&mut (&mut entry).take(size), &mut out)?;
        if copied != size {
            return Err(refused(format!("{} is cut short", relative.display())));
        }
        files += 1;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mrs-package-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A small table folder: the example site's site.json and data, plus things that must stay behind.
    fn table(dir: &Path) -> PathBuf {
        let site = dir.join("Lindholmen");
        crate::create::create(&site, "Lindholmen", 11.9384, 57.7066, 400.0, 300.0, 0.0).unwrap();
        std::fs::write(site.join("calibration.json"), "{\"corners\":[]}\n").unwrap();
        std::fs::create_dir_all(site.join("media")).unwrap();
        std::fs::write(site.join("media/logo.png"), [137, 80, 78, 71]).unwrap();
        std::fs::create_dir_all(site.join(".mrstudio/history")).unwrap();
        std::fs::write(site.join(".mrstudio/history/r00000001.json"), "{}").unwrap();
        std::fs::create_dir_all(site.join(".git")).unwrap();
        std::fs::write(site.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(site.join(".env"), "MAPBOX_TOKEN=pk.secret\n").unwrap();
        std::fs::write(site.join("credentials.json"), "{\"key\":\"secret\"}").unwrap();
        site
    }

    #[test]
    fn a_table_goes_out_and_comes_back_without_secrets_or_history() {
        let dir = scratch("round");
        let site = table(&dir);
        let out = dir.join("Lindholmen.mrstable");
        let need = SourceNeed { id: "mapbox".into(), kind: "mapbox".into(), name: "Mapbox".into(), layers: vec!["Base map".into()] };
        let exported = export(&site, &out, vec![need.clone()], "2.0.0").unwrap();
        assert!(out.is_file() && exported.bytes > 0);
        assert_eq!(exported.left_out, vec![".env".to_string(), "credentials.json".to_string()]);

        let names: Vec<String> = {
            let mut zip = ZipArchive::new(File::open(&out).unwrap()).unwrap();
            (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().unwrap().to_string()).collect()
        };
        assert_eq!(names[0], ABOUT);
        assert!(
            names.contains(&"site.json".to_string())
                && names.contains(&"calibration.json".to_string())
                && names.contains(&"media/logo.png".to_string())
        );
        assert!(
            !names.iter().any(|n| n.contains(".mrstudio") || n.contains(".git") || n.contains(".env") || n.contains("credentials")),
            "{names:?}"
        );

        let about = about(&out).unwrap();
        assert_eq!((about.name.as_str(), about.format, about.app.as_str()), ("Lindholmen", FORMAT, "2.0.0"));

        // On the other computer: a sites folder that already has a Lindholmen.
        let other = dir.join("other");
        let first = import(&out, &other).unwrap();
        assert_eq!(first.dir, other.join("Lindholmen"));
        assert_eq!(first.sources, vec![need]);
        assert!(first.dir.join("calibration.json").is_file() && first.dir.join("media/logo.png").is_file());
        assert!(!first.dir.join(".mrstudio").exists() && !first.dir.join(".env").exists());
        assert_eq!(std::fs::read(site.join("site.json")).unwrap(), std::fs::read(first.dir.join("site.json")).unwrap());

        let second = import(&out, &other).unwrap();
        assert_eq!(second.dir, other.join("Lindholmen 2"));
        let loaded = Site::load(&second.dir).unwrap();
        assert_eq!((loaded.manifest.name.as_str(), loaded.manifest.id.as_str()), ("Lindholmen 2", "lindholmen-2"));
        // The first copy was not touched.
        assert_eq!(Site::load(&first.dir).unwrap().manifest.name, "Lindholmen");
        assert!(!other.read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().ends_with(".unpacking")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_package_that_reaches_outside_the_table_is_refused() {
        let dir = scratch("slip");
        let file = dir.join("bad.mrstable");
        let mut zip = ZipWriter::new(File::create(&file).unwrap());
        zip.start_file("site.json", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"{\"format\":3,\"name\":\"Bad\"}").unwrap();
        zip.start_file("../outside.txt", SimpleFileOptions::default()).unwrap();
        zip.write_all(b"no").unwrap();
        zip.finish().unwrap();
        let into = dir.join("sites");
        let e = import(&file, &into).unwrap_err();
        assert!(e.to_string().contains("outside the table"), "{e}");
        assert!(!dir.join("outside.txt").exists());
        assert_eq!(into.read_dir().unwrap().count(), 0, "nothing is left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_package_from_a_newer_studio_says_so() {
        let dir = scratch("newer");
        let file = dir.join("new.mrstable");
        let mut zip = ZipWriter::new(File::create(&file).unwrap());
        zip.start_file(ABOUT, SimpleFileOptions::default()).unwrap();
        zip.write_all(b"{\"format\":99,\"name\":\"Future\",\"id\":\"future\"}").unwrap();
        zip.finish().unwrap();
        let e = import(&file, &dir.join("sites")).unwrap_err();
        assert!(e.to_string().contains("newer MR Studio"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_that_hold_keys_or_history_stay_behind() {
        for name in
            [".git", ".mrstudio", ".env", ".DS_Store", "credentials.json", "secrets.toml", "server.key", "sources.json", "old.mrstable"]
        {
            assert!(left_behind(name), "{name}");
        }
        for name in ["site.json", "calibration.json", "data", "buildings.geojson", "media"] {
            assert!(!left_behind(name), "{name}");
        }
        assert_eq!(folder_name("Lindholmen: Science/Park "), "Lindholmen Science Park");
        assert_eq!(folder_name("..."), "Table");
    }
}
