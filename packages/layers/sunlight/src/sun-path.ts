// The sun path drawn on the table: the day's arc across the sky as seen from above,
// with the sun on it. The zenith is the table's centre and the horizon a circle around it,
// so the sun sits on the side of the table its light comes from.
import { formatHour } from '@mrstudio/sdk';

import type { SunDay, SunSample } from './look.ts';

const SVG = 'http://www.w3.org/2000/svg';
/** Radius of the horizon in viewBox units; the viewBox is 200 wide around the centre. */
const HORIZON = 90;

function node<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  parent.append(el);
  return el;
}

export class SunPath {
  private glow: HTMLElement;
  private svg: SVGSVGElement;
  private arcs: SVGPathElement[];
  private marks: SVGGElement;
  private sun: SVGGElement;
  private up: number;
  private background = '';
  private golden = false;

  /** `up` is the compass bearing of the table's top edge. */
  constructor(host: HTMLElement, up: number) {
    this.up = up;
    this.glow = document.createElement('div');
    this.glow.style.cssText = 'position:absolute;inset:0;mix-blend-mode:screen;transition:opacity 0.4s';
    host.append(this.glow);

    this.svg = document.createElementNS(SVG, 'svg');
    this.svg.setAttribute('viewBox', '-100 -100 200 200');
    this.svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;transition:opacity 0.4s';
    host.append(this.svg);
    const defs = node('defs', {}, this.svg);
    const halo = node('radialGradient', { id: 'sunlight-halo' }, defs);
    node('stop', { offset: 0, 'stop-color': '#fff7d6', 'stop-opacity': 0.95 }, halo);
    node('stop', { offset: 0.25, 'stop-color': '#ffd27a', 'stop-opacity': 0.55 }, halo);
    node('stop', { offset: 1, 'stop-color': '#ff9a3c', 'stop-opacity': 0 }, halo);
    // A dark line under a bright dotted one, so the arc reads on sunlit ground and in shade alike.
    this.arcs = [
      node('path', { fill: 'none', stroke: '#2a1640', 'stroke-opacity': 0.4, 'stroke-width': 1.1, 'stroke-linecap': 'round' }, this.svg),
      node('path', { fill: 'none', stroke: '#ffcf7a', 'stroke-width': 0.55, 'stroke-dasharray': '0.1 1.7', 'stroke-linecap': 'round' }, this.svg),
    ];
    this.marks = node(
      'g',
      { fill: '#ffe9bd', stroke: '#2a1640', 'stroke-opacity': 0.75, 'stroke-width': 0.8, 'paint-order': 'stroke', 'font-size': 3.2, 'font-weight': 600, 'font-family': 'inherit', 'text-anchor': 'middle' },
      this.svg,
    );
    this.sun = node('g', {}, this.svg);
    node('circle', { r: 11, fill: 'url(#sunlight-halo)' }, this.sun);
    node('circle', { r: 1.9, fill: '#fffbe8', stroke: '#ff9a3c', 'stroke-width': 0.5 }, this.sun);
  }

  /** Where a sky position lands, in viewBox units. */
  private place(azimuth: number, altitude: number): [number, number] {
    const r = HORIZON * (1 - Math.max(0, altitude) / 90);
    const a = ((azimuth - this.up) * Math.PI) / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  }

  setVisible(visible: boolean): void {
    this.svg.style.opacity = visible ? '1' : '0';
  }

  /** Draws the arc for a day, with a mark every three hours. */
  setDay(day: SunDay): void {
    const above = day.samples.filter((s) => s.altitude > 0);
    const d = above.map((s, i) => `${i === 0 ? 'M' : 'L'}${this.place(s.azimuth, s.altitude).map((v) => v.toFixed(2)).join(' ')}`).join('');
    for (const arc of this.arcs) arc.setAttribute('d', d);
    this.marks.replaceChildren();
    for (const s of above) {
      if (Math.abs(s.hour / 3 - Math.round(s.hour / 3)) > 1e-6) continue;
      const [x, y] = this.place(s.azimuth, s.altitude);
      node('circle', { cx: x, cy: y, r: 0.9 }, this.marks);
      const length = Math.hypot(x, y) || 1;
      const label = node('text', { x: x - (x / length) * 5, y: y - (y / length) * 5 + 1.1 }, this.marks);
      label.textContent = formatHour(s.hour);
    }
  }

  /** Golden hour mode (#363): the light that spills in from the sun's side is stronger and warmer. */
  setGolden(golden: boolean): void {
    this.golden = golden;
  }

  /** Moves the sun, and lets its light spill in from that side of the table. */
  setSun(sun: SunSample): void {
    const upness = Math.min(1, Math.max(0, (sun.altitude + 2) / 6));
    const [x, y] = this.place(sun.azimuth, sun.altitude);
    this.sun.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    this.sun.setAttribute('opacity', upness.toFixed(2));
    // Strongest when the sun is low, when light really does rake across a place.
    const low = Math.min(1, Math.max(0, 1 - sun.altitude / 45));
    const strength = upness * (0.06 + 0.2 * low);
    const angle = sun.azimuth - this.up;
    // The glow covers the whole table and blends with it, so it is repainted only when it changes enough to
    // see: a play through the day moves the sun every frame (#302).
    const deg = (Math.round(angle * 2) / 2).toFixed(1);
    const alpha = (a: number) => (Math.round(a * 200) / 200).toFixed(3);
    // In the golden hour the wash reaches further in, rose at its far edge and ember gold on the sun's side.
    const sunk = Math.min(1, Math.max(0, (sun.altitude + 4) / 4));
    const gold = sunk * 0.5;
    const background = this.golden
      ? `linear-gradient(${deg}deg, rgba(255,90,120,0) 10%, rgba(255,110,96,${alpha(gold * 0.35)}) 50%, rgba(255,170,80,${alpha(gold)}) 100%)`
      : `linear-gradient(${deg}deg, rgba(255,170,90,0) 35%, rgba(255,186,110,${alpha(strength)}) 100%)`;
    if (background !== this.background) {
      this.background = background;
      this.glow.style.background = background;
    }
  }
}
