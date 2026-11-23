//! Free elevation for a table's ground: Terrarium terrain tiles (Mapzen's, on AWS Open
//! Data, no key), stitched and resampled into a small GeoTIFF in EPSG:4326 that the
//! terrain import reads like any other file. The tiles mix SRTM, GMTED, ETOPO1 and
//! national models, so outside a few countries they are about 30 m: coarse for a campus.

use std::io::Cursor;

use tiff::encoder::{colortype::Gray32Float, TiffEncoder};
use tiff::tags::Tag;

/// Where the tiles are: `{z}/{x}/{y}` Web Mercator, 256 px PNGs.
pub const TILE_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/// The credit the tiles ask for, kept with the data.
pub const ATTRIBUTION: &str = "Terrain Tiles by Mapzen on AWS Open Data, from SRTM, GMTED, ETOPO1 and national elevation models";

/// The finest zoom asked for: about 5 m pixels at 57°N, finer than any source under it.
const MOST_ZOOM: u32 = 14;
/// The most tiles one table asks for.
const MOST_TILES: usize = 36;

/// One 256 × 256 tile to fetch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileId {
    pub z: u32,
    pub x: u32,
    pub y: u32,
}

impl TileId {
    pub fn url(&self) -> String {
        TILE_URL.replace("{z}", &self.z.to_string()).replace("{x}", &self.x.to_string()).replace("{y}", &self.y.to_string())
    }
}

fn lon_to_x(lon: f64, n: f64) -> f64 {
    (lon + 180.0) / 360.0 * n
}

