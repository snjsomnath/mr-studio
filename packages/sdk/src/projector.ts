// Projector calibration maths: the pinhole camera that makes a rendered twin land on the
// physical model. Pure functions, shared by the table surface, the calibration tool and
// later the phone lens. Image coordinates are pixels from the top left corner, y down.
// Model coordinates are the site's local frame: east, north, up, in metres.

export type Vec3 = [number, number, number];

export interface CalibrationPair {
  /** A corner of the model, in the local frame. */
  model: Vec3;
  /** Where the projector's marker had to be for its light to land on that corner. */
  image: [number, number];
  label?: string;
}

/** A projector's calibration, as stored under `projector` in calibration.json. */
export interface ProjectorCalibration {
  version: 1;
  /** The 3 x 4 projection, row by row: model metres to homogeneous image pixels. */
  matrix: number[];
  /** The image size the matrix was solved for. The view scales with the window. */
  image: { width: number; height: number };
  pairs: CalibrationPair[];
  /** Root mean square distance between where the markers were put and where the solved camera puts them. */
  error_px: number;
  /** The camera in plain terms, for people. Derived from `matrix`. */
  camera: ProjectorSummary;
  saved_at?: string;
}

export interface ProjectorSummary {
  position: Vec3;
  /** Compass bearing the projector points along, and how far below the horizon. */
  heading_deg: number;
  pitch_deg: number;
  fov_deg: { horizontal: number; vertical: number };
  /** How far the optical axis sits from the image centre, as a fraction of the image size. */
  lens_shift: { x: number; y: number };
  /** True when the image arrives mirrored, as through a single mirror. */
  mirrored: boolean;
}

export interface ProjectorCamera {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  skew: number;
  /** Rows take a model direction to camera axes: x right, y down, z forward. */
  rotation: [Vec3, Vec3, Vec3];
  translation: Vec3;
  /** The projector's lens, in the local frame. */
  position: Vec3;
  /** The image is flipped left to right after projection. `fx`, `cx` and `rotation` describe the unflipped image. */
  mirrored: boolean;
}

export const MIN_CALIBRATION_PAIRS = 6;

/** Where a model point lands in the image, and its depth along the optical axis (positive in front). */
export function projectPoint(matrix: number[], p: Vec3): [u: number, v: number, depth: number] {
  const m = matrix;
  const w = m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!;
  return [(m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!) / w, (m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!) / w, w];
}

function rms(matrix: number[], pairs: CalibrationPair[]): number {
  let sum = 0;
  for (const pair of pairs) {
    const [u, v] = projectPoint(matrix, pair.model);
    sum += (u - pair.image[0]) ** 2 + (v - pair.image[1]) ** 2;
  }
  return Math.sqrt(sum / pairs.length);
}

/**
 * Finds the projector from marker and model corner pairs. Needs at least six pairs that do
 * not all lie in one plane: mix roof corners with points on the ground.
 */
