//! Sound files for points (#150). A site keeps them under `data/sounds/`, stored as they came
//! (never converted), and point features name theirs in a column. Only audio the browsers all
//! play is taken: WAV, MP3, OGG and M4A/AAC.

use std::path::Path;

/// The folder sounds live in, relative to the site folder.
pub const SOUNDS_DIR: &str = "data/sounds";
/// The largest sound file a site takes: a field recording, not an album.
pub const MAX_SOUND_BYTES: usize = 32 * 1024 * 1024;

/// The audio format of `bytes`, by its first bytes, as a file extension.
pub fn kind(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => Some("wav"),
        [b'I', b'D', b'3', ..] => Some("mp3"),
        [0xFF, second, ..] if second & 0xE0 == 0xE0 && second & 0x06 != 0 => Some("mp3"),
        [b'O', b'g', b'g', b'S', ..] => Some("ogg"),
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => Some("m4a"),
        _ => None,
    }
}

/// A safe file name: lowercase letters, digits, dashes and underscores, then the format's extension.
pub fn file_name(name: &str, extension: &str) -> String {
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("sound");
    let mut clean = String::new();
    for c in stem.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'å' | 'ä' | 'à' | 'á' | 'â' => 'a',
            'ö' | 'ø' | 'ó' | 'ò' | 'ô' => 'o',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'ü' | 'ú' | 'ù' => 'u',
            c if c.is_ascii_alphanumeric() || c == '-' || c == '_' => c,
            _ => '-',
        };
        if !(c == '-' && clean.ends_with('-')) {
            clean.push(c);
        }
    }
    let clean = clean.trim_matches('-');
    format!("{}.{extension}", if clean.is_empty() { "sound" } else { clean })
}

/// Saves a sound into the site and returns its path relative to the site folder.
pub fn save(site_dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_SOUND_BYTES {
        return Err(format!("This sound is {} MB; a site takes sounds up to {} MB.", bytes.len() / 1_048_576, MAX_SOUND_BYTES / 1_048_576));
    }
    let extension = kind(bytes).ok_or("This file is not a sound MR Studio can play. Use WAV, MP3, OGG or M4A.")?;
    let file = file_name(name, extension);
    let relative = format!("{SOUNDS_DIR}/{file}");
    let path = site_dir.join(&relative);
    std::fs::create_dir_all(path.parent().expect("inside data/")).map_err(|e| e.to_string())?;
    let partial = path.with_extension(format!("{extension}.part"));
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &path).map_err(|e| e.to_string())?;
    Ok(relative)
}

/// The sounds a site has, as paths relative to the site folder, sorted.
pub fn list(site_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(site_dir.join(SOUNDS_DIR)) else { return Vec::new() };
    let mut out: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| matches!(Path::new(n).extension().and_then(|e| e.to_str()), Some("wav" | "mp3" | "ogg" | "m4a")))
        .map(|n| format!("{SOUNDS_DIR}/{n}"))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_audio_by_its_first_bytes() {
        assert_eq!(kind(b"RIFF\x24\x00\x00\x00WAVEfmt "), Some("wav"));
        assert_eq!(kind(b"ID3\x04\x00"), Some("mp3"));
        assert_eq!(kind(&[0xFF, 0xFB, 0x90, 0x00]), Some("mp3"));
        assert_eq!(kind(b"OggS\x00\x02"), Some("ogg"));
        assert_eq!(kind(b"\x00\x00\x00\x20ftypM4A "), Some("m4a"));
        assert_eq!(kind(b"{\"type\":\"FeatureCollection\"}"), None);
        assert_eq!(kind(b"\x89PNG\r\n"), None);
    }

    #[test]
    fn names_are_safe_and_keep_their_format() {
        assert_eq!(file_name("Koltrast (morgon).MP3", "mp3"), "koltrast-morgon.mp3");
        assert_eq!(file_name("../../etc/passwd", "wav"), "passwd.wav");
        assert_eq!(file_name("Hämpling", "ogg"), "hampling.ogg");
        assert_eq!(file_name("???", "wav"), "sound.wav");
    }

    #[test]
    fn saves_and_lists_sounds() {
        let dir = std::env::temp_dir().join(format!("mrs-sound-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(save(&dir, "Blackbird.wav", b"RIFF\x24\x00\x00\x00WAVEfmt ").unwrap(), "data/sounds/blackbird.wav");
        assert!(save(&dir, "notes.txt", b"hello").is_err());
        assert_eq!(list(&dir), vec!["data/sounds/blackbird.wav".to_string()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
