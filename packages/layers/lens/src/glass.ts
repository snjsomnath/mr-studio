// How the glass looks on the table, after the Lindholmen artwork's magnifier: the table quietened
// around it, a warm halo that breathes, a fine rim with a highlight, and a soft shade at the edge
// inside, so the glass reads as a lens and not a hole. In CSS pixels on a canvas over the table.

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
  /** Draws what the glass shows, already clipped to it. Null leaves the inside to what is under it. */
  inside: ((g: CanvasRenderingContext2D) => void) | null;
}

export function drawGlass(g: CanvasRenderingContext2D, look: GlassLook): void {
  const [x, y] = look.centre;
  const r = Math.max(2, look.radius);
  const breath = 0.88 + 0.12 * Math.sin((look.time * Math.PI) / 2);

  // Quiet the table outside the glass.
  if (look.dim > 0) {
    g.save();
    g.fillStyle = `rgb(0 0 0 / ${look.dim})`;
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

  // A soft shade just inside the rim.
  const shade = g.createRadialGradient(x, y, r * 0.78, x, y, r);
  shade.addColorStop(0, 'rgb(0 0 0 / 0)');
  shade.addColorStop(1, 'rgb(0 0 0 / 0.38)');
  g.fillStyle = shade;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();

  // The warm halo outside.
  const halo = g.createRadialGradient(x, y, r * 0.98, x, y, r * 1.6);
  halo.addColorStop(0, `rgb(255 222 166 / ${0.22 * breath})`);
  halo.addColorStop(0.35, 'rgb(235 191 114 / 0.07)');
  halo.addColorStop(1, 'rgb(235 191 114 / 0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(x, y, r * 1.6, 0, Math.PI * 2);
  g.arc(x, y, r, 0, Math.PI * 2, true);
  g.fill();

  // The rim, brighter when pinned, and a highlight along its top left.
  const line = Math.max(1, r / 120);
  g.lineWidth = 1.5 * line;
  g.strokeStyle = look.pinned ? 'rgb(255 223 167 / 0.95)' : 'rgb(255 241 210 / 0.75)';
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 3 * line;
  g.strokeStyle = `rgb(255 251 233 / ${0.6 * breath})`;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(x, y, r + 2.5 * line, Math.PI * 1.1, Math.PI * 1.62);
  g.stroke();
  g.lineWidth = line;
  g.strokeStyle = 'rgb(255 226 170 / 0.18)';
  g.beginPath();
  g.arc(x, y, r - 4 * line, 0, Math.PI * 2);
  g.stroke();
}
