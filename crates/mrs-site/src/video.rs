//! Videos in a site (#194): an MP4, QuickTime or WebM file, read just far enough to know its
//! length and picture size, so a layer can pace something on the table to it before it plays.

/// What a video file is.
#[derive(Debug, Clone, PartialEq)]
pub struct Video {
    /// `mp4`, `mov` or `webm`: the extension it is saved with.
    pub format: &'static str,
    /// Its length in seconds, when the file says.
    pub duration_s: Option<f64>,
    /// The picture's width and height in pixels, when the file says.
    pub size: Option<(u32, u32)>,
}

/// A video, by its first bytes; None for anything else.
pub fn sniff(bytes: &[u8]) -> Option<Video> {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let format = if &bytes[8..12] == b"qt  " { "mov" } else { "mp4" };
        let mut video = Video { format, duration_s: None, size: None };
        iso_boxes(bytes, &mut video, false);
        return Some(video);
    }
    if bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        let mut video = Video { format: "webm", duration_s: None, size: None };
        let mut scale = 1_000_000.0;
        let mut raw = None;
        ebml(bytes, &mut video, &mut scale, &mut raw, 0);
        video.duration_s = raw.map(|d: f64| d * scale / 1e9).filter(|d| d.is_finite() && *d > 0.0);
        return Some(video);
    }
    None
}

fn u16_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?) as u32)
}
fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// Walks ISO base media boxes: the movie header for the length, a video track's header for the size.
/// Returns whether a track it walked is a video track.
fn iso_boxes(b: &[u8], video: &mut Video, in_track: bool) -> bool {
    let mut at = 0;
    let mut is_video = false;
    let mut track_size = None;
    while at + 8 <= b.len() {
        let Some(size32) = u32_at(b, at) else { break };
        let kind = &b[at + 4..at + 8];
        let (header, size) = match size32 {
            0 => (8, b.len() - at),
            1 => match u64_at(b, at + 8) {
                Some(s) => (16, s as usize),
                None => break,
            },
            s => (8, s as usize),
        };
        if size < header || at + size > b.len() {
            break;
        }
        let body = &b[at + header..at + size];
        match kind {
            b"moov" | b"mdia" => is_video |= iso_boxes(body, video, in_track),
            b"trak" => {
                iso_boxes(body, video, true);
            }
            b"mvhd" => {
                let (scale, duration) = match body.first() {
                    Some(1) => (u32_at(body, 20), u64_at(body, 24)),
                    _ => (u32_at(body, 12), u32_at(body, 16).map(u64::from)),
                };
                if let (Some(scale), Some(duration)) = (scale, duration) {
                    if scale > 0 && duration > 0 && duration != u64::from(u32::MAX) {
                        video.duration_s = Some(duration as f64 / scale as f64);
                    }
                }
            }
            b"tkhd" if in_track => {
                // Width and height close the header, as 16.16 fixed point.
                let end = if body.first() == Some(&1) { 88 } else { 76 };
                if let (Some(w), Some(h)) = (u16_at(body, end), u16_at(body, end + 4)) {
                    if w > 0 && h > 0 {
                        track_size = Some((w, h));
                    }
                }
            }
            b"hdlr" if in_track => is_video |= body.get(8..12) == Some(b"vide"),
            _ => {}
        }
        at += size;
    }
    if in_track && is_video && video.size.is_none() {
        video.size = track_size;
    }
    is_video
}

/// An EBML variable-length number: its value (without the length marker unless `keep`) and length.
fn vint(b: &[u8], at: usize, keep: bool) -> Option<(u64, usize)> {
    let first = *b.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 {
        return None;
    }
    let mut value = if keep { first as u64 } else { (first as u64) & (0xffu64 >> len) };
    for k in 1..len {
        value = (value << 8) | *b.get(at + k)? as u64;
    }
    Some((value, len))
}

