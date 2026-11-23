import { Connection } from '@mrstudio/sdk';
import type { Role } from '@mrstudio/sdk';

import { luminance, themeVariables } from '@mrstudio/dashboard';
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
  // The first step of the setup wizard, for a table that does not exist yet. It needs no session.
  if (segment === 'new') {
    document.body.dataset.role = 'edit';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'light');
    (window as { mrsShellControls?: boolean }).mrsShellControls = true;
    const { newTable } = await import('./editor/new-table.ts');
    newTable(app);
    return;
  }
  // The scene composer is an operator's tool: it joins with the dev role and has its own layout.
  const composing = segment === 'compose';
  // The editor is the authoring window around the live table. It joins with the dev role too.
  const editing = segment === 'edit';
  const role: Role = ROLES.includes(segment as Role) ? (segment as Role) : 'dev';
  // The editor has its own Present, Stop and Sites controls, so the desktop app adds no bar of its own.
  if (editing) (window as { mrsShellControls?: boolean }).mrsShellControls = true;
  document.body.dataset.role = editing ? 'edit' : composing ? 'compose' : role;

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
  // New data was brought into the site: layers read their data once, so every surface starts again. The editor does this itself.
  if (!editing) connection.on('site.changed', () => location.reload());
  // A reconnect that lands on a restarted host (another table opened, the app relaunched) starts the page again:
  // layers read their data once, and reads made while the host was down came back empty (#222).
  if (!phone) {
    const first = welcome.state.session.id;
    connection.on('welcome', (message: typeof welcome) => message !== welcome && message.state.session.id !== first && location.reload());
  }
  connection.on('disconnected', () => (status.hidden = false));
  connection.on('welcome', () => (status.hidden = true));
  document.body.append(status);

  // The site's theme also colours the controls, so the rail and the dashboard read as one screen.
  // It follows the setup guide live: a theme picked there restyles this screen at once.
  const names = { '--bg': '--mrs-bg', '--panel': '--mrs-panel', '--card': '--mrs-panel', '--line': '--mrs-line', '--text': '--mrs-text', '--muted': '--mrs-muted', '--accent': '--mrs-accent', '--accent-ink': '--mrs-accent-ink' };
  const applyTv = (tv: typeof site.tv) => {
    const theme = themeVariables(tv?.theme).variables;
    for (const [own, token] of Object.entries(names)) {
      if (tv?.theme && !editing) document.documentElement.style.setProperty(own, theme[token]!);
      else document.documentElement.style.removeProperty(own);
    }
    // The look beyond colour (#126): the surface, the layer buttons and how much chrome there is.
    const themed = Boolean(tv?.theme) && !editing;
    document.body.dataset.surface = themed ? theme['--mrs-panel-style']! : 'filled';
    document.body.dataset.railLook = themed ? theme['--mrs-rail-look']! : 'tiles';
    document.body.dataset.density = themed ? theme['--mrs-density']! : 'comfortable';
    document.documentElement.style.colorScheme = themed && luminance(theme['--mrs-bg']!) > 0.4 ? 'light' : '';
    document.body.dataset.rail = tv?.rail ?? 'left';
    document.body.dataset.railStyle = tv?.rail_style === 'labelled' ? 'labelled' : 'icons';
  };
  applyTv(site.tv);
  store.onTv(applyTv);

  // The table (and the table half of dev) renders layers. Dev shows the TV's dashboard under it.
  const stage = el('div', 'stage');
  const palette = el('aside', 'controller palette');
  if (composing) app.append(palette);
  if (role === 'table' || role === 'dev') {
    let editor: import('./editor/editor.ts').Editor | null = null;
    const frame = el('div', 'table-frame');
    const surface = el('div', 'table-surface');
    surface.style.aspectRatio = `${site.extent.width_m} / ${site.extent.height_m}`;
    surface.style.setProperty('--aspect', String(site.extent.width_m / site.extent.height_m));
    frame.append(surface);
    if (editing) {
      // The editor's chrome is light whatever the site's theme; only the table inside it is dark.
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'light');
      const { Editor } = await import('./editor/editor.ts');
      editor = new Editor(app, store, connection);
      editor.canvas.append(frame);
    } else {
      stage.append(frame);
      app.append(stage);
    }
    // The map library is large; phones and the TV never load it.
    const { TableView } = await import('./table.ts');
    const view = new TableView(surface, site, role === 'table');
    await view.ready;
    view.setQuality(site.display?.quality ?? 'good');
    store.onDisplay((quality) => view.setQuality(quality));
    // The editor keeps a picture of the table for Home when it is left (#131).
    if (editor) editor.snapshot = () => view.snapshot();
    const { installModel } = await import('./model/index.ts');
    await installModel(view, connection, role, { remoteCalibration: !editing });
    new LayerManager(store, connection, view);
    // The ribbons in the projector's blank space around the model (#78). The projected table draws
    // them where the free space is; the editor and dev keep room beside the map and preview them there.
    const { Ribbons } = await import('./ribbon.ts');
    const { previewReserve } = await import('./ribbon-bands.ts');
    if (role === 'table') {
      const ribbons = new Ribbons(surface, store, connection, () => ({ footprint: view.footprint(), surface: { width: surface.clientWidth, height: surface.clientHeight } }));
      view.onViewChange(() => ribbons.layout());
    } else if (!composing && site.table) {
      for (const [side, fraction] of Object.entries(previewReserve(site.table))) surface.style.setProperty(`--ribbon-${side}`, String(fraction));
      frame.classList.add('has-ribbons');
      const ribbons = new Ribbons(frame, store, connection, () => {
        const f = frame.getBoundingClientRect();
        const r = surface.getBoundingClientRect();
        const footprint: [number, number][] = [
          [r.left - f.left, r.top - f.top],
          [r.right - f.left, r.top - f.top],
          [r.right - f.left, r.bottom - f.top],
          [r.left - f.left, r.bottom - f.top],
        ];
        return r.width > 0 ? { footprint, surface: { width: f.width, height: f.height } } : null;
      }, true);
      new ResizeObserver(() => ribbons.layout()).observe(frame);
    }
    if (editing) return;
    if (composing) {
      const stack = el('aside', 'controller stack');
      app.append(stack);
      new Composer(palette, stack, surface, store, connection);
      return;
    }
  }
  if (role === 'tv' || role === 'dev') {
    const dash = el('main', 'dash');
    // On the controller screen the open layer's words and controls sit above its panels.
    if (role === 'tv') stage.append(el('div', 'open-layers'));
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

    // The controller screen has the layer buttons down both sides of the dashboard.
    const second = role === 'tv' ? el('aside', 'controller controller-right') : null;
    const rightCards = el('div', 'cards');
    const controller = new Controller(cards, store, connection, role, second ? rightCards : undefined, second ? (stage.querySelector<HTMLElement>('.open-layers') ?? undefined) : undefined);

    if (!phone) {
      const foot = second ?? side;
      // No Home button: pressing the open layer's button again closes it and leaves the map at rest (#74).
      if (second) second.append(rightCards);
      foot.append(joinPanel(store));
      // The session and the engine are for whoever runs the table: the developer page has them, the visitors' controller does not.
      if (role === 'dev') {
        const footer = el('footer', 'controller-footer');
        const info = await connection.request<{ backend: string; adapter: string | null }>('engine.info').catch(() => null);
        footer.append(el('span', '', `Session ${store.state.session.code}`), el('span', '', info ? `Engine: ${info.adapter ?? `${info.backend} reference`}` : ''));
        foot.append(footer);
      }
    }
    // The dashed core buttons (Reset, About) sit at the foot of the rail the buttons start on.
    if (second) (site.tv?.rail === 'right' ? second : side).append(controller.actions());
    app.append(side);
    if (second) app.append(second);
  }
}

void main();
