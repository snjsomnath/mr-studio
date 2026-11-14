//! Sun position from the NOAA solar position equations (after Meeus).
//! Accurate to a few hundredths of a degree for the years this app cares about.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SunPosition {
    /// Compass bearing of the sun, clockwise from north, degrees.
    pub azimuth_deg: f64,
    /// Angle above the horizon, degrees. Negative at night. No refraction correction.
    pub altitude_deg: f64,
}

struct Orbit {
    declination: f64,
    /// Equation of time, minutes.
    eot_min: f64,
}

fn orbit(unix: f64) -> Orbit {
    let jc = (unix / 86400.0 + 2440587.5 - 2451545.0) / 36525.0;
    let l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)).rem_euclid(360.0).to_radians();
    let m = (357.52911 + jc * (35999.05029 - 0.0001537 * jc)).to_radians();
    let e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    let c =
        m.sin() * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + (2.0 * m).sin() * (0.019993 - 0.000101 * jc) + (3.0 * m).sin() * 0.000289;
    let omega = (125.04 - 1934.136 * jc).to_radians();
    let lambda = (l0.to_degrees() + c - 0.00569 - 0.00478 * omega.sin()).to_radians();
    let eps0 = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
    let eps = (eps0 + 0.00256 * omega.cos()).to_radians();
    let declination = (eps.sin() * lambda.sin()).asin();
    let y = (eps / 2.0).tan().powi(2);
    let eot = y * (2.0 * l0).sin() - 2.0 * e * m.sin() + 4.0 * e * y * m.sin() * (2.0 * l0).cos()
        - 0.5 * y * y * (4.0 * l0).sin()
        - 1.25 * e * e * (2.0 * m).sin();
    Orbit { declination, eot_min: 4.0 * eot.to_degrees() }
}

pub fn sun_position(unix: f64, lat_deg: f64, lon_deg: f64) -> SunPosition {
    let o = orbit(unix);
    let minutes = unix.rem_euclid(86400.0) / 60.0;
    let solar_time = (minutes + o.eot_min + 4.0 * lon_deg).rem_euclid(1440.0);
    let hour_angle = (solar_time / 4.0 - 180.0).to_radians();
    let lat = lat_deg.to_radians();
    let cos_zenith = (lat.sin() * o.declination.sin() + lat.cos() * o.declination.cos() * hour_angle.cos()).clamp(-1.0, 1.0);
    let zenith = cos_zenith.acos();
    let denom = lat.cos() * zenith.sin();
    let azimuth_deg = if denom.abs() < 1e-9 {
        180.0
    } else {
        let a = (((lat.sin() * zenith.cos()) - o.declination.sin()) / denom).clamp(-1.0, 1.0).acos().to_degrees();
        if hour_angle > 0.0 {
            (a + 180.0).rem_euclid(360.0)
        } else {
            (540.0 - a).rem_euclid(360.0)
        }
    };
    SunPosition { azimuth_deg, altitude_deg: 90.0 - zenith.to_degrees() }
}

/// Unix time of local mean solar midnight at the start of the solar day containing `unix`.
pub fn solar_day_start(unix: f64, lon_deg: f64) -> f64 {
    let shift = lon_deg / 15.0 * 3600.0;
    ((unix + shift) / 86400.0).floor() * 86400.0 - shift
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::parse_rfc3339;

    const LAT: f64 = 57.6884;
    const LON: f64 = 11.9778;

    #[test]
    fn summer_solstice_noon_in_gothenburg() {
        // Solar noon is near 11:14 UTC; the sun is due south at 90 - lat + 23.44 degrees.
        let p = sun_position(parse_rfc3339("2026-06-21T11:14:00Z").unwrap(), LAT, LON);
        assert!((p.altitude_deg - 55.75).abs() < 0.1, "{p:?}");
        assert!((p.azimuth_deg - 180.0).abs() < 1.0, "{p:?}");
    }

    #[test]
    fn winter_solstice_noon_is_low() {
        let p = sun_position(parse_rfc3339("2026-12-21T11:10:00Z").unwrap(), LAT, LON);
        assert!((p.altitude_deg - 8.87).abs() < 0.15, "{p:?}");
    }

    #[test]
    fn equinox_sunrise_is_east() {
        // On the equinox the sun rises due east close to 06:00 local solar time.
        let p = sun_position(parse_rfc3339("2026-03-20T05:20:00Z").unwrap(), LAT, LON);
        assert!(p.altitude_deg.abs() < 1.5, "{p:?}");
        assert!((p.azimuth_deg - 90.0).abs() < 2.0, "{p:?}");
    }

    #[test]
    fn night_is_below_horizon() {
        let p = sun_position(parse_rfc3339("2026-12-21T23:00:00Z").unwrap(), LAT, LON);
        assert!(p.altitude_deg < -40.0);
    }

    #[test]
    fn solar_day_brackets_time() {
        let t = parse_rfc3339("2026-06-21T12:00:00Z").unwrap();
        let start = solar_day_start(t, LON);
        assert!(start <= t && t < start + 86400.0);
        // Midday of the solar day is close to true solar noon.
        let p = sun_position(start + 43200.0, LAT, LON);
        assert!((p.azimuth_deg - 180.0).abs() < 2.0, "{p:?}");
    }
}
