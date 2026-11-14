import { Connection } from '@mrstudio/sdk';
import type { Role } from '@mrstudio/sdk';

import { themeVariables } from '@mrstudio/dashboard';
import '@mrstudio/dashboard/src/dashboard.css';

import { Composer } from './compose.ts';
import { Controller } from './controls.ts';
import { mountDashboard } from './dashboard.ts';
import { joinPanel } from './join.ts';
import { LayerManager } from './layer-manager.ts';
import { phoneBadge, phoneCode, refusedScreen, rememberSeat, rememberedSeat } from './phone.ts';
import { Store } from './store.ts';
import './style.css';

const ROLES: Role[] = ['table', 'tv', 'phone', 'dev'];

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main() {
  const app = document.getElementById('app')!;
  const segment = location.pathname.split('/').filter(Boolean)[0];
  // The scene composer is an operator's tool: it joins with the dev role and has its own layout.
  const composing = segment === 'compose';
  const role: Role = ROLES.includes(segment as Role) ? (segment as Role) : 'dev';
  document.body.dataset.role = composing ? 'compose' : role;

  const phone = role === 'phone';
  const code = phone ? phoneCode() : undefined;
  if (phone && !code) {
    app.append(refusedScreen('no code'));
    return;
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const connection = new Connection({
    url: `${scheme}://${location.host}/ws`,
    role,
    code,
    // A phone that reloads within the hold returns to its slot.
    resume: phone ? rememberedSeat(code!) : undefined,
  });
  if (phone) {
    connection.on('welcome', (message: { resume?: string }) => message.resume && rememberSeat(code!, message.resume));
    // Refused at the door, or later: the session ended, or this phone joined again in another tab.
    connection.on('refused', (reason: string) => {
      document.querySelector('.connection')?.remove();
      app.replaceChildren(refusedScreen(reason));
    });
  }

  let welcome;
  try {
    welcome = await connection.connect();
  } catch (error) {
    if (!phone) app.append(el('p', 'notice', `Could not join: ${(error as Error).message}.`));
    return;
  }
  const store = new Store(connection, welcome);
  const site = store.state.site;
  document.title = `${site.branding.title ?? 'MR Studio'} · ${site.name}`;

  const status = el('div', 'connection', 'Reconnecting…');
  status.hidden = true;
  connection.on('disconnected', () => (status.hidden = false));
  connection.on('welcome', () => (status.hidden = true));
  document.body.append(status);

  // The site's theme also colours the controls, so the rail and the dashboard read as one screen.
  const theme = themeVariables(site.tv?.theme).variables;
  const names = { '--bg': '--mrs-bg', '--panel': '--mrs-panel', '--card': '--mrs-panel', '--line': '--mrs-line', '--text': '--mrs-text', '--muted': '--mrs-muted', '--accent': '--mrs-accent', '--accent-ink': '--mrs-accent-ink' };
  if (site.tv?.theme) for (const [own, token] of Object.entries(names)) document.documentElement.style.setProperty(own, theme[token]!);
  document.body.dataset.rail = site.tv?.rail ?? 'left';

  // The table (and the table half of dev) renders layers. Dev shows the TV's dashboard under it.
  const stage = el('div', 'stage');
  const palette = el('aside', 'controller palette');
  if (composing) app.append(palette);
  if (role === 'table' || role === 'dev') {
    const frame = el('div', 'table-frame');
    const surface = el('div', 'table-surface');
    surface.style.aspectRatio = `${site.extent.width_m} / ${site.extent.height_m}`;
    surface.style.setProperty('--aspect', String(site.extent.width_m / site.extent.height_m));
    frame.append(surface);
    stage.append(frame);
    app.append(stage);
    // The map library is large; phones and the TV never load it.
    const { TableView } = await import('./table.ts');
    const view = new TableView(surface, site, role === 'table');
    await view.ready;
    const { installModel } = await import('./model/index.ts');
    await installModel(view, connection, role);
    new LayerManager(store, connection, view);
    if (composing) {
      const stack = el('aside', 'controller stack');
      app.append(stack);
      new Composer(palette, stack, surface, store, connection);
      return;
    }
  }
  if (role === 'tv' || role === 'dev') {
    const dash = el('main', 'dash');
    stage.append(dash);
    if (role === 'tv') app.append(stage);
    mountDashboard(dash, store, connection, role === 'dev');
  }

  // Everything except the bare table gets the controller.
  if (role !== 'table') {
    const side = el('aside', 'controller');
    const header = el('header', 'controller-header');
    const title = el('div', '');
    title.append(el('h1', '', site.branding.title ?? 'MR Studio'), el('p', '', site.name));
    header.append(title);
    if (phone) header.append(phoneBadge(store));
    side.append(header);
    const cards = el('div', 'cards');
    side.append(cards);
    new Controller(cards, store, connection, role);

    if (!phone) {
      side.append(joinPanel(store));
      const footer = el('footer', 'controller-footer');
      const info = await connection.request<{ backend: string; adapter: string | null }>('engine.info').catch(() => null);
      footer.append(el('span', '', `Session ${store.state.session.code}`), el('span', '', info ? `Engine: ${info.adapter ?? `${info.backend} reference`}` : ''));
      side.append(footer);
    }
    app.append(side);
  }
}

void main();
