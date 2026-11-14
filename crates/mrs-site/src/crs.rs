//! The few coordinate systems site sources arrive in. Raster sources (GeoTIFF)
//! usually come on a national grid; this maps WGS84 onto them, so the bake can
//! sample them without a projection library.

/// A coordinate reference system a source raster can be in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Crs {
    /// Longitude and latitude in degrees (WGS84, ETRS89, SWEREF99).
    Geographic,
    /// Transverse Mercator on the GRS80/WGS84 ellipsoid: UTM, SWEREF99 TM and the SWEREF99 local zones.
    TransverseMercator { central_meridian_deg: f64, scale: f64, false_easting: f64, false_northing: f64 },
}

// GRS80. WGS84 differs by a tenth of a millimetre.
const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_222_101;

impl Crs {
    /// Parses `EPSG:<code>`.
    pub fn parse(text: &str) -> Option<Self> {
        let code = text.trim().strip_prefix("EPSG:").or_else(|| text.trim().strip_prefix("epsg:"))?;
        Self::from_epsg(code.parse().ok()?)
    }

    pub fn from_epsg(code: u32) -> Option<Self> {
        let tm = |central_meridian_deg, scale, false_easting, false_northing| {
            Some(Self::TransverseMercator { central_meridian_deg, scale, false_easting, false_northing })
        };
        let utm = |zone: u32, south: bool| tm(zone as f64 * 6.0 - 183.0, 0.9996, 500_000.0, if south { 10_000_000.0 } else { 0.0 });
        match code {
            4326 | 4258 | 4619 => Some(Self::Geographic),
            32601..=32660 => utm(code - 32600, false),
            32701..=32760 => utm(code - 32700, true),
            25828..=25838 => utm(code - 25800, false),
            3006 => tm(15.0, 0.9996, 500_000.0, 0.0),
            // SWEREF99 local zones, 12 00 to 23 15.
            3007..=3018 => {
                const MERIDIANS: [f64; 12] = [12.0, 13.5, 15.0, 16.5, 18.0, 14.25, 15.75, 17.25, 18.75, 20.25, 21.75, 23.25];
                tm(MERIDIANS[(code - 3007) as usize], 1.0, 150_000.0, 0.0)
            }
            _ => None,
        }
    }

    /// The codes `from_epsg` knows, for error messages.
    pub const SUPPORTED: &'static str =
        "EPSG:4326, EPSG:4258, UTM (EPSG:326xx, 327xx, 258xx), SWEREF99 TM (EPSG:3006) and the SWEREF99 local zones (EPSG:3007 to 3018)";

    /// WGS84 degrees to this system's coordinates (x east, y north).
    pub fn forward(&self, lon: f64, lat: f64) -> (f64, f64) {
        let Self::TransverseMercator { central_meridian_deg, scale, false_easting, false_northing } = *self else {
            return (lon, lat);
        };
        let n = F / (2.0 - F);
        let alpha =
            [n / 2.0 - 2.0 * n * n / 3.0 + 5.0 * n.powi(3) / 16.0, 13.0 * n * n / 48.0 - 3.0 * n.powi(3) / 5.0, 61.0 * n.powi(3) / 240.0];
        let e = (F * (2.0 - F)).sqrt();
        let phi = lat.to_radians();
        let dl = (lon - central_meridian_deg).to_radians();
        // Conformal latitude, then the Gauss-Schreiber coordinates.
        let t = (phi.sin().atanh() - e * (e * phi.sin()).atanh()).sinh();
        let xi = t.atan2(dl.cos());
        let eta = (dl.sin() / (1.0 + t * t).sqrt()).atanh();
        let (mut x, mut y) = (eta, xi);
        for (j, a) in alpha.iter().enumerate() {
            let k = 2.0 * (j + 1) as f64;
            y += a * (k * xi).sin() * (k * eta).cosh();
            x += a * (k * xi).cos() * (k * eta).sinh();
        }
        let r = scale * rectifying_radius(n);
        (false_easting + r * x, false_northing + r * y)
    }

