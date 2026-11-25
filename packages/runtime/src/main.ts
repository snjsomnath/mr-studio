import { Connection } from '@mrstudio/sdk';
import { reportErrors } from './diagnostics.ts';
import { meter } from './perf.ts';
import type { Role, SiteInfo } from '@mrstudio/sdk';

import { luminance, themeVariables } from '@mrstudio/dashboard';
import '@mrstudio/dashboard/src/dashboard.css';

import { Controller, languageSwitch } from './controls.ts';
import { mountDashboard } from './dashboard.ts';
import { guideCode, guideDoor, guideScreen } from './guide.ts';
import { browserLanguage, keepOwnLanguage, language, offered, ownLanguage, setLanguage, speak, t } from './i18n.ts';
import type { Language } from './i18n.ts';
import { joinPanel, pausedBanner, phonesPanel } from './join.ts';
import { LayerManager } from './layer-manager.ts';
import { loadSiteModules } from './registry.ts';
import { fieldCard } from './field-phone.ts';
import { phoneBadge, phoneCode, refusedScreen, rememberSeat, rememberedSeat } from './phone.ts';
import { Store } from './store.ts';
import { collectProblems, Workbench } from './workbench.ts';
import './style.css';

// A stylesheet that comes with code loaded later (the map's, with the table) can fail to load
// while the page reloads or the host restarts; WebKit then failed the whole import and the table
// stayed blank (#261's smoke). The code still runs, so the page carries on without it until the
// next reload brings it. Failed code still fails, and is reported (#260).
window.addEventListener('vite:preloadError', (event) => {
  const message = String((event as Event & { payload?: Error }).payload?.message ?? '');
  if (/preload CSS/i.test(message)) {
    event.preventDefault();
    console.warn(message);
  }
});