export function solveProjector(pairs: CalibrationPair[], image: { width: number; height: number }): { matrix: number[]; error_px: number } {
  if (pairs.length < MIN_CALIBRATION_PAIRS) throw new Error(`calibration needs at least ${MIN_CALIBRATION_PAIRS} markers, got ${pairs.length}`);
  const n = pairs.length;

  // Hartley normalisation: centre both point sets and bring them to unit scale, so the linear solve is well conditioned.
  const mean3 = [0, 1, 2].map((c) => pairs.reduce((s, p) => s + p.model[c]!, 0) / n);
  const mean2 = [0, 1].map((c) => pairs.reduce((s, p) => s + p.image[c]!, 0) / n);
  const spread3 = pairs.reduce((s, p) => s + Math.hypot(p.model[0] - mean3[0]!, p.model[1] - mean3[1]!, p.model[2] - mean3[2]!), 0) / n;
  const spread2 = pairs.reduce((s, p) => s + Math.hypot(p.image[0] - mean2[0]!, p.image[1] - mean2[1]!), 0) / n;
  if (!(spread3 > 0) || !(spread2 > 0)) throw new Error('the markers are all in one place');
  const s3 = Math.sqrt(3) / spread3;
  const s2 = Math.sqrt(2) / spread2;

  // Direct linear transform: each pair gives two equations in the twelve entries of the matrix.
  const ata = Array.from({ length: 12 }, () => new Array<number>(12).fill(0));
  const add = (row: number[]) => {
    for (let i = 0; i < 12; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < 12; j++) ata[i]![j]! += row[i]! * row[j]!;
    }
  };
  for (const pair of pairs) {
    const X = [(pair.model[0] - mean3[0]!) * s3, (pair.model[1] - mean3[1]!) * s3, (pair.model[2] - mean3[2]!) * s3, 1];
    const u = (pair.image[0] - mean2[0]!) * s2;
    const v = (pair.image[1] - mean2[1]!) * s2;
    add([...X, 0, 0, 0, 0, ...X.map((x) => -u * x)]);
    add([0, 0, 0, 0, ...X, ...X.map((x) => -v * x)]);
  }
  const { values, vectors } = symmetricEigen(ata);
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  // One null direction is the answer. A second one means the points cannot tell cameras apart.
  if (order[1]!.value < 1e-9 * order[11]!.value) {
    throw new Error('the markers all lie in one plane; add corners at different heights, such as roofs and ground');
  }
  const h = vectors.map((row) => row[order[0]!.index]!);

  // Undo the normalisation: P = T2^-1 * Pn * T3.
  const pn = [h.slice(0, 4), h.slice(4, 8), h.slice(8, 12)];
  const withT3 = pn.map((row) => [row[0]! * s3, row[1]! * s3, row[2]! * s3, row[3]! - s3 * (row[0]! * mean3[0]! + row[1]! * mean3[1]! + row[2]! * mean3[2]!)]);
  let matrix = [
    ...withT3[0]!.map((value, i) => value / s2 + mean2[0]! * withT3[2]![i]!),
    ...withT3[1]!.map((value, i) => value / s2 + mean2[1]! * withT3[2]![i]!),
    ...withT3[2]!,
  ];
  matrix = normalise(matrix, pairs);

  // Refine as a real lens: no skew, and the error measured in pixels rather than algebraically.
  const refined = refine(matrix, pairs, image);
  const error = rms(matrix, pairs);
  const refinedError = rms(refined, pairs);
  if (refinedError <= error * 1.5 + 0.05) return { matrix: refined, error_px: refinedError };
  return { matrix, error_px: error };
}

/** Scales the matrix so depth is in metres and the model is in front of the camera. */
function normalise(matrix: number[], pairs: CalibrationPair[]): number[] {
  const scale = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
  if (!(scale > 0)) throw new Error('calibration did not produce a camera');
  const front = pairs.reduce((count, pair) => count + (projectPoint(matrix, pair.model)[2] > 0 ? 1 : -1), 0);
  const k = (front >= 0 ? 1 : -1) / scale;
  return matrix.map((value) => value * k);
}

/** Splits the matrix into the lens (intrinsics) and where the projector is (pose). */
export function decomposeProjector(matrix: number[], image: { width: number; height: number }): ProjectorCamera {
  let m = normaliseScale(matrix);
  const det3 = (a: number[]) =>
    a[0]! * (a[5]! * a[10]! - a[6]! * a[9]!) - a[1]! * (a[4]! * a[10]! - a[6]! * a[8]!) + a[2]! * (a[4]! * a[9]! - a[5]! * a[8]!);
  // A mirrored image has a left-handed camera. Flip the image back, solve a proper camera, and remember the flip.
  const mirrored = det3(m) < 0;
  if (mirrored) m = [0, 1, 2, 3].map((i) => image.width * m[8 + i]! - m[i]!).concat(m.slice(4));
  const row = (r: number): Vec3 => [m[r * 4]!, m[r * 4 + 1]!, m[r * 4 + 2]!];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const combine = (a: Vec3, ka: number, b: Vec3, kb: number): Vec3 => [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb];
  const [m1, m2, r3] = [row(0), row(1), row(2)];
  // The rows of K * R, peeled from the bottom: the optical axis first, then down, then right.
  const cy = dot(m2, r3);
  const down = combine(m2, 1, r3, -cy);
  const fy = Math.hypot(...down);
  const r2 = combine(down, 1 / fy, r3, 0);
  const cx = dot(m1, r3);
  const skew = dot(m1, r2);
  const right = combine(combine(m1, 1, r3, -cx), 1, r2, -skew);
  const fx = Math.hypot(...right);
  const r1 = combine(right, 1 / fx, r3, 0);
  // t = K^-1 * p4, by back substitution.
  const tz = m[11]!;
  const ty = (m[7]! - cy * tz) / fy;
  const tx = (m[3]! - skew * ty - cx * tz) / fx;
  const translation: Vec3 = [tx, ty, tz];
  const position: Vec3 = [
    -(r1[0] * tx + r2[0] * ty + r3[0] * tz),
    -(r1[1] * tx + r2[1] * ty + r3[1] * tz),
    -(r1[2] * tx + r2[2] * ty + r3[2] * tz),
  ];
  return { fx, fy, cx, cy, skew, rotation: [r1, r2, r3], translation, position, mirrored };
}

