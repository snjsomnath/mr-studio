// The TV panel: what the viewer sees, as one bar in the demo's colours with its shares.
import type { PanelContext, PanelHandlers } from '@mrstudio/sdk';

import type { Params } from './index.ts';
import type { ViewPart } from './view.ts';

export function isovistPanel(ctx: PanelContext<Params>, el: HTMLElement): PanelHandlers {
  el.innerHTML = `
    <style>
      .iso-panel { display: grid; gap: 0.5em; font-size: 0.9em; font-variant-numeric: tabular-nums; }
      .iso-panel-bar { display: flex; height: 0.7em; border-radius: 0.35em; overflow: hidden; background: rgb(127 127 127 / 0.2); }
      .iso-panel-bar i { display: block; height: 100%; }
      .iso-panel-keys { display: flex; flex-wrap: wrap; gap: 0.2em 1em; }
      .iso-panel-keys span { display: inline-flex; align-items: center; gap: 0.35em; white-space: nowrap; }
      .iso-panel-keys span::before { content: ''; width: 0.7em; height: 0.7em; border-radius: 0.15em; background: var(--c); }
    </style>
    <div class="iso-panel"><div class="iso-panel-bar"></div><div class="iso-panel-keys"></div></div>`;
  const bar = el.querySelector('.iso-panel-bar') as HTMLElement;
  const keys = el.querySelector('.iso-panel-keys') as HTMLElement;
  function update(): void {
    const parts = ((ctx.shared as { parts?: ViewPart[] }).parts ?? []).filter((p) => p.share > 0.005);
    bar.replaceChildren(
      ...parts.map((p) => {
        const i = document.createElement('i');
        i.style.background = p.colour;
        i.style.flexGrow = String(p.share);
        return i;
      }),
    );
    keys.replaceChildren(
      ...parts.slice(0, 4).map((p) => {
        const k = document.createElement('span');
        k.style.setProperty('--c', p.colour);
        k.textContent = `${p.label} ${Math.round(p.share * 100)}%`;
        return k;
      }),
    );
  }
  update();
  return { update };
}
