// How the glass looks on the table, as the Lindholmen artwork's magnifier drew it: the table
// quietened around it, a warm halo that breathes, a fine rim with a highlight along its top left
// and a faint ring just inside. In CSS pixels on a canvas over the table.

export interface GlassLook {
  centre: [number, number];
  radius: number;
  /** The canvas's size, for the dimming around the glass. */
  width: number;
  height: number;
  /** 0 to 1: how dark the table goes around the glass. */
  dim: number;
  pinned: boolean;
  /** Seconds, for the halo's breath. */
  time: number;
  /** 0 to 1: how far the glass has arrived (it fades in over half a second). */
  arrival: number;
  /** Pixels per CSS pixel of line: thin on the table, as the old rim was one pixel wide. */
  line: number;
  /** Draws what the glass shows, already clipped to it. Null leaves the inside to what is under it. */
  inside: ((g: CanvasRenderingContext2D) => void) | null;
}

export function drawGlass(g: CanvasRenderingContext2D, look: GlassLook): void {
  const [x, y] = look.centre;
  const r = Math.max(2, look.radius);
  const a = Math.max(0, Math.min(1, look.arrival));
  const breath = 0.88 + 0.12 * Math.sin((look.time * Math.PI) / 4);
  const line = look.line;

  // Quiet the whole table outside the glass.
  if (look.dim > 0) {
    g.save();
    g.fillStyle = `rgb(0 0 0 / ${look.dim * a})`;
    g.beginPath();
    g.rect(0, 0, look.width, look.height);
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill('evenodd');
    g.restore();
  }

  if (look.inside) {
    g.save();
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.clip();
    look.inside(g);
    g.restore();
  }

  // The warm halo, from just inside the rim outwards.
  const halo = g.createRadialGradient(x, y, r * 0.82, x, y, r * 1.65);
  halo.addColorStop(0, 'rgb(255 213 143 / 0)');
  halo.addColorStop(0.23, `rgb(255 222 166 / ${0.18 * breath * a})`);
  halo.addColorStop(0.5, `rgb(235 191 114 / ${0.065 * a})`);
  halo.addColorStop(1, 'rgb(235 191 114 / 0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(x, y, r * 1.65, 0, Math.PI * 2);
  g.fill();

  // The rim, brighter when pinned; a highlight along its top left; a faint ring inside.
  g.lineWidth = line;
  g.strokeStyle = look.pinned ? 'rgb(255 223 167 / 0.9)' : 'rgb(255 241 210 / 0.7)';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2 * line;
  g.strokeStyle = `rgb(255 251 233 / ${0.6 * breath})`;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(x, y, r + 2 * line, Math.PI * 1.1, Math.PI * 1.65);
  g.stroke();
  g.lineWidth = 0.75 * line;
  g.strokeStyle = 'rgb(255 226 170 / 0.16)';
  g.beginPath();
  // Never a negative radius: a glass shrinking to nothing as its slide ends (#553).
  g.arc(x, y, Math.max(0, r - 3 * line), 0, Math.PI * 2);
  g.stroke();
}

export interface HoleLook extends Omit<GlassLook, 'pinned' | 'inside'> {
  /** Unit vector, in canvas pixels, from the hole's centre towards where visitors stand (table.front). */
  front: [number, number];
}

/**
 * The X-ray as a hole cut in the table (#554), top-down and text-free: the layers inside sit
 * lower and cooler, the walls darken towards the rim, the near rim throws shade across the
 * hole's front, the far wall catches a little light and the far lip shines. No halo outside:
 * the table around stays as it is, unless `dim` asks for it.
 */
export function drawHole(g: CanvasRenderingContext2D, look: HoleLook): void {
  const [x, y] = look.centre;
  const r = Math.max(2, look.radius);
  const a = Math.max(0, Math.min(1, look.arrival));
  const line = look.line;
  const len = Math.hypot(look.front[0], look.front[1]) || 1;
  const fx = look.front[0] / len;
  const fy = look.front[1] / len;

  if (look.dim > 0) {
    g.save();
    g.fillStyle = `rgb(0 0 0 / ${look.dim * a})`;
    g.beginPath();
    g.rect(0, 0, look.width, look.height);
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill('evenodd');
    g.restore();
  }

  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.clip();

  // Lower down, so a little cooler and darker.
  g.fillStyle = `rgb(6 12 26 / ${0.2 * a})`;
  g.fillRect(x - r, y - r, 2 * r, 2 * r);

  // The walls: dark at the rim, open in the middle, the opening shifted away from the viewer.
  const wall = g.createRadialGradient(x - fx * r * 0.15, y - fy * r * 0.15, r * 0.35, x, y, r);
  wall.addColorStop(0, 'rgb(0 0 0 / 0)');
  wall.addColorStop(0.55, `rgb(0 0 0 / ${0.25 * a})`);
  wall.addColorStop(0.85, `rgb(0 0 0 / ${0.75 * a})`);
  wall.addColorStop(1, `rgb(0 0 0 / ${0.97 * a})`);
  g.fillStyle = wall;
  g.fillRect(x - r, y - r, 2 * r, 2 * r);

  // The near rim's shade across the front of the hole: a crescent, blurred with a shadow drawn
  // from a shape kept off the canvas, so it works where canvas filters do not (WebKit).
  const depth = r * 0.38;
  const away = 4 * r + look.width + look.height;
  g.save();
  g.shadowColor = `rgb(0 0 0 / ${a})`;
  g.shadowBlur = r * 0.14;
  g.shadowOffsetX = away;
  g.shadowOffsetY = 0;
  g.fillStyle = 'rgb(0 0 0)';
  g.beginPath();
  g.rect(x - 2 * r - away, y - 2 * r, 4 * r, 4 * r);
  g.arc(x - away - fx * depth, y - fy * depth, r, 0, Math.PI * 2);
  g.fill('evenodd');
  g.restore();

  // The far wall, catching a little light from above.
  const lit = g.createLinearGradient(x - fx * r, y - fy * r, x - fx * (r - depth), y - fy * (r - depth));
  lit.addColorStop(0, `rgb(200 215 240 / ${0.22 * a})`);
  lit.addColorStop(1, 'rgb(200 215 240 / 0)');
  g.fillStyle = lit;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.arc(x + fx * depth * 0.6, y + fy * depth * 0.6, r, 0, Math.PI * 2, true);
  g.fill('evenodd');
  g.restore();

  // The cut edge: a crisp dark rim, the far lip shining, the near lip barely there.
  const back = Math.atan2(-fy, -fx);
  g.save();
  g.lineCap = 'round';
  g.lineWidth = 2 * line;
  g.strokeStyle = `rgb(0 0 0 / ${0.9 * a})`;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 1.5 * line;
  g.strokeStyle = `rgb(225 235 250 / ${0.6 * a})`;
  g.beginPath();
  g.arc(x, y, r + line, back - 1.1, back + 1.1);
  g.stroke();
  g.lineWidth = line;
  g.strokeStyle = `rgb(225 235 250 / ${0.14 * a})`;
  g.beginPath();
  g.arc(x, y, r + line, back + Math.PI - 0.8, back + Math.PI + 0.8);
  g.stroke();
  g.restore();
}
