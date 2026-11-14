import { Connection } from '@mrstudio/sdk';
import type { Role } from '@mrstudio/sdk';

import { themeVariables } from '@mrstudio/dashboard';
import '@mrstudio/dashboard/src/dashboard.css';

import { Controller } from './controls.ts';
import { mountDashboard } from './dashboard.ts';
import { LayerManager } from './layer-manager.ts';
import { Store } from './store.ts';
import './style.css';
import { TableView } from './table.ts';

const ROLES: Role[] = ['table', 'tv', 'phone', 'dev'];

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main() {
  const app = document.getElementById('app')!;
  const segment = location.pathname.split('/').filter(Boolean)[0] as Role | undefined;
  const role: Role = segment && ROLES.includes(segment) ? segment : 'dev';
  document.body.dataset.role = role;

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const connection = new Connection({
    url: `${scheme}://${location.host}/ws`,
    role,
    code: new URLSearchParams(location.search).get('c') ?? undefined,
  });

  let welcome;
  try {
    welcome = await connection.connect();
  } catch (error) {
    app.append(el('p', 'notice', `Could not join: ${(error as Error).message}.`));
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
  if (role === 'table' || role === 'dev') {
    const frame = el('div', 'table-frame');
    const surface = el('div', 'table-surface');
    surface.style.aspectRatio = `${site.extent.width_m} / ${site.extent.height_m}`;
    surface.style.setProperty('--aspect', String(site.extent.width_m / site.extent.height_m));
    frame.append(surface);
    stage.append(frame);
    app.append(stage);
    const view = new TableView(surface, site);
    await view.ready;
    new LayerManager(store, connection, view);
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
    header.append(el('h1', '', site.branding.title ?? 'MR Studio'), el('p', '', site.name));
    side.append(header);
    const cards = el('div', 'cards');
    side.append(cards);
    new Controller(cards, store, connection, role);

    if (role !== 'phone') {
      const footer = el('footer', 'controller-footer');
      const info = await connection.request<{ backend: string; adapter: string | null }>('engine.info').catch(() => null);
      const people = el('span', '');
      const showPeople = () => (people.textContent = `Session ${store.state.session.code} · ${store.state.participants.length} phones`);
      showPeople();
      store.onParticipants(showPeople);
      footer.append(people, el('span', '', info ? `Engine: ${info.adapter ?? `${info.backend} reference`}` : ''));
      side.append(footer);
    }
    app.append(side);
  }
}

void main();
