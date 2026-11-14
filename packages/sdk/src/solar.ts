/** Where the sun is in the sky. */
export interface SunPosition {
  /** Compass bearing, clockwise from north, degrees. */
  azimuth: number;
  /** Angle above the horizon, degrees. Negative at night. */
  altitude: number;
}

const RAD = Math.PI / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Sun position from the NOAA solar position equations, for drawing sun paths and legends.
 * It is the same algorithm as the engine's `solar.rs`; kernels remain the source of results.
 */
export function sunPosition(utcMs: number, lat: number, lon: number): SunPosition {
  const unix = utcMs / 1000;
  const jc = (unix / 86400 + 2440587.5 - 2451545) / 36525;
  const l0 = mod(280.46646 + jc * (36000.76983 + jc * 0.0003032), 360) * RAD;
  const m = (357.52911 + jc * (35999.05029 - 0.0001537 * jc)) * RAD;
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const c =
    Math.sin(m) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(2 * m) * (0.019993 - 0.000101 * jc) + Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * jc) * RAD;
  const lambda = (l0 / RAD + c - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD;
  const declination = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const eot =
    y * Math.sin(2 * l0) - 2 * e * Math.sin(m) + 4 * e * y * Math.sin(m) * Math.cos(2 * l0) - 0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * m);
  const eotMinutes = (4 * eot) / RAD;

  const minutes = mod(unix, 86400) / 60;
  const solarTime = mod(minutes + eotMinutes + 4 * lon, 1440);
  const hourAngle = (solarTime / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZenith = Math.min(1, Math.max(-1, Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle)));
  const zenith = Math.acos(cosZenith);
  const denom = Math.cos(phi) * Math.sin(zenith);
  let azimuth = 180;
  if (Math.abs(denom) >= 1e-9) {
    const a = Math.acos(Math.min(1, Math.max(-1, (Math.sin(phi) * Math.cos(zenith) - Math.sin(declination)) / denom))) / RAD;
    azimuth = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  return { azimuth, altitude: 90 - zenith / RAD };
}
