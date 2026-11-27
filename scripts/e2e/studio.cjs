// The end-to-end cases' shared start (#545): every case gets its own host on a free port and a
// fresh copy of the sample table, so no case depends on what another left behind, a failed case
// does not stop the others, and any one of them can be run alone with `pnpm e2e -g "<name>"`.
//
// A file picks the table it starts from with `test.use({ setup: 'editor' })`; the default is the
// controller's (see SETUPS). Set E2E_SHOTS to a folder to also keep the screenshots that the
// release notes and the docs use (`pnpm e2e:shots`); a failed case keeps its own screenshot and
// trace in e2e-results either way.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const base = require('@playwright/test');

const root = path.resolve(__dirname, '..', '..');
const kit = path.join(root, 'samples', 'kit');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shotsWanted = process.env.E2E_SHOTS || (process.env.npm_lifecycle_event === 'e2e:shots' ? 'e2e-screenshots' : '');
const shotsDir = shotsWanted ? path.resolve(root, shotsWanted) : null;

// Base map tiles come from the internet, which a test does not reach: every tile is a plain light square.
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB/0lEQVR42u3TsQkAAAgEsd9/XMXe2hkMZIKDS/XAW5EAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwAAYQAUMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA2AAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAOogAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgArgUn3irHh0b72wAAAABJRU5ErkJggg==',
  'base64',
);

/** The tables a case can start from: a copy of sites/sample with a few changes. */
const SETUPS = {
  // The controller, the phones and the layers.
  controller(json) {
    // The slideshow shows two layers of the scene, one after the other (#43).
    json.layers.find((l) => (l.id ?? l.use) === 'slideshow').steps = {
      mode: 'manual',
      loop: true,
      sequence: [
        { layer: 'sunlight', params: { hour: 9 }, title: 'Morning shadows', description: 'The square at nine on midsummer morning.', source: 'Sun position: NOAA' },
        { layer: 'trees', title: 'Street trees' },
      ],
    };
    // The controller's home loops faster here, and goes home on its own only when a case asks (#74).
    json.tv = { ...(json.tv ?? {}), attract_s: 2, idle_reset_s: 0 };
    // A map of the buildings by use, revealed a use at a time: the controller's legend follows it (#76).
    json.layers.push({ use: 'mapdata', id: 'uses', active: false, button: { name: 'Building uses' }, params: { dataset: 'buildings', colorBy: 'kind', reveal: true } });
  },
  // The editor's flows (#67): a drawing for the Masterplan frame and a series of columns through time.
  editor(json, site) {
    // A drawing for the Masterplan frame (#405).
    fs.copyFileSync(path.join(kit, 'masterplan.svg'), path.join(site, 'data', 'masterplan.svg'));
    json.data.masterplan = 'data/masterplan.svg';
    // A series of columns through time (#408): the sample zones with a population for each fifth year.
    const zones = JSON.parse(fs.readFileSync(path.join(kit, 'zones.geojson'), 'utf8'));
    for (const [i, f] of zones.features.entries()) for (const [k, year] of [2000, 2005, 2010, 2015, 2020].entries()) f.properties[`pop_${year}`] = 1000 + ((i * 7 + k * 13) % 9) * 300;
    fs.writeFileSync(path.join(site, 'data', 'growth.geojson'), JSON.stringify(zones));
    json.data.growth = 'data/growth.geojson';
  },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A surface without a browser: joins the session over the WebSocket and sends requests. */
function joinAt(port, role) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pending = new Map();
    let next = 1;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', protocol: 1, role }));
    socket.onerror = () => reject(new Error('could not reach the host'));
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.t === 'welcome') {
        resolve({
          request: (m, p) =>
            new Promise((done, fail) => {
              const id = next++;
              pending.set(id, { done, fail });
              socket.send(JSON.stringify({ t: 'req', id, m, p }));
            }),
          close: () => socket.close(),
        });
      } else if (message.t === 'res') {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) waiting?.done(message.r);
        else waiting?.fail(new Error(message.e));
      }
    };
  });
}

