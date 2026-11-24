//! Pictures and video for slideshow steps (#197). A site keeps them under `data/media/`,
//! stored as they came (never converted), and a `media` layer names its file by that path.
//! Only formats every browser shows are taken: PNG, JPEG, WebP and GIF pictures, MP4 and
//! WebM video.

use std::path::Path;

use crate::sound::file_name;

/// The folder pictures and video live in, relative to the site folder.
pub const MEDIA_DIR: &str = "data/media";
/// The largest picture or video a site takes: a few minutes of video, not a film.
pub const MAX_MEDIA_BYTES: usize = 200 * 1024 * 1024;

const EXTENSIONS: [&str; 6] = ["png", "jpg", "webp", "gif", "mp4", "webm"];

/// The format of `bytes`, by its first bytes, as a file extension.
pub fn kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        // MP4 and QuickTime share the ISO box format; browsers play the H.264 ones either way.
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => Some("mp4"),
        [0x1A, 0x45, 0xDF, 0xA3, ..] => Some("webm"),
        _ => None,
    }
}

/// Saves a picture or video into the site and returns its path relative to the site folder.
pub fn save(site_dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(format!("This file is {} MB; a site takes pictures and video up to {} MB.", bytes.len() / 1_048_576, MAX_MEDIA_BYTES / 1_048_576));
    }
    let extension =
        kind(bytes).ok_or("This file is not a picture or video MR Studio can show. Use PNG, JPEG, WebP or GIF, or MP4 or WebM video.")?;
    let file = file_name(name, extension).replacen("sound.", "media.", 1);
    let relative = format!("{MEDIA_DIR}/{file}");
    let path = site_dir.join(&relative);
    std::fs::create_dir_all(path.parent().expect("inside data/")).map_err(|e| e.to_string())?;
    let partial = path.with_extension(format!("{extension}.part"));
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &path).map_err(|e| e.to_string())?;
    Ok(relative)
}

/// The pictures and video a site has, as paths relative to the site folder, sorted.
pub fn list(site_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(site_dir.join(MEDIA_DIR)) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| Path::new(n).extension().and_then(|e| e.to_str()).is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())))
        .map(|n| format!("{MEDIA_DIR}/{n}"))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_pictures_and_video_by_their_first_bytes() {
        assert_eq!(kind(b"\x89PNG\r\n\x1a\n"), Some("png"));
        assert_eq!(kind(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(kind(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some("webp"));
        assert_eq!(kind(b"GIF89a"), Some("gif"));
        assert_eq!(kind(b"\x00\x00\x00\x20ftypisom"), Some("mp4"));
        assert_eq!(kind(&[0x1A, 0x45, 0xDF, 0xA3, 0x9F]), Some("webm"));
        assert_eq!(kind(b"RIFF\x24\x00\x00\x00WAVEfmt "), None);
        assert_eq!(kind(b"{\"type\":\"FeatureCollection\"}"), None);
    }

    #[test]
    fn saves_and_lists_media() {
        let dir = std::env::temp_dir().join(format!("mrs-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(save(&dir, "Satellit (nu).PNG", b"\x89PNG\r\n\x1a\n").unwrap(), "data/media/satellit-nu.png");
        assert_eq!(save(&dir, "???", b"\x00\x00\x00\x20ftypisom").unwrap(), "data/media/media.mp4");
        assert!(save(&dir, "notes.txt", b"hello").is_err());
        assert_eq!(list(&dir), vec!["data/media/media.mp4".to_string(), "data/media/satellit-nu.png".to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