fn lat_to_y(lat: f64, n: f64) -> f64 {
    let r = lat.to_radians();
    (1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0 * n
}

/// The tiles covering `bounds` (`[south, west, north, east]`) at the finest zoom that keeps
/// to `MOST_TILES`.
pub fn tiles(bounds: [f64; 4]) -> Vec<TileId> {
    let [s, w, n, e] = bounds;
    let mut z = MOST_ZOOM;
    loop {
        let size = f64::from(1u32 << z);
        let (x0, x1) = (lon_to_x(w, size).floor() as u32, lon_to_x(e, size).floor() as u32);
        let (y0, y1) = (lat_to_y(n, size).floor() as u32, lat_to_y(s, size).floor() as u32);
        let count = ((x1 - x0 + 1) * (y1 - y0 + 1)) as usize;
        if count <= MOST_TILES || z == 1 {
            return (x0..=x1).flat_map(|x| (y0..=y1).map(move |y| TileId { z, x, y })).collect();
        }
        z -= 1;
    }
}

/// Heights in metres from one Terrarium PNG: (R × 256 + G + B / 256) − 32768.
pub fn decode(png_bytes: &[u8]) -> Result<Vec<f32>, String> {
    let mut decoder = png::Decoder::new(Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size().ok_or("the tile is too large")?];
    let frame = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    if frame.width != 256 || frame.height != 256 {
        return Err(format!("a tile of {} × {} pixels, not 256 × 256", frame.width, frame.height));
    }
    let channels = frame.color_type.samples();
    if channels < 3 {
        return Err("the tile is not an RGB image".into());
    }
    Ok(buffer[..frame.buffer_size()]
        .chunks_exact(channels)
        .map(|p| (f32::from(p[0]) * 256.0 + f32::from(p[1]) + f32::from(p[2]) / 256.0) - 32768.0)
        .collect())
}

/// Stitches decoded tiles and resamples them onto a lon/lat grid over `bounds`, written as a
/// single-band float GeoTIFF in EPSG:4326 (pixel-is-area, top-left tie point).
pub fn geotiff(bounds: [f64; 4], tiles: &[(TileId, Vec<f32>)]) -> Result<Vec<u8>, String> {
    let Some(first) = tiles.first() else { return Err("no elevation tiles".into()) };
    let z = first.0.z;
    let size = f64::from(1u32 << z);
    let [s, w, n, e] = bounds;
    // Pixels about as fine as the tiles' own, in degrees.
    let pixel_deg = 360.0 / size / 256.0;
    let width = (((e - w) / pixel_deg).ceil() as usize).clamp(2, 4096);
    // A Mercator pixel is as tall as it is wide on the ground: cos(lat) of its width in degrees of latitude.
    let height = (((n - s) / (pixel_deg * ((s + n) / 2.0).to_radians().cos().max(0.1))).ceil() as usize).clamp(2, 4096);
    let (dx, dy) = ((e - w) / width as f64, (n - s) / height as f64);
    let height_at = |gx: f64, gy: f64| -> Option<f32> {
        let (tx, ty) = (gx.floor() as u32, gy.floor() as u32);
        let (_, data) = tiles.iter().find(|(id, _)| id.x == tx && id.y == ty)?;
        let (px, py) = (((gx - f64::from(tx)) * 256.0) as usize, ((gy - f64::from(ty)) * 256.0) as usize);
        data.get(py.min(255) * 256 + px.min(255)).copied()
    };
    let mut data = Vec::with_capacity(width * height);
    for row in 0..height {
        let lat = n - (row as f64 + 0.5) * dy;
        let gy = lat_to_y(lat, size);
        for col in 0..width {
            let lon = w + (col as f64 + 0.5) * dx;
            // Bilinear between the four nearest tile pixels' centres.
            let (gx, gyc) = (lon_to_x(lon, size) * 256.0 - 0.5, gy * 256.0 - 0.5);
            let (fx, fy) = (gx - gx.floor(), gyc - gyc.floor());
            let at = |ox: f64, oy: f64| height_at((gx.floor() + ox + 0.5) / 256.0, (gyc.floor() + oy + 0.5) / 256.0);
            let value = match (at(0.0, 0.0), at(1.0, 0.0), at(0.0, 1.0), at(1.0, 1.0)) {
                (Some(a), Some(b), Some(c), Some(d)) => {
                    let top = f64::from(a) * (1.0 - fx) + f64::from(b) * fx;
                    let bottom = f64::from(c) * (1.0 - fx) + f64::from(d) * fx;
                    (top * (1.0 - fy) + bottom * fy) as f32
                }
                (Some(a), ..) => a,
                _ => f32::NAN,
            };
            data.push(value);
        }
    }
    let mut bytes = Cursor::new(Vec::new());
    {
        let mut encoder = TiffEncoder::new(&mut bytes).map_err(|e| e.to_string())?;
        let mut image = encoder.new_image::<Gray32Float>(width as u32, height as u32).map_err(|e| e.to_string())?;
        image.encoder().write_tag(Tag::ModelPixelScaleTag, &[dx, dy, 0.0][..]).map_err(|e| e.to_string())?;
        image.encoder().write_tag(Tag::ModelTiepointTag, &[0.0, 0.0, 0.0, w, n, 0.0][..]).map_err(|e| e.to_string())?;
        // Version 1.1.0, 3 keys: geographic model, pixel is area, WGS 84.
        let keys: [u16; 16] = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326];
        image.encoder().write_tag(Tag::GeoKeyDirectoryTag, &keys[..]).map_err(|e| e.to_string())?;
        image.encoder().write_tag(Tag::ImageDescription, ATTRIBUTION).map_err(|e| e.to_string())?;
        image.write_data(&data).map_err(|e| e.to_string())?;
    }
    Ok(bytes.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terrarium(height_m: f32) -> Vec<u8> {
        let v = height_m + 32768.0;
        let (r, g, b) = ((v / 256.0).floor() as u8, (v % 256.0).floor() as u8, ((v.fract()) * 256.0) as u8);
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 256, 256);
            encoder.set_color(png::ColorType::Rgb);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[r, g, b].repeat(256 * 256)).unwrap();
        }
        bytes
    }

    #[test]
    fn a_table_asks_for_a_few_tiles_and_gets_a_geotiff_it_can_read() {
        // About 1 × 0.6 km around Chalmers.
        let bounds = [57.6855, 11.9650, 57.6910, 11.9820];
        let ids = tiles(bounds);
        assert!(ids.len() <= MOST_TILES && !ids.is_empty());
        assert_eq!(ids[0].z, MOST_ZOOM);
        assert!(ids[0].url().starts_with("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/"));
        assert_eq!(decode(&terrarium(42.5)).unwrap()[0], 42.5);
        let decoded: Vec<_> = ids.iter().map(|id| (*id, decode(&terrarium(12.0)).unwrap())).collect();
        let bytes = geotiff(bounds, &decoded).unwrap();
        let dir = std::env::temp_dir().join(format!("mrs-elevation-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ground.tif");
        std::fs::write(&path, bytes).unwrap();
        let raster = crate::geotiff::GeoRaster::read(&path, None).unwrap();
        assert!((raster.sample(11.97, 57.688).unwrap() - 12.0).abs() < 1e-3);
        assert_eq!(raster.sample(12.5, 57.688), None, "nothing outside the bounds");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