function normaliseScale(matrix: number[]): number[] {
  const scale = Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!);
  return matrix.map((value) => value / scale);
}

/** The matrix of a camera, the inverse of `decomposeProjector`. */
export function composeProjector(camera: ProjectorCamera, image: { width: number; height: number }): number[] {
  const { fx, fy, cx, cy, skew, rotation: [r1, r2, r3], translation: t } = camera;
  const rows = [
    [0, 1, 2].map((i) => fx * r1[i]! + skew * r2[i]! + cx * r3[i]!).concat(fx * t[0] + skew * t[1] + cx * t[2]),
    [0, 1, 2].map((i) => fy * r2[i]! + cy * r3[i]!).concat(fy * t[1] + cy * t[2]),
    [...r3, t[2]],
  ];
  if (camera.mirrored) rows[0] = rows[0]!.map((value, i) => image.width * rows[2]![i]! - value);
  return rows.flat();
}

/** The camera in the terms a person setting up a projector thinks in. */
export function describeProjector(matrix: number[], image: { width: number; height: number }): ProjectorSummary {
  const camera = decomposeProjector(matrix, image);
  const forward = camera.rotation[2];
  const deg = 180 / Math.PI;
  const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    position: camera.position.map((v) => round(v, 2)) as Vec3,
    heading_deg: round((Math.atan2(forward[0], forward[1]) * deg + 360) % 360, 1),
    pitch_deg: round(Math.asin(Math.max(-1, Math.min(1, -forward[2]))) * deg, 1),
    fov_deg: {
      horizontal: round(2 * Math.atan(image.width / (2 * camera.fx)) * deg, 1),
      vertical: round(2 * Math.atan(image.height / (2 * camera.fy)) * deg, 1),
    },
    lens_shift: { x: round(camera.cx / image.width - 0.5, 3), y: round(camera.cy / image.height - 0.5, 3) },
    mirrored: camera.mirrored,
  };
}

/**
 * The camera as the two matrices a WebGL renderer wants, both column-major:
 * `view` takes the local frame to eye space (x right, y up, looking along -z), and
 * `projection` takes eye space to clip space. A mirrored camera renders unmirrored;
 * flip the finished image left to right.
 */
export function projectorMatrices(camera: ProjectorCamera, image: { width: number; height: number }, near: number, far: number): { view: number[]; projection: number[] } {
  const { fx, fy, cx, cy, skew, rotation: [r1, r2, r3], translation: t } = camera;
  const { width: w, height: h } = image;
  // Eye space flips the camera's y and z.
  const view = [r1[0], -r2[0], -r3[0], 0, r1[1], -r2[1], -r3[1], 0, r1[2], -r2[2], -r3[2], 0, t[0], -t[1], -t[2], 1];
  const projection = [
    (2 * fx) / w, 0, 0, 0,
    (-2 * skew) / w, (2 * fy) / h, 0, 0,
    1 - (2 * cx) / w, (2 * cy) / h - 1, -(far + near) / (far - near), -1,
    0, 0, (-2 * far * near) / (far - near), 0,
  ];
  return { view, projection };
}

// ---- Refinement -----------------------------------------------------------

/** Rotates the camera by a small rotation vector, given in camera axes. */
function rotate(rotation: [Vec3, Vec3, Vec3], w: Vec3): [Vec3, Vec3, Vec3] {
  const angle = Math.hypot(...w);
  if (angle < 1e-15) return rotation;
  const [x, y, z] = [w[0] / angle, w[1] / angle, w[2] / angle];
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const k = 1 - c;
  const delta = [
    [c + x * x * k, x * y * k - z * s, x * z * k + y * s],
    [y * x * k + z * s, c + y * y * k, y * z * k - x * s],
    [z * x * k - y * s, z * y * k + x * s, c + z * z * k],
  ];
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => delta[i]![0]! * rotation[0][j]! + delta[i]![1]! * rotation[1][j]! + delta[i]![2]! * rotation[2][j]!)) as [Vec3, Vec3, Vec3];
}

