/// A scalar result covering the site extent, row-major with row 0 at the top.
/// It may be coarser than the scene grid.
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

/// Cells a stream sends at most unless it asks otherwise (#535): 2048 x 2048, about twice
/// what a projector or a 4K screen shows. Only a table bigger than about 2 km at 1 m cells
/// is shrunk.
pub const DEFAULT_MAX_CELLS: u32 = 2048 * 2048;

impl Field {
    /// The field with at most `max_cells` cells (#535): each side divided by the same whole
    /// number, each new cell the mean of the cells it covers. A field already small enough,
    /// or a `max_cells` of 0, comes back as it is.
    pub fn shrunk(self, max_cells: u32) -> Field {
        let cells = self.width as u64 * self.height as u64;
        if max_cells == 0 || cells <= max_cells as u64 {
            return self;
        }
        let mut k = ((cells as f64 / max_cells as f64).sqrt().ceil() as u32).max(2);
        while (self.width.div_ceil(k) as u64) * (self.height.div_ceil(k) as u64) > max_cells as u64 {
            k += 1;
        }
        let (width, height) = (self.width.div_ceil(k), self.height.div_ceil(k));
        let mut data = vec![0.0f32; (width * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let (mut sum, mut n) = (0.0f32, 0u32);
                for row in y * k..((y + 1) * k).min(self.height) {
                    let start = (row * self.width) as usize;
                    for col in x * k..((x + 1) * k).min(self.width) {
                        sum += self.data[start + col as usize];
                        n += 1;
                    }
                }
                data[(y * width + x) as usize] = sum / n as f32;
            }
        }
        Field { width, height, data, ..self }
    }
}

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
    fn a_big_field_is_shrunk_by_whole_steps_to_its_means() {
        let field = Field { width: 5, height: 4, units: "h", min: 0.0, max: 10.0, data: (0..20).map(|v| v as f32).collect() };
        assert_eq!(field.clone().shrunk(0).data.len(), 20, "0 is no limit");
        assert_eq!(field.clone().shrunk(20).data.len(), 20, "small enough");
        let small = field.shrunk(6);
        assert_eq!((small.width, small.height), (3, 2));
        // The first cell is the mean of 0, 1, 5, 6; the last column has one cell across.
        assert_eq!(small.data, vec![3.0, 5.0, 6.5, 13.0, 15.0, 16.5]);
        assert_eq!((small.min, small.max, small.units), (0.0, 10.0, "h"));
        let city =
            Field { width: 4000, height: 4000, units: "", min: 0.0, max: 1.0, data: vec![0.5; 16_000_000] }.shrunk(DEFAULT_MAX_CELLS);
        assert_eq!((city.width, city.height), (2000, 2000));
    }

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
