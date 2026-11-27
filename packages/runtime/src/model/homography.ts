/**
 * The 3 x 3 projective map that takes four points to four others (row major, last entry 1),
 * or null when the points are degenerate.
 */
export function homography(from: [number, number][], to: [number, number][]): number[] | null {
  // Eight equations in the eight unknowns h0..h7, solved by Gaussian elimination.
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!;
    const [u, v] = to[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = r;
    if (Math.abs(rows[pivot]![col]!) < 1e-12) return null;
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const row = rows[r]!;
      const base = rows[col]!;
      const f = row[col]! / base[col]!;
      if (f === 0) continue;
      for (let c = col; c < 9; c++) row[c] = row[c]! - f * base[c]!;
    }
  }
  return [...rows.map((row, i) => row[8]! / row[i]!), 1];
}

/** A row-major 3 x 3 homography as a CSS `matrix3d`, for an element with its transform origin at its top left. */
export function cssMatrix(h: number[]): string {
  const [a, b, c, d, e, f, g, k] = h as [number, number, number, number, number, number, number, number];
  // Column-major 4 x 4, z passed through.
  return `matrix3d(${[a, d, 0, g, b, e, 0, k, 0, 0, 1, 0, c, f, 0, h[8]!].join(',')})`;
}