/// Walks Matroska elements: Segment > Info (scale, duration) and Tracks > TrackEntry > Video (size).
fn ebml(b: &[u8], video: &mut Video, scale: &mut f64, duration: &mut Option<f64>, depth: usize) {
    const SEGMENT: u64 = 0x1853_8067;
    const INFO: u64 = 0x1549_a966;
    const TRACKS: u64 = 0x1654_ae6b;
    const ENTRY: u64 = 0xae;
    const VIDEO: u64 = 0xe0;
    let mut at = 0;
    while at < b.len() && depth < 6 {
        let Some((id, id_len)) = vint(b, at, true) else { return };
        let Some((size, size_len)) = vint(b, at + id_len, false) else { return };
        let start = at + id_len + size_len;
        // An unknown size (all ones) runs to the end of what holds it.
        let unknown = size == (1u64 << (7 * size_len)) - 1;
        let end = if unknown { b.len() } else { start.saturating_add(size as usize).min(b.len()) };
        if start > b.len() {
            return;
        }
        let body = &b[start..end];
        let uint = || body.iter().fold(0u64, |v, x| (v << 8) | *x as u64);
        match id {
            SEGMENT | INFO | TRACKS | ENTRY | VIDEO => ebml(body, video, scale, duration, depth + 1),
            0x2a_d7b1 => *scale = uint() as f64,
            0x4489 => {
                *duration = match body.len() {
                    4 => Some(f32::from_be_bytes(body.try_into().unwrap()) as f64),
                    8 => Some(f64::from_be_bytes(body.try_into().unwrap())),
                    _ => None,
                }
            }
            0xb0 => {
                let w = uint() as u32;
                video.size = Some((w, video.size.map_or(0, |s| s.1)));
            }
            0xba => {
                let h = uint() as u32;
                video.size = Some((video.size.map_or(0, |s| s.0), h));
            }
            // Clusters hold the pictures: nothing more to learn past them.
            0x1f43_b675 => return,
            _ => {}
        }
        at = end;
    }
}

/// "3 min 12 s", "48 s".
pub fn length_words(seconds: f64) -> String {
    let s = seconds.round() as u64;
    if s >= 60 {
        format!("{} min {} s", s / 60, s % 60)
    } else {
        format!("{s} s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    /// The smallest MP4 that says how long it is and how big its picture is.
    fn mp4(seconds: u32, w: u16, h: u16) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&(seconds * 1000).to_be_bytes());
        let mut tkhd_full = vec![0u8; 84];
        tkhd_full[76..78].copy_from_slice(&w.to_be_bytes());
        tkhd_full[80..82].copy_from_slice(&h.to_be_bytes());
        let mut hdlr = vec![0u8; 24];
        hdlr[8..12].copy_from_slice(b"vide");
        let trak = boxed(b"trak", &[boxed(b"tkhd", &tkhd_full), boxed(b"mdia", &boxed(b"hdlr", &hdlr))].concat());
        let sound = {
            let mut hdlr = vec![0u8; 24];
            hdlr[8..12].copy_from_slice(b"soun");
            boxed(b"trak", &[boxed(b"tkhd", &[0u8; 88]), boxed(b"mdia", &boxed(b"hdlr", &hdlr))].concat())
        };
        let mut ftyp = b"isom".to_vec();
        ftyp.extend_from_slice(&[0, 0, 2, 0]);
        [boxed(b"ftyp", &ftyp), boxed(b"mdat", &[1, 2, 3]), boxed(b"moov", &[boxed(b"mvhd", &mvhd), sound, trak].concat())].concat()
    }

    #[test]
    fn an_mp4_says_its_length_and_size() {
        let video = sniff(&mp4(192, 1920, 1080)).unwrap();
        assert_eq!(video, Video { format: "mp4", duration_s: Some(192.0), size: Some((1920, 1080)) });
        assert_eq!(length_words(192.4), "3 min 12 s");
        assert_eq!(length_words(48.0), "48 s");
    }

    #[test]
    fn a_webm_says_its_length_and_size() {
        // EBML header, then a Segment of unknown size with Info (scale 1 ms, 12.5 s) and a video track 640 by 360.
        let mut b = vec![0x1a, 0x45, 0xdf, 0xa3, 0x80];
        b.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
        let duration = 12_500.0f64.to_be_bytes();
        let info = [&[0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40][..], &[0x44, 0x89, 0x88], &duration].concat();
        b.extend_from_slice(&[0x15, 0x49, 0xa9, 0x66, 0x80 | info.len() as u8]);
        b.extend_from_slice(&info);
        let video = [0xb0, 0x82, 0x02, 0x80, 0xba, 0x82, 0x01, 0x68];
        let entry = [&[0xe0, 0x80 | video.len() as u8][..], &video].concat();
        let tracks = [&[0xae, 0x80 | entry.len() as u8][..], &entry].concat();
        b.extend_from_slice(&[0x16, 0x54, 0xae, 0x6b, 0x80 | tracks.len() as u8]);
        b.extend_from_slice(&tracks);
        b.extend_from_slice(&[0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00]);
        let found = sniff(&b).unwrap();
        assert_eq!(found, Video { format: "webm", duration_s: Some(12.5), size: Some((640, 360)) });
    }

    #[test]
    fn other_files_are_not_videos() {
        assert!(sniff(b"{\"type\":\"FeatureCollection\"}").is_none());
        assert!(sniff(&[0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).is_none());
        // A cut-off MP4 is still a video, of unknown length.
        assert_eq!(sniff(&mp4(10, 4, 4)[..40]).unwrap().duration_s, None);
    }
}