/** Levenberg-Marquardt over focal lengths, optical centre, rotation and position, with no skew. */
function refine(matrix: number[], pairs: CalibrationPair[], image: { width: number; height: number }): number[] {
  let camera: ProjectorCamera = { ...decomposeProjector(matrix, image), skew: 0 };
  const scale = Math.max(1, Math.hypot(...camera.translation));
  const steps = [camera.fx * 1e-4, camera.fy * 1e-4, image.width * 1e-4, image.height * 1e-4, 1e-5, 1e-5, 1e-5, scale * 1e-5, scale * 1e-5, scale * 1e-5];
  const moved = (from: ProjectorCamera, d: number[]): ProjectorCamera => ({
    ...from,
    fx: from.fx + d[0]!,
    fy: from.fy + d[1]!,
    cx: from.cx + d[2]!,
    cy: from.cy + d[3]!,
    rotation: rotate(from.rotation, [d[4]!, d[5]!, d[6]!]),
    translation: [from.translation[0] + d[7]!, from.translation[1] + d[8]!, from.translation[2] + d[9]!],
  });
  const residuals = (c: ProjectorCamera): number[] => {
    const m = composeProjector(c, image);
    return pairs.flatMap((pair) => {
      const [u, v] = projectPoint(m, pair.model);
      return [u - pair.image[0], v - pair.image[1]];
    });
  };
  const cost = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

  let current = residuals(camera);
  let lambda = 1e-3;
  for (let iteration = 0; iteration < 60; iteration++) {
    const jacobian = steps.map((step, i) => {
      const d = new Array<number>(10).fill(0);
      d[i] = step;
      const shifted = residuals(moved(camera, d));
      return shifted.map((value, k) => (value - current[k]!) / step);
    });
    const jtj = jacobian.map((a) => jacobian.map((b) => a.reduce((s, value, k) => s + value * b[k]!, 0)));
    const jtr = jacobian.map((a) => a.reduce((s, value, k) => s + value * current[k]!, 0));
    let improved = false;
    for (let attempt = 0; attempt < 8 && !improved; attempt++) {
      const damped = jtj.map((row, i) => row.map((value, j) => (i === j ? value * (1 + lambda) + 1e-12 : value)));
      const delta = solveLinear(damped, jtr.map((value) => -value));
      if (!delta) break;
      const candidate = moved(camera, delta);
      const next = residuals(candidate);
      if (candidate.fx > 0 && candidate.fy > 0 && next.every(Number.isFinite) && cost(next) < cost(current)) {
        const gain = cost(current) - cost(next);
        camera = candidate;
        current = next;
        lambda = Math.max(1e-9, lambda / 4);
        improved = true;
        if (gain < 1e-12) return composeProjector(camera, image);
      } else {
        lambda *= 6;
      }
    }
    if (!improved) break;
  }
  return composeProjector(camera, image);
}

// ---- Small linear algebra -------------------------------------------------

/** Solves A x = b by elimination with partial pivoting. Null when A is singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    if (Math.abs(m[pivot]![col]!) < 1e-300) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let row = col + 1; row < n; row++) {
      const f = m[row]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k++) m[row]![k]! -= f * m[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row]![n]!;
    for (let k = row + 1; k < n; k++) sum -= m[row]![k]! * x[k]!;
    x[row] = sum / m[row]![row]!;
  }
  return x;
}

/** Eigenvalues and eigenvectors (as columns) of a symmetric matrix, by cyclic Jacobi rotations. */
function symmetricEigen(input: number[][]): { values: number[]; vectors: number[][] } {
  const n = input.length;
  const a = input.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p]![q]!) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const [akp, akq] = [a[k]![p]!, a[k]![q]!];
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const [apk, aqk] = [a[p]![k]!, a[q]![k]!];
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const [vkp, vkq] = [v[k]![p]!, v[k]![q]!];
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]!), vectors: v };
}