const ROLES: Role[] = ['table', 'tv', 'phone', 'dev', 'guide'];

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main() {
  const app = document.getElementById('app')!;
  // Through the join page (#275) the page lives under the page's own path, such as
  // /mr-studio/v1/t/<link>/phone; the join page says which part to leave out.
  const base = (window as { __MRS_BASE__?: string }).__MRS_BASE__;
  const path = base && location.pathname.startsWith(base) ? location.pathname.slice(base.length - 1) : location.pathname;
  const segment = path.split('/').filter(Boolean)[0];
  // The Help window (#271): the guides and every feature, from help.json. It needs no session.
  if (segment === 'help') {
    document.body.dataset.role = 'help';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'light');
    (window as { mrsShellControls?: boolean }).mrsShellControls = true;
    const { helpWindow } = await import('./help/help.ts');
    await helpWindow(app);
    return;
  }
  // The first step of the setup wizard, for a table that does not exist yet. It needs no session.
  if (segment === 'new') {
    document.body.dataset.role = 'edit';
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', 'light');
    (window as { mrsShellControls?: boolean }).mrsShellControls = true;
    const { newTable } = await import('./editor/new-table.ts');
    newTable(app);
    return;
  }
  // The join page's bridge alone (#275), with no surface drawn: for a window that only carries phones in.
  if (segment === 'bridge') {
    document.title = 'MR Studio · phones';
    const { startBridge } = await import('./bridge.ts');
    startBridge();
    return;
  }
  // The old scene composer is retired (#87): the editor is the one authoring page.
  if (segment === 'compose') {
    location.replace(`/edit${location.search}${location.hash}`);
    return;
  }
  // The editor is the authoring window around the live table. It joins with the dev role too.
  const editing = segment === 'edit';
  const role: Role = ROLES.includes(segment as Role) ? (segment as Role) : 'dev';
  // The workbench lists what the page complained about since it started (#358).
  if (role === 'dev') collectProblems();
  // The editor has its own Present, Stop and Sites controls, so the desktop app adds no bar of its own.
  if (editing) (window as { mrsShellControls?: boolean }).mrsShellControls = true;
  document.body.dataset.role = editing ? 'edit' : role;

  const phone = role === 'phone';
  // The guide's phone (#98) has a code of its own, from the operator's screens.
  const guiding = role === 'guide';
  const code = phone ? phoneCode() : guiding ? guideCode() : undefined;
  // A phone turned away at the door speaks the language it chose, or its browser's (#80).
  if (phone) setLanguage(ownLanguage() ?? browserLanguage());
  if (phone && !code) {
    app.append(refusedScreen('no code'));
    return;
  }
  if (guiding && !code) {
    app.append(guideDoor());
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
  // Errors in this window reach the app's log (#260), from the moment it is connected.
  reportErrors(connection, (window as { __MRS_WINDOW__?: string }).__MRS_WINDOW__);
  // How fast this window draws, and what each layer costs (#262).
  if (!phone) meter.start();
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
    if (guiding) app.append(guideDoor((error as Error).message));
    else if (!phone) app.append(el('p', 'notice', `Could not join: ${(error as Error).message}.`));
    return;
  }
  const store = new Store(connection, welcome);
  // The controller (or, without one, the table) carries phones in from the join page on GitHub
  // Pages (#275), for venues where they cannot reach this computer. The host takes one bridge
  // and decides whether it is on. The controller goes first: it draws less than the table, so
  // phones' requests wait less for its page.
  if ((role === 'tv' || role === 'table') && !editing) {
    window.setTimeout(() => void import('./bridge.ts').then(({ startBridge }) => startBridge()), role === 'tv' ? 0 : 5000);
  }
  const site = store.state.site;
  // The site's own code layers (#277) load before anything asks for a layer's code. Phones need none.
  if (!phone) {
    await loadSiteModules(store.manifests);
    store.onCatalog(() => void loadSiteModules(store.manifests));
  }
  if (guiding) {
    document.title = `Guide · ${site.name}`;
    app.append(guideScreen(store, connection));
    return;
  }
  document.title = `${site.branding.title ?? 'MR Studio'} · ${site.name}`;

  // The visitors' screens speak the session's language (#80); a phone may keep one of its own.
  // The controller and the phones draw their words once, so they start again in a new language;
  // the table only redraws its ribbons.
  const visitors = !editing && (role === 'tv' || role === 'phone' || role === 'table');
  if (visitors) {
    const wanted = (): Language => {
      const languages = offered(store.state);
      const pick = (phone ? ownLanguage() : null) ?? (store.state.session.language as Language | undefined) ?? languages[0]!;
      return languages.includes(pick) ? pick : languages[0]!;
    };
    speak(store, wanted());
    const follow = () => {
      if (wanted() === language()) return;
      if (role === 'table') speak(store, wanted());
      else location.reload();
    };
    connection.on('session.changed', follow);
    connection.on('site.settings', () => (role === 'table' ? speak(store, wanted()) : follow()));
  }

  const status = el('div', 'connection', t('Reconnecting…'));
  status.hidden = true;
  // New data was brought into the site: layers read their data once, so every surface starts again. The editor does this itself.
  // A new front edge or ribbons (#62) only moves the ribbons: the table takes it in place.
  let tableChanged: (() => void) | null = null;
  connection.on('site.changed', (p: { site?: SiteInfo; table_only?: boolean }) => {
    if (p?.table_only && p.site) {
      store.state.site.table = p.site.table;
      tableChanged?.();
    } else if (!editing) location.reload();
  });
  // The engine failed and a new one took over (#79): its streams are gone, so the page starts again.
  if (!editing && !phone) connection.on('engine.restarted', () => location.reload());
  // A table or controller says it is alive, with its frame rate and what its layers cost, so the
  // desktop app's watchdog can reload one that went blank or froze (#79) and the editor can warn
  // when the table cannot keep up (#262). Outside the app the window is named by its role.
  const windowName = (window as { __MRS_WINDOW__?: string }).__MRS_WINDOW__;
  // The editor's live controller preview is a frame inside the editor, not a window of its own.
  if ((role === 'table' || role === 'tv') && !editing && window.top === window) {
    let frames = 0;
    const count = () => {
      frames++;
      requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    let since = performance.now();
    window.setInterval(() => {
      const now = performance.now();
      const budget = meter.report();
      connection.alive(windowName ?? role, (frames * 1000) / (now - since), { worst_ms: budget.worst_ms, layers: budget.layers.slice(0, 5) });
      frames = 0;
      since = now;
    }, 2000);
    // The frame meter on screen: Ctrl+Shift+P, or the editor's Show frame meter for the session.
    void import('./perf-overlay.ts').then(({ frameOverlay }) => frameOverlay(store, connection));
  }
  // The controller's title, logo and welcome line changed (Table settings, #73): it draws them once, so it starts again.
  if (role === 'tv' && !editing) connection.on('site.settings', () => location.reload());
  store.onSettings(() => (document.title = `${store.state.site.branding.title ?? 'MR Studio'} · ${store.state.site.name}`));
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
    // A click on the map selects the layer that drew there (#425).
    if (editor) editor.picker = { hits: (x, y) => view.hits(x, y), listens: (id) => view.listens(id) };
    const { installModel } = await import('./model/index.ts');
    await installModel(view, connection, role, { remoteCalibration: !editing });
    new LayerManager(store, connection, view);
    // The projected table opens zoomed out over its surroundings and slowly zooms in (#446); the
    // controller's Reset plays it again. `?intro=0` leaves it out, for scripted screenshots.
    if (role === 'table' && new URLSearchParams(location.search).get('intro') !== '0') {
      view.playIntro();
      connection.on('table.intro', () => view.playIntro());
    }
    // The ribbons in the projector's blank space around the model (#78). The projected table draws
    // them where the free space is; the editor and dev keep room beside the map and preview them there.
    const { Ribbons } = await import('./ribbon.ts');
    const { previewReserve } = await import('./ribbon-bands.ts');
    if (role === 'table') {
      const ribbons = new Ribbons(surface, store, connection, () => ({ footprint: view.footprint(), surface: { width: surface.clientWidth, height: surface.clientHeight } }));
      view.onViewChange(() => ribbons.layout());
      tableChanged = () => ribbons.layout();
    } else if (site.table) {
      const reserve = (): void => {
        if (!store.state.site.table) return;
        for (const [side, fraction] of Object.entries(previewReserve(store.state.site.table))) surface.style.setProperty(`--ribbon-${side}`, String(fraction));
      };
      reserve();
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
      tableChanged = () => {
        reserve();
        requestAnimationFrame(() => ribbons.layout());
      };
    }
    if (editing) return;
  }
  let bench: import('@mrstudio/dashboard').DashboardView | undefined;
  if (role === 'tv' || role === 'dev') {
    const dash = el('main', 'dash');
    // On the controller screen the open layer's words and controls sit above its panels.
    if (role === 'tv') stage.append(el('div', 'open-layers'));
    stage.append(dash);
    if (role === 'tv') app.append(stage);
    const view = mountDashboard(dash, store, connection, role === 'dev');
    if (role === 'dev') bench = view;
  }

  // Everything except the bare table gets the controller.
  if (role !== 'table') {
    const side = el('aside', 'controller');
    const header = el('header', 'controller-header');
    const title = el('div', '');
    title.append(el('h1', '', t(site.branding.title ?? 'MR Studio')), el('p', '', t(site.name)));
    // The site's logo beside its title on phones and the developer page (#156); the controller screen shows it on its welcome.
    if (site.branding.logo) {
      const logo = document.createElement('img');
      logo.className = 'controller-logo';
      logo.alt = '';
      logo.src = `/site/${site.branding.logo.replace(/^\/+/, '')}`;
      logo.addEventListener('error', () => logo.remove());
      const brand = el('div', 'controller-brand');
      brand.append(logo, title);
      header.append(brand);
    } else header.append(title);
    if (phone) header.append(phoneBadge(store, connection));
    // A phone can speak another language than the table (#80): the visitor's own choice, kept on the phone.
    const languages = offered(store.state);
    if (phone && languages.length > 1) {
      header.append(
        languageSwitch(languages, language(), (next) => {
          keepOwnLanguage(next);
          location.reload();
        }),
      );
    }
    side.append(header);
    if (phone) side.append(pausedBanner(store));
    const cards = el('div', 'cards');
    if (phone) {
      // A field walk (#445) sits above the layers, outside the cards the controller redraws.
      const scroller = el('div', 'cards');
      cards.className = 'cards cards-inner';
      scroller.append(fieldCard(store, connection), cards);
      side.append(scroller);
    } else side.append(cards);

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
        // Looking after the phones (#335): pause, let one go, end the round, the session log.
        foot.append(phonesPanel(store, connection));
        const footer = el('footer', 'controller-footer');
        const info = await connection.request<{ backend: string; adapter: string | null }>('engine.info').catch(() => null);
        footer.append(el('span', '', `Session ${store.state.session.code}`), el('span', '', info ? `Engine: ${info.adapter ?? `${info.backend} reference`}` : ''));
        foot.append(footer);
        // The workbench for layer and widget authors (#358), beside the live table.
        if (bench) {
          const workbench = new Workbench(store, connection, bench);
          const toggle = document.createElement('button');
          toggle.className = 'workbench-toggle';
          toggle.textContent = 'Workbench';
          toggle.type = 'button';
          const open = (on: boolean) => {
            workbench.root.hidden = !on;
            toggle.setAttribute('aria-pressed', String(on));
            try {
              localStorage.setItem('mrs-workbench', on ? '1' : '0');
            } catch {
              // Remembering is a convenience.
            }
          };
          // Open unless it was closed here before: the Developer window is the workbench.
          let remembered = true;
          try {
            remembered = localStorage.getItem('mrs-workbench') !== '0';
          } catch {
            // Open by default.
          }
          toggle.onclick = () => open(workbench.root.hidden);
          open(new URLSearchParams(location.search).has('bench') || remembered);
          footer.prepend(toggle);
          stage.after(workbench.root);
        }
      }
    }
    // The dashed core buttons (Reset, About) sit at the foot of the rail the buttons start on.
    if (second) (site.tv?.rail === 'right' ? second : side).append(controller.actions());
    app.append(side);
    if (second) app.append(second);
  }
}

void main();