    /// This system's coordinates to WGS84 degrees `(lon, lat)`.
    pub fn inverse(&self, x: f64, y: f64) -> (f64, f64) {
        let Self::TransverseMercator { central_meridian_deg, scale, false_easting, false_northing } = *self else {
            return (x, y);
        };
        let n = F / (2.0 - F);
        let beta = [n / 2.0 - 2.0 * n * n / 3.0 + 37.0 * n.powi(3) / 96.0, n * n / 48.0 + n.powi(3) / 15.0, 17.0 * n.powi(3) / 480.0];
        let delta = [2.0 * n - 2.0 * n * n / 3.0 - 2.0 * n.powi(3), 7.0 * n * n / 3.0 - 8.0 * n.powi(3) / 5.0, 56.0 * n.powi(3) / 15.0];
        let r = scale * rectifying_radius(n);
        let (xi, eta) = ((y - false_northing) / r, (x - false_easting) / r);
        let (mut xi0, mut eta0) = (xi, eta);
        for (j, b) in beta.iter().enumerate() {
            let k = 2.0 * (j + 1) as f64;
            xi0 -= b * (k * xi).sin() * (k * eta).cosh();
            eta0 -= b * (k * xi).cos() * (k * eta).sinh();
        }
        let chi = (xi0.sin() / eta0.cosh()).asin();
        let mut phi = chi;
        for (j, d) in delta.iter().enumerate() {
            phi += d * (2.0 * (j + 1) as f64 * chi).sin();
        }
        (central_meridian_deg + eta0.sinh().atan2(xi0.cos()).to_degrees(), phi.to_degrees())
    }
}

fn rectifying_radius(n: f64) -> f64 {
    A / (1.0 + n) * (1.0 + n * n / 4.0 + n.powi(4) / 64.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweref99_tm_matches_the_campus_corners() {
        // The south-east and north-west corners of the Chalmers table area, as the
        // old app stores them in WGS84, against the terrain raster's SWEREF99 TM bounds.
        let crs = Crs::parse("EPSG:3006").unwrap();
        for (lon, lat, e, n) in [
            (11.98451803339398, 57.682927961987396, 320_220.0, 6_397_410.0),
            (11.971022042873042, 57.693840269664186, 319_470.0, 6_398_660.0),
        ] {
            let (x, y) = crs.forward(lon, lat);
            assert!((x - e).abs() < 0.002 && (y - n).abs() < 0.002, "{x} {y}");
            let (lon2, lat2) = crs.inverse(e, n);
            assert!((lon2 - lon).abs() < 1e-7 && (lat2 - lat).abs() < 1e-7, "{lon2} {lat2}");
        }
    }

    #[test]
    fn utm_and_local_zones() {
        // On a central meridian the easting is the false easting.
        assert!((Crs::from_epsg(32633).unwrap().forward(15.0, 50.0).0 - 500_000.0).abs() < 1e-6);
        assert!((Crs::from_epsg(3007).unwrap().forward(12.0, 57.7).0 - 150_000.0).abs() < 1e-6);
        // The equator is the false northing: zero in the north, ten million in the south.
        assert!(Crs::from_epsg(25832).unwrap().forward(9.0, 0.0).1.abs() < 1e-6);
        assert!((Crs::from_epsg(32733).unwrap().forward(15.0, 0.0).1 - 10_000_000.0).abs() < 1e-6);
        // A degree of latitude along the central meridian is about 111.2 km at scale 0.9996.
        let utm = Crs::from_epsg(32633).unwrap();
        let d = utm.forward(15.0, 51.0).1 - utm.forward(15.0, 50.0).1;
        assert!((d - 111_229.0 * 0.9996).abs() < 60.0, "{d}");
        let (lon, lat) = utm.inverse(utm.forward(17.3, 59.1).0, utm.forward(17.3, 59.1).1);
        assert!((lon - 17.3).abs() < 1e-8 && (lat - 59.1).abs() < 1e-8, "{lon} {lat}");
        assert_eq!(Crs::parse("EPSG:4326"), Some(Crs::Geographic));
        assert_eq!(Crs::parse("EPSG:2154"), None);
    }
}
