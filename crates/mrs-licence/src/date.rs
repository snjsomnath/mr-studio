//! Calendar days, enough for licence dates: `YYYY-MM-DD` strings and whole days between them.
//! Dates are UTC days; a licence that ends "on 2027-06-30" is good through that day.

use std::time::{SystemTime, UNIX_EPOCH};

/// A day as the number of days since 1970-01-01.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Day(pub i64);

impl Day {
    pub fn today() -> Self {
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        Day(secs.div_euclid(86_400))
    }

    /// Reads `YYYY-MM-DD`.
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.trim().splitn(3, '-');
        let y: i64 = parts.next()?.parse().ok()?;
        let m: i64 = parts.next()?.parse().ok()?;
        let d: i64 = parts.next()?.parse().ok()?;
        if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) || !(1970..=9999).contains(&y) {
            return None;
        }
        Some(Day(days_from_civil(y, m, d)))
    }

    pub fn plus(self, days: i64) -> Self {
        Day(self.0 + days)
    }

    /// Whole days from `self` to `later` (negative when `later` is earlier).
    pub fn until(self, later: Day) -> i64 {
        later.0 - self.0
    }
}

impl std::fmt::Display for Day {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (y, m, d) = civil_from_days(self.0);
        write!(f, "{y:04}-{m:02}-{d:02}")
    }
}

fn leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// Howard Hinnant's civil calendar algorithms.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for text in ["1970-01-01", "2000-02-29", "2026-11-28", "2030-12-31"] {
            assert_eq!(Day::parse(text).unwrap().to_string(), text);
        }
        assert_eq!(Day::parse("1970-01-01"), Some(Day(0)));
        assert_eq!(Day::parse("2026-02-29"), None);
        assert_eq!(Day::parse("2026-13-01"), None);
        assert_eq!(Day::parse("soon"), None);
        assert_eq!(Day::parse("2026-11-28").unwrap().until(Day::parse("2027-02-26").unwrap()), 90);
    }
}
