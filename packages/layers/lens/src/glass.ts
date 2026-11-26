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
  // A glass with no size (its layer hidden, or the table not laid out yet) draws nothing (#553).
  if (!(look.radius > 0) || !Number.isFinite(look.radius) || !Number.isFinite(x) || !Number.isFinite(y)) return;
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
  // The faint ring inside, while the glass is large enough to have an inside (#553).
  if (r > 3 * line) {
    g.lineWidth = 0.75 * line;
    g.strokeStyle = 'rgb(255 226 170 / 0.16)';
    g.beginPath();
    g.arc(x, y, r - 3 * line, 0, Math.PI * 2);
    g.stroke();
  }
}
