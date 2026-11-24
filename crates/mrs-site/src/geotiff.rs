//! Reads a single-band GeoTIFF elevation raster and samples it at WGS84 positions.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use tiff::decoder::{Decoder, DecodingResult, Limits};
use tiff::tags::Tag;

use crate::crs::Crs;

const GEO_ASCII_PARAMS: u16 = 34737;
const KEY_MODEL_TYPE: u16 = 1024;
const KEY_RASTER_TYPE: u16 = 1025;
const KEY_GEOGRAPHIC_TYPE: u16 = 2048;
const KEY_PROJECTED_TYPE: u16 = 3072;

#[derive(Debug)]
pub struct GeoRaster {
    pub width: usize,
    pub height: usize,
    /// Band 1, row 0 at the top. NaN where the file has no data.
    pub data: Vec<f32>,
    pub crs: Crs,
    /// Model coordinates of the centre of pixel (0, 0), and the pixel size.
    x0: f64,
    y0: f64,
    dx: f64,
    dy: f64,
}

impl GeoRaster {
    /// `crs` overrides what the file says, for files that only carry a citation.
    pub fn read(path: &Path, crs: Option<Crs>) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let mut decoder = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?.with_limits(Limits::unlimited());
        let (width, height) = decoder.dimensions().map_err(|e| e.to_string())?;
        let (width, height) = (width as usize, height as usize);

        let scale = decoder.find_tag(Tag::ModelPixelScaleTag).ok().flatten().and_then(|v| v.into_f64_vec().ok());
        let tie = decoder.find_tag(Tag::ModelTiepointTag).ok().flatten().and_then(|v| v.into_f64_vec().ok());
        let (Some(scale), Some(tie)) = (scale.filter(|s| s.len() >= 2 && s[0] > 0.0 && s[1] > 0.0), tie.filter(|t| t.len() >= 6)) else {
            return Err("not a north-up GeoTIFF: it needs ModelPixelScale and ModelTiepoint tags".into());
        };

        let keys = decoder.find_tag(Tag::GeoKeyDirectoryTag).ok().flatten().and_then(|v| v.into_u16_vec().ok()).unwrap_or_default();
        let key = |id: u16| keys.as_chunks::<4>().0.iter().skip(1).find(|k| k[0] == id && k[1] == 0).map(|k| k[3]);
        let crs = match crs {
            Some(crs) => crs,
            None => {
                let code = match key(KEY_MODEL_TYPE) {
                    Some(2) => key(KEY_GEOGRAPHIC_TYPE).or(Some(4326)),
                    _ => key(KEY_PROJECTED_TYPE),
                }
                .filter(|code| *code != 32767);
                let citation = decoder.get_tag_ascii_string(Tag::Unknown(GEO_ASCII_PARAMS)).unwrap_or_default();
                let citation = citation.trim_matches(['|', '\0', ' ']);
                match code {
                    Some(code) => Crs::from_epsg(code as u32)
                        .ok_or_else(|| format!("coordinate system EPSG:{code} is not supported; reproject to one of {}", Crs::SUPPORTED))?,
                    None => {
                        return Err(format!(
                            "the file does not say which coordinate system it is in{}; add \"crs\": \"EPSG:<code>\" next to its path",
                            if citation.is_empty() { String::new() } else { format!(" (it only cites '{citation}')") }
                        ))
                    }
                }
            }
        };

        let nodata = decoder.get_tag_ascii_string(Tag::GdalNodata).ok().and_then(|s| s.trim_matches(['\0', ' ']).parse::<f64>().ok());
        let values: Vec<f32> = match decoder.read_image().map_err(|e| e.to_string())? {
            DecodingResult::F32(v) => v,
            DecodingResult::F64(v) => v.into_iter().map(|x| x as f32).collect(),
            DecodingResult::U8(v) => v.into_iter().map(f32::from).collect(),
            DecodingResult::I8(v) => v.into_iter().map(f32::from).collect(),
            DecodingResult::U16(v) => v.into_iter().map(f32::from).collect(),
            DecodingResult::I16(v) => v.into_iter().map(f32::from).collect(),
            DecodingResult::U32(v) => v.into_iter().map(|x| x as f32).collect(),
            DecodingResult::I32(v) => v.into_iter().map(|x| x as f32).collect(),
            _ => return Err("unsupported sample type".into()),
        };
        let cells = width * height;
        if cells == 0 || !values.len().is_multiple_of(cells) {
            return Err(format!("{} samples do not fit a {width} x {height} image", values.len()));
        }
        // Band 1 of a pixel-interleaved image.
        let bands = values.len() / cells;
        let data = values
            .into_iter()
            .step_by(bands)
            .map(|v| if nodata.is_some_and(|n| v as f64 == n) || !v.is_finite() { f32::NAN } else { v })
            .collect();

        // The tiepoint pins raster (i, j) to model (x, y). With PixelIsArea, the default,
        // raster coordinates are pixel corners, so the first centre is half a pixel in.
        let half = if key(KEY_RASTER_TYPE) == Some(2) { 0.0 } else { 0.5 };
        let (dx, dy) = (scale[0], scale[1]);
        Ok(Self { width, height, data, crs, x0: tie[3] + (half - tie[0]) * dx, y0: tie[4] - (half - tie[1]) * dy, dx, dy })
    }

    /// Bilinear sample at a WGS84 position. `None` outside the raster or where it has no data.
    pub fn sample(&self, lon: f64, lat: f64) -> Option<f32> {
        let (x, y) = self.crs.forward(lon, lat);
        let (fx, fy) = ((x - self.x0) / self.dx, (self.y0 - y) / self.dy);
        // Pixels cover half a pixel beyond their centres.
        if !(fx >= -0.5 && fy >= -0.5 && fx <= self.width as f64 - 0.5 && fy <= self.height as f64 - 0.5) {
            return None;
        }
        let (fx, fy) = (fx.clamp(0.0, self.width as f64 - 1.0), fy.clamp(0.0, self.height as f64 - 1.0));
        let (c0, r0) = (fx.floor() as usize, fy.floor() as usize);
        let (c1, r1) = ((c0 + 1).min(self.width - 1), (r0 + 1).min(self.height - 1));
        let (tx, ty) = ((fx - c0 as f64) as f32, (fy - r0 as f64) as f32);
        let (mut sum, mut weight) = (0.0, 0.0);
        for (c, r, w) in [(c0, r0, (1.0 - tx) * (1.0 - ty)), (c1, r0, tx * (1.0 - ty)), (c0, r1, (1.0 - tx) * ty), (c1, r1, tx * ty)] {
            let v = self.data[r * self.width + c];
            if v.is_finite() {
                sum += v * w;
                weight += w;
            }
        }
        (weight > 1e-6).then(|| sum / weight)
    }
}
