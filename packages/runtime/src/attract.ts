// The controller's home screen (#74): while no layer is open it loops through the layers on
// the rails, a few seconds each, showing the site's title, the layer's name and what it does,
// over a moving background that suggests the layer (wind, rain, the sun…). The idea and the
// effects come from the Chalmers campus demo's welcome tour. Nothing on the rails lights up,
// so the loop never looks like a layer someone opened.

import { t } from './i18n.ts';

/** The backgrounds a layer can ask for in `attract.effect` (docs/contracts/present.md, Button). */
export const ATTRACT_EFFECTS = ['wind', 'rain', 'sun', 'sightlines', 'grid', 'waves', 'particles', 'default'] as const;
export type AttractEffect = (typeof ATTRACT_EFFECTS)[number];

export interface AttractStop {
  id: string;
  name: string;
  description: string;
  effect: AttractEffect;
}

type Painter = (g: CanvasRenderingContext2D, w: number, h: number, dt: number, colour: string) => void;

/** A painter per effect. Each keeps its own state and draws one frame. */
function painter(effect: AttractEffect): Painter {
  const random = Math.random;
  switch (effect) {
    case 'wind': {
      const streaks = Array.from({ length: 70 }, () => ({ x: random(), y: random(), v: 0.15 + random() * 0.35, l: 0.04 + random() * 0.09, w: 1 + random() * 2.5 }));
      return (g, w, h, dt, c) => {
        for (const s of streaks) {
          s.x += s.v * dt;
          if (s.x - s.l > 1) Object.assign(s, { x: -random() * 0.2, y: random() });
          const [x, y, l] = [s.x * w, s.y * h + Math.sin(s.x * 6 + s.y * 9) * h * 0.02, s.l * w];
          const grad = g.createLinearGradient(x - l, y, x, y);
          grad.addColorStop(0, 'transparent');
          grad.addColorStop(1, c);
          g.strokeStyle = grad;
          g.lineWidth = s.w;
          g.beginPath();
          g.moveTo(x - l, y);
          g.lineTo(x, y);
          g.stroke();
        }
      };
    }
    case 'rain': {
      const drops = Array.from({ length: 110 }, () => ({ x: random(), y: random(), v: 0.6 + random() * 0.7, l: 0.02 + random() * 0.03 }));
      return (g, w, h, dt, c) => {
        g.strokeStyle = c;
        g.lineCap = 'round';
        for (const d of drops) {
          d.y += d.v * dt;
          d.x += d.v * dt * 0.08;
          if (d.y > 1.05) Object.assign(d, { y: -0.05, x: random() });
          g.globalAlpha = 0.35 + d.v * 0.3;
          g.lineWidth = 1.5;
          g.beginPath();
          g.moveTo(d.x * w, d.y * h);
          g.lineTo(d.x * w + d.l * h * 0.15, d.y * h + d.l * h * 2);
          g.stroke();
        }
        g.globalAlpha = 1;
      };
    }
    case 'sun': {
      let t = 0.1;
      return (g, w, h, dt, c) => {
        t = (t + dt * 0.06) % 1;
        const angle = Math.PI * (1 - t);
        const [x, y] = [w / 2 + Math.cos(angle) * w * 0.38, h * 0.92 - Math.sin(angle) * h * 0.72];
        const glow = g.createRadialGradient(x, y, 0, x, y, h * 0.6);
        glow.addColorStop(0, 'rgba(255, 220, 140, 0.55)');
        glow.addColorStop(0.25, 'rgba(255, 200, 110, 0.18)');
        glow.addColorStop(1, 'transparent');
        g.fillStyle = glow;
        g.fillRect(0, 0, w, h);
        g.strokeStyle = c;
        g.globalAlpha = 0.35;
        g.setLineDash([2, 10]);
        g.beginPath();
        g.ellipse(w / 2, h * 0.92, w * 0.38, h * 0.72, 0, Math.PI, 2 * Math.PI);
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 1;
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 + t * 4;
          g.strokeStyle = 'rgba(255, 230, 160, 0.5)';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(x + Math.cos(a) * h * 0.09, y + Math.sin(a) * h * 0.09);
          g.lineTo(x + Math.cos(a) * h * 0.13, y + Math.sin(a) * h * 0.13);
          g.stroke();
        }
        g.fillStyle = '#ffe9a8';
        g.beginPath();
        g.arc(x, y, h * 0.065, 0, Math.PI * 2);
        g.fill();
      };
    }
    case 'sightlines': {
      const eyes = Array.from({ length: 4 }, () => ({ x: random(), y: random(), vx: (random() - 0.5) * 0.08, vy: (random() - 0.5) * 0.08, a: random() * Math.PI * 2 }));
      return (g, w, h, dt, c) => {
        for (const e of eyes) {
          e.x += e.vx * dt;
          e.y += e.vy * dt;
          e.a += dt * 0.4;
          if (e.x < 0.05 || e.x > 0.95) e.vx *= -1;
          if (e.y < 0.05 || e.y > 0.95) e.vy *= -1;
          const [x, y] = [e.x * w, e.y * h];
          // A fan of rays, as a view cut short by buildings.
          g.fillStyle = c;
          g.globalAlpha = 0.12;
          g.beginPath();
          g.moveTo(x, y);
          for (let i = 0; i <= 48; i++) {
            const a = e.a + (i / 48) * Math.PI * 2;
            const r = h * (0.18 + 0.14 * Math.abs(Math.sin(a * 3 + e.x * 7)));
            g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
          }
          g.fill();
          g.globalAlpha = 1;
          g.beginPath();
          g.arc(x, y, 5, 0, Math.PI * 2);
          g.fill();
        }
      };
    }
    case 'grid': {
      let t = 0;
      return (g, w, h, dt, c) => {
        t += dt;
        const size = h / 8;
        const shift = (t * 12) % size;
        g.strokeStyle = c;
        g.globalAlpha = 0.18;
        g.lineWidth = 1;
        for (let x = -size + shift; x < w + size; x += size) {
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x, h);
          g.stroke();
        }
        for (let y = -size + shift; y < h + size; y += size) {
          g.beginPath();
          g.moveTo(0, y);
          g.lineTo(w, y);
          g.stroke();
        }
        // A few cells light up and fade, as a map revealed part by part.
        g.fillStyle = c;
        for (let i = 0; i < 14; i++) {
          const k = Math.sin(t * 0.7 + i * 2.3);
          if (k < 0.4) continue;
          const col = Math.floor(((i * 7919) % 97) / 97 * (w / size + 1));
          const row = Math.floor(((i * 104729) % 89) / 89 * (h / size + 1));
          g.globalAlpha = (k - 0.4) * 0.35;
          g.fillRect(col * size - size + shift, row * size - size + shift, size, size);
        }
        g.globalAlpha = 1;
      };
    }
    case 'waves': {
      let t = 0;
      return (g, w, h, dt, c) => {
        t += dt;
        g.strokeStyle = c;
        for (let i = 0; i < 6; i++) {
          g.globalAlpha = 0.15 + i * 0.07;
          g.lineWidth = 2 + i * 0.4;
          g.beginPath();
          for (let x = 0; x <= w; x += 8) {
            const y = h * (0.3 + i * 0.1) + Math.sin(x * 0.006 + t * (0.6 + i * 0.15) + i) * h * 0.06;
            if (x === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
        g.globalAlpha = 1;
      };
    }
    case 'particles':
    case 'default': {
      const linked = effect === 'particles';
      const dots = Array.from({ length: linked ? 60 : 40 }, () => ({ x: random(), y: random(), vx: (random() - 0.5) * 0.05, vy: (random() - 0.5) * 0.05, r: 1.5 + random() * 2.5 }));
      return (g, w, h, dt, c) => {
        g.fillStyle = c;
        g.strokeStyle = c;
        for (const d of dots) {
          d.x = (d.x + d.vx * dt + 1) % 1;
          d.y = (d.y + d.vy * dt + 1) % 1;
          g.globalAlpha = linked ? 0.8 : 0.45;
          g.beginPath();
          g.arc(d.x * w, d.y * h, d.r, 0, Math.PI * 2);
          g.fill();
        }
        if (linked) {
          g.lineWidth = 1;
          for (let i = 0; i < dots.length; i++) {
            for (let j = i + 1; j < dots.length; j++) {
              const [a, b] = [dots[i]!, dots[j]!];
              const d = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
              if (d > h * 0.22) continue;
              g.globalAlpha = 0.35 * (1 - d / (h * 0.22));
              g.beginPath();
              g.moveTo(a.x * w, a.y * h);
              g.lineTo(b.x * w, b.y * h);
              g.stroke();
            }
          }
        }
        g.globalAlpha = 1;
      };
    }
  }
}

/**
 * The attract loop. `stops()` gives the layers to show, in rail order, each time the loop
 * moves on, so a button added or renamed in the editor joins at once.
 */
export class AttractLoop {
  readonly element: HTMLElement;
  private readonly canvas = document.createElement('canvas');
  private readonly name = document.createElement('h3');
  private readonly line = document.createElement('p');
  private readonly tour = document.createElement('div');
  private paint: Painter = painter('default');
  private effect: AttractEffect | null = null;
  private index = -1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private last = 0;
  private running = false;
  private readonly stops: () => AttractStop[];
  private readonly stepS: number;

  constructor(title: string, stops: () => AttractStop[], options: { stepS?: number; credits?: string; welcome?: string } = {}) {
    this.stops = stops;
    this.stepS = options.stepS ?? 4;
    this.element = document.createElement('div');
    this.element.className = 'layer-welcome attract';
    this.canvas.className = 'attract-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    const words = document.createElement('div');
    words.className = 'attract-words';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const hint = document.createElement('p');
    hint.className = 'attract-hint';
    hint.textContent = options.welcome ?? t('Choose a layer to bring it to the table.');
    this.tour.className = 'attract-tour';
    this.tour.setAttribute('aria-live', 'polite');
    this.name.className = 'attract-name';
    this.line.className = 'attract-line';
    this.tour.append(this.name, this.line);
    words.append(heading, hint, this.tour);
    this.element.append(this.canvas, words);
    if (options.credits) {
      const credits = document.createElement('p');
      credits.className = 'attract-credits';
      credits.textContent = options.credits;
      this.element.append(credits);
    }
  }

  /** Starts or stops the loop, as the home screen shows or hides. */
  set active(on: boolean) {
    if (on === this.running) return;
    this.running = on;
    if (on) {
      this.index = -1;
      this.next();
      this.timer = setInterval(() => this.next(), this.stepS * 1000);
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.draw);
    } else {
      clearInterval(this.timer);
      cancelAnimationFrame(this.frame);
    }
  }

  private next(): void {
    const stops = this.stops();
    this.tour.hidden = stops.length === 0;
    if (stops.length === 0) {
      this.use('default');
      return;
    }
    this.index = (this.index + 1) % stops.length;
    const stop = stops[this.index]!;
    // The words fade out, then the words and the background change together.
    const show = () => {
      this.element.dataset.layer = stop.id;
      this.name.textContent = stop.name;
      this.line.textContent = stop.description;
      this.line.hidden = !stop.description;
      this.use(stop.effect);
      this.tour.classList.remove('is-changing');
    };
    // The first layer shows at once; after that the words fade out before they change.
    if (!this.element.dataset.layer) return show();
    this.tour.classList.add('is-changing');
    setTimeout(show, 300);
  }

  private use(effect: AttractEffect): void {
    if (effect === this.effect) return;
    this.effect = effect;
    this.element.dataset.effect = effect;
    this.paint = painter(effect);
  }

  private draw = (now: number): void => {
    if (!this.running) return;
    this.frame = requestAnimationFrame(this.draw);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w === 0 || h === 0) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * ratio) || this.canvas.height !== Math.round(h * ratio)) {
      this.canvas.width = Math.round(w * ratio);
      this.canvas.height = Math.round(h * ratio);
    }
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const colour = getComputedStyle(this.element).getPropertyValue('--accent').trim() || '#ffc857';
    this.paint(g, w, h, dt, colour);
  };
}

/** The effect a layer gets when its manifest names none: by its category. */
export function defaultEffect(category: string | undefined): AttractEffect {
  return category === 'analysis' || category === 'media' ? 'grid' : 'default';
}

/** The effect a manifest asks for, if it is one the controller knows. */
export function effectOf(manifest: { attract?: { effect: string }; category?: string } | undefined): AttractEffect {
  const asked = manifest?.attract?.effect;
  return (ATTRACT_EFFECTS as readonly string[]).includes(asked ?? '') ? (asked as AttractEffect) : defaultEffect(manifest?.category);
}