/** Polls until `check` holds: the host saves a moment after the page asks. */
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const test = base.test.extend({
  // Which table the case starts from (a key of SETUPS).
  setup: ['controller', { option: true }],
  // Whether errors the browser logs (a failed load, a console.error) fail the case, as thrown ones do.
  consoleErrors: [true, { option: true }],

  studio: async ({ browser, setup, consoleErrors }, use, info) => {
    const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-e2e-'));
    fs.cpSync(path.join(root, 'sites', 'sample'), site, { recursive: true });
    const file = path.join(site, 'site.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    SETUPS[setup](json, site);
    fs.writeFileSync(file, JSON.stringify(json, null, 2));

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const host = spawn(
      path.join(root, 'target', 'debug', process.platform === 'win32' ? 'mrstudio.exe' : 'mrstudio'),
      ['dev', '--site', site, '--web', 'packages/runtime/dist', '--port', String(port), '--backend', 'cpu', '--public-url', url],
      // Phones join on the local address here; the join page over WebRTC (#275) needs the internet.
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MRS_JOIN_PAGE: 'off' } },
    );
    let log = '';
    host.stdout.on('data', (d) => (log += d));
    host.stderr.on('data', (d) => (log += d));
    for (let i = 0; !/host listening/.test(log); i++) {
      if (i > 200 || host.exitCode !== null) throw new Error(`host did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const code = /session code (\d+)/.exec(log)[1];

    const errors = [];
    const pages = [];
    const saved = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const studio = {
      base: url,
      port,
      code,
      site,
      saved,
      savedLayers: () => saved().layers,
      layerIds: () => saved().layers.map((l) => l.id ?? l.use),
      savedLayer: (id) => saved().layers.find((l) => (l.id ?? l.use) === id),
      join: (role) => joinAt(port, role),
      /** A new page on `address`, with the map tiles answered locally and its errors kept. */
      async open(address, viewport, { goto = true, init } = {}) {
        const page = await browser.newPage({ viewport });
        pages.push({ page, address });
        await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org|api\.mapbox\.com|\/api\/basemap\//, (route) =>
          route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: TILE }),
        );
        page.on('pageerror', (e) => errors.push(`${address}: ${e.message}`));
        if (consoleErrors) page.on('console', (m) => m.type() === 'error' && errors.push(`${address}: ${m.text()}`));
        if (init) await page.addInitScript(init);
        if (goto) await page.goto(url + address);
        return page;
      },
      /** Keeps a screenshot for the release notes and the docs, when E2E_SHOTS asks for them. */
      async shot(target, name) {
        if (!shotsDir) return;
        const file = path.join(shotsDir, `${name}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await target.screenshot({ path: file });
      },
      shots: Boolean(shotsDir),
    };

    await use(studio);

    // A failed case keeps a screenshot of every page it had open and the host's last words; Playwright
    // keeps the trace of every page (trace: 'retain-on-failure').
    const failed = info.status !== info.expectedStatus;
    for (const [i, { page, address }] of pages.entries()) {
      const name = `${i + 1}-${address.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page'}`;
      if (failed && !page.isClosed()) {
        await info.attach(`${name}.png`, { body: await page.screenshot().catch(() => Buffer.alloc(0)), contentType: 'image/png' }).catch(() => {});
      }
      await page.context().close().catch(() => {});
    }
    if (failed) await info.attach('host.log', { body: log.slice(-20_000), contentType: 'text/plain' });
    host.kill();
    fs.rmSync(site, { recursive: true, force: true });
    // A refused file answers 422 and a wrong code is turned away, which the browser logs on its own;
    // so does a WebSocket a page closes as it goes.
    if (info.status === info.expectedStatus) {
      const real = errors.filter((e) => !/wrong session code|WebSocket|status of 422/.test(e));
      assert.deepEqual(real, [], 'no page errors');
    }
  },
});

// ---- Helpers that several files share ----

/** Controls are looked up inside their layer's card: layers may share control names. */
const layerCard = (page, name) => page.locator('.layer-card', { hasText: name });

/** The controller: a layer is a button; pressing it opens the layer, pressing it again closes it. */
async function controller(studio, address = '/tv') {
  const tv = await studio.open(address, { width: 1920, height: 1080 });
  const press = async (name, on) => {
    const button = tv.locator('.layer-button', { hasText: name });
    if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
    await tv.locator(`.layer-button[aria-pressed="${on}"]`, { hasText: name }).waitFor();
  };
  return { tv, press };
}

/** The dev surface, which draws the table, and a wait for the scene to start moving. */
async function devSurface(studio) {
  const dev = await studio.open('/dev', { width: 1500, height: 800 });
  const table = dev.locator('.table-surface');
  await table.locator('canvas').first().waitFor();
  return { dev, table };
}

/** A tap on Sunlight's sky moves the sun to `hour` (#137). */
async function scrub(tv, hour) {
  const box = await tv.locator('.sun-hero').boundingBox();
  const rem = await tv.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const [x0, x1] = [box.x + 8.5 * rem, box.x + box.width - 3.5 * rem];
  await tv.mouse.click(x0 + ((x1 - x0) * hour) / 24, box.y + box.height - 2 * rem);
}

/** A phone that joined with the session code, and a way to open one of its layers. */
async function phoneJoined(studio) {
  const phone = await studio.open(`/phone?c=${studio.code}`, { width: 390, height: 800 });
  const openApp = async (name) => {
    if (await phone.locator('.layer-card.is-open').count()) await phone.getByRole('button', { name: 'Back to all layers' }).click();
    await phone.getByRole('button', { name: `Open ${name}` }).click();
    await phone.locator('.layer-card.is-open', { hasText: name }).waitFor();
  };
  await phone.locator('.phone-badge').waitFor();
  return { phone, openApp };
}

/** The phone's visitor names it and picks the whale (#339). */
async function namePhone(phone, name) {
  await phone.getByRole('button', { name: 'Change your name or animal' }).click();
  await phone.getByRole('radio', { name: 'Whale' }).click();
  await phone.getByLabel('Your name', { exact: true }).fill(name);
}

module.exports = { test, assert, root, kit, mod, until, layerCard, controller, devSurface, scrub, phoneJoined, namePhone };
