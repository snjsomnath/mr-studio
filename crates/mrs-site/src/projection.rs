use crate::LonLat;

/// Tangent-plane projection at the site origin: WGS84 to local east/north metres.
/// Uses the ellipsoid's radii of curvature at the origin, which keeps errors to
/// centimetres across a site a few kilometres wide.
#[derive(Debug, Clone, Copy)]
pub struct Projection {
    origin: LonLat,
    m_per_deg_lon: f64,
    m_per_deg_lat: f64,
}

impl Projection {
    pub fn new(origin: LonLat) -> Self {
        const A: f64 = 6_378_137.0;
        const E2: f64 = 0.006_694_379_990_14;
        let phi = origin.lat.to_radians();
        let s = 1.0 - E2 * phi.sin().powi(2);
        let meridional = A * (1.0 - E2) / s.powf(1.5);
        let prime_vertical = A / s.sqrt();
        Self {
            origin,
            m_per_deg_lon: prime_vertical * phi.cos() * std::f64::consts::PI / 180.0,
            m_per_deg_lat: meridional * std::f64::consts::PI / 180.0,
        }
    }

    pub fn to_local(&self, lon: f64, lat: f64) -> (f64, f64) {
        ((lon - self.origin.lon) * self.m_per_deg_lon, (lat - self.origin.lat) * self.m_per_deg_lat)
    }

    pub fn to_lonlat(&self, east: f64, north: f64) -> LonLat {
        LonLat { lon: self.origin.lon + east / self.m_per_deg_lon, lat: self.origin.lat + north / self.m_per_deg_lat }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metres_per_degree_at_gothenburg() {
        let p = Projection::new(LonLat { lon: 11.9778, lat: 57.6884 });
        // One degree of latitude is about 111.4 km here, one of longitude about 59.6 km.
        let (e, n) = p.to_local(12.9778, 58.6884);
        assert!((n - 111_370.0).abs() < 100.0, "{n}");
        assert!((e - 59_640.0).abs() < 100.0, "{e}");
        let back = p.to_lonlat(e, n);
        assert!((back.lon - 12.9778).abs() < 1e-12 && (back.lat - 58.6884).abs() < 1e-12);
    }
}
