//! Minimal UTC time handling, so the engine needs no date library.

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parses an RFC 3339 timestamp (`2026-06-21T12:00:00Z`, with optional seconds,
/// fraction and offset) to Unix seconds.
pub fn parse_rfc3339(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't' && b[10] != b' ') || b[13] != b':' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<u32>().ok();
    let (year, month, day) = (num(0, 4)? as i64, num(5, 7)?, num(8, 10)?);
    let (hour, minute) = (num(11, 13)?, num(14, 16)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let mut i = 16;
    let mut seconds = 0.0;
    if b.get(i) == Some(&b':') {
        let start = i + 1;
        i = start;
        while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
            i += 1;
        }
        seconds = s.get(start..i)?.parse::<f64>().ok()?;
    }
    let offset = match b.get(i) {
        None => 0,
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if i + 6 == b.len() && b[i + 3] == b':' => {
            let minutes = (num(i + 1, i + 3)? * 60 + num(i + 4, i + 6)?) as i64 * 60;
            if *sign == b'+' {
                minutes
            } else {
                -minutes
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    Some((days * 86400 + hour as i64 * 3600 + minute as i64 * 60 - offset) as f64 + seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(parse_rfc3339("2026-06-21T12:00:00Z"), Some(1782043200.0));
        assert_eq!(parse_rfc3339("2026-06-21T14:00+02:00"), Some(1782043200.0));
        assert_eq!(parse_rfc3339("2026-06-21T12:00:30.5Z"), Some(1782043230.5));
        assert_eq!(parse_rfc3339("yesterday"), None);
        assert_eq!(parse_rfc3339("2026-13-01T00:00:00Z"), None);
    }
}
