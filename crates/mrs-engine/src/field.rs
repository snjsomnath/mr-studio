/// A scalar result on the scene grid, row-major with row 0 at the top.
#[derive(Debug, Clone)]
pub struct Field {
    pub width: u32,
    pub height: u32,
    pub units: &'static str,
    /// Value range the data should be displayed and quantised over.
    pub min: f32,
    pub max: f32,
    pub data: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    F32,
    U8,
}

impl Encoding {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "f32" => Some(Self::F32),
            "u8" => Some(Self::U8),
            _ => None,
        }
    }
}

pub const FRAME_HEADER_LEN: usize = 40;

/// Encodes a field as a binary frame. Layout in `docs/contracts/engine.md`.
pub fn encode_frame(field: &Field, encoding: Encoding, stream: u32, field_index: u32, revision: u32, progress: f32) -> Vec<u8> {
    let n = field.data.len();
    let body = match encoding {
        Encoding::F32 => n * 4,
        Encoding::U8 => n,
    };
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + body);
    out.extend_from_slice(b"MRSF");
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(
        &(match encoding {
            Encoding::F32 => 0u16,
            Encoding::U8 => 1u16,
        })
        .to_le_bytes(),
    );
    out.extend_from_slice(&stream.to_le_bytes());
    out.extend_from_slice(&field_index.to_le_bytes());
    out.extend_from_slice(&field.width.to_le_bytes());
    out.extend_from_slice(&field.height.to_le_bytes());
    out.extend_from_slice(&revision.to_le_bytes());
    out.extend_from_slice(&field.min.to_le_bytes());
    out.extend_from_slice(&field.max.to_le_bytes());
    out.extend_from_slice(&progress.to_le_bytes());
    match encoding {
        Encoding::F32 => out.extend_from_slice(bytemuck::cast_slice(&field.data)),
        Encoding::U8 => {
            let span = field.max - field.min;
            let scale = if span > 0.0 { 255.0 / span } else { 0.0 };
            out.extend(field.data.iter().map(|v| ((v - field.min) * scale + 0.5).clamp(0.0, 255.0) as u8));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_layout() {
        let f = Field { width: 2, height: 1, units: "h", min: 0.0, max: 10.0, data: vec![0.0, 10.0] };
        let b = encode_frame(&f, Encoding::U8, 7, 1, 3, 0.5);
        assert_eq!(b.len(), FRAME_HEADER_LEN + 2);
        assert_eq!(&b[0..4], b"MRSF");
        assert_eq!(u32::from_le_bytes(b[8..12].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(b[16..20].try_into().unwrap()), 2);
        assert_eq!(&b[40..], &[0, 255]);
        let b = encode_frame(&f, Encoding::F32, 7, 1, 3, 0.5);
        assert_eq!(b.len(), FRAME_HEADER_LEN + 8);
    }
}
