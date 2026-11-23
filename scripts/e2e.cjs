// End-to-end check in a real browser: the host, the engine, the surfaces, the core layers,
// the ambient scene, the scene composer, the editor,
// and a phone joining by QR code, using its tools and coming back after a reload.
//   pnpm build && cargo build -p mrs-cli && node scripts/e2e.cjs [screenshot-dir]
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const jsQR = require('jsqr');

const root = path.resolve(__dirname, '..');
const port = 4199;
const base = `http://127.0.0.1:${port}`;
const shots = process.argv[2];

// The 3 x 4 matrix of a test projector for a 1500 x 800 image (see docs/contracts/model.md).
const PROJECTOR = [1242.805279, 295.385556, -503.172347, 720252.706881, -99.105566, -449.278568, -1134.560204, 408103.300056, 0.159737, 0.724142, -0.670896, 966.942839];

/** A surface without a browser: joins the session over the WebSocket and sends requests. */
function join(role) {
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

async function main() {
  // The composer rewrites site.json, so the test runs on a copy of the sample site.
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-e2e-'));
  fs.cpSync(path.join(root, 'sites/sample'), site, { recursive: true });
  const savedLayers = () => JSON.parse(fs.readFileSync(path.join(site, 'site.json'), 'utf8')).layers;
  const host = spawn(
    path.join(root, 'target/debug/mrstudio'),
    ['dev', '--site', site, '--web', 'packages/runtime/dist', '--port', String(port), '--backend', 'cpu', '--public-url', base],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  host.stdout.on('data', (d) => (log += d));
  host.stderr.on('data', (d) => (log += d));
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  try {
    for (let i = 0; !/host listening/.test(log); i++) {
      if (i > 100 || host.exitCode !== null) throw new Error(`host did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const code = /session code (\d+)/.exec(log)[1];
    const errors = [];
    // Base map tiles come from the internet, which a test does not reach: every tile is a plain light square.
    const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAB/0lEQVR42u3TsQkAAAgEsd9/XMXe2hkMZIKDS/XAW5EAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwAAYQAUMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA4ABwABgADAAGAAMAAYAA2AAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAOogAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAAMAAYAAwABgADgAHAAGAADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgADAAGAAOAAcAAYAAwABgArgUn3irHh0b72wAAAABJRU5ErkJggg==', 'base64');
    const mockTiles = (page) => page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) => route.fulfill({ contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: tile }));
    const open = async (url, viewport) => {
      const page = await browser.newPage({ viewport });
      await mockTiles(page);
      page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && errors.push(`${url}: ${m.text()}`));
      await page.goto(base + url);
      return page;
    };

    // Controls are looked up inside their layer's card: layers may share control names.
    const sunlight = (page) => page.locator('.layer-card', { hasText: 'Sunlight' });

    // The dev surface renders the scene in site.json: a dark base map with ambient layers that move.
    const dev = await open('/dev', { width: 1500, height: 800 });
    const table = dev.locator('.table-surface');
    const unmoved = async () => {
      const first = await table.screenshot();
      await dev.waitForTimeout(400);
      return first.equals(await table.screenshot());
    };
    // The layers load their data first, so give the scene a few seconds to start moving.
    let ambient = false;
    for (let i = 0; i < 20 && !ambient; i++) ambient = !(await unmoved());
    assert.ok(ambient, 'the ambient scene should be moving');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-ambient.png') });

    // Sunlight is in the scene but off; the TV turns it on.
    const tv = await open('/tv', { width: 1920, height: 1080 });
    // On the controller a layer is a button: pressing it opens the layer, pressing it again closes it.
    const press = async (name, on) => {
      const button = tv.locator('.layer-button', { hasText: name });
      if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
      await tv.locator(`.layer-button[aria-pressed="${on}"]`, { hasText: name }).waitFor();
    };
    // The map's ambient layers have no button there, and unplaced buttons are shared out over both sides.
    assert.equal(await tv.locator('.layer-button', { hasText: 'Traffic' }).count(), 0);
    const leftButtons = await tv.locator('.controller:not(.controller-right) .layer-button-card').count();
    const rightButtons = await tv.locator('.controller-right .layer-button-card').count();
    assert.ok(rightButtons > 0 && leftButtons >= rightButtons && leftButtons - rightButtons <= 1, `buttons ${leftButtons} left, ${rightButtons} right`);
    await press('Sunlight', true);
    // The table is running Sunlight: it publishes the colour key the dashboard shows.
    await dev.locator('[data-panel="sunlight/key"]', { hasText: 'Shade' }).waitFor();
    await dev.waitForTimeout(500);
    const afternoon = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-shadows.png') });

    // A change made on the TV reaches the host, the engine and the dev surface. On the controller the time
    // is set on Sunlight's hero: the sky is the timeline, and a tap or a drag on it moves the sun (#137).
    const clock = '.sun-hero-clock b';
    const scrub = async (hour) => {
      const box = await tv.locator('.sun-hero').boundingBox();
      const rem = await tv.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      const [x0, x1] = [box.x + 8.5 * rem, box.x + box.width - 3.5 * rem];
      await tv.mouse.click(x0 + ((x1 - x0) * hour) / 24, box.y + box.height - 2 * rem);
    };
    await scrub(8.5);
    await tv.locator(clock, { hasText: '08:30' }).waitFor();
    await sunlight(dev).locator('.control-value', { hasText: '8.50 h' }).waitFor();
    // The sun comes from the east at half past eight on midsummer morning.
    await tv.locator('.sun-hero-fact b', { hasText: /^east$/ }).waitFor();
    await dev.waitForTimeout(500);
    const morning = await table.screenshot();
    assert.notDeepEqual(morning, afternoon, 'shadows should move when the time changes');
    // The open layer is its hero, its main choices and "More settings", closed.
    assert.equal(await sunlight(tv).locator('.controls-primary [role="radio"]', { hasText: 'Midsummer' }).count(), 1);
    assert.equal(await sunlight(tv).getByText('Opacity').isVisible(), false, 'the finer settings wait behind More settings');
    // The TV is a rail of controls beside the dashboard canvas, and the layer's panels sit on the grid.
    // The hero shows the time, so Sunlight brings two panels (tree shade and the colour key) and the sketch layer one.
    assert.equal(await tv.locator('.mrs-panel').count(), 3);
    // Under the hero the canvas is short, so it has fewer rows, not tiny text (#137): the titles stay
    // readable, all three panels share the one page, and nothing spills out of its panel.
    const fit = await tv.evaluate(() => ({
      title: Math.min(...[...document.querySelectorAll('.mrs-panel-title')].map((t) => parseFloat(getComputedStyle(t).fontSize))),
      shown: [...document.querySelectorAll('.mrs-panel')].filter((p) => p.closest('.mrs-page:not([hidden])')).length,
      spills: [...document.querySelectorAll('.mrs-panel-body')].filter((b) => b.scrollHeight > b.clientHeight + 1).length,
    }));
    assert.ok(fit.title >= 16, `panel titles are ${fit.title}px`);
    assert.deepEqual([fit.shown, fit.spills], [3, 0]);
    const band = await tv.locator('[data-panel="sunlight/key"]').boundingBox();
    const canvas = await tv.locator('.mrs-dash').boundingBox();
    assert.ok(band.width > canvas.width * 0.9 && band.y + band.height > canvas.y + canvas.height * 0.9, 'the colour key spans the bottom row');
    assert.equal(await tv.locator('.mrs-issues').isVisible(), false);
    if (shots) await tv.screenshot({ path: path.join(shots, 'tv-shadows.png') });
    // Reset, the dashed button at the foot of the rail, closes the open layer and shows the welcome.
    // The sketch tool, kept alongside for the phones, stays on. About is there only when the site has words for it.
    await tv.locator('.action-button[title="Reset"]').click();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Sunlight' }).waitFor();
    await tv.locator('.layer-welcome:not([hidden])').waitFor();
    assert.equal(await tv.locator('.layer-button[aria-pressed="true"]', { hasText: 'Sketch' }).count(), 1);
    assert.equal(await tv.locator('.action-button[title="About"]').count(), 0);
    await press('Sunlight', true);

    // Sun hours accumulate progressively and finish.
    await tv.getByRole('radio', { name: 'Sun hours' }).click();
    await dev.getByText('whole day added up').waitFor({ timeout: 120_000 });
    // The hero follows the mode: it counts the day's daylight and has no time to set; the daylight panel arrives.
    await tv.locator(clock, { hasText: / h$/ }).waitFor();
    assert.equal(await tv.locator('.sun-hero-play').isVisible(), false);
    await tv.locator('[data-panel="sunlight/daylight"]').waitFor();
    if (shots) await tv.screenshot({ path: path.join(shots, 'tv-sun-hours.png') });
    await dev.waitForTimeout(500);
    const day = await table.screenshot();
    assert.notDeepEqual(day, morning, 'sun hours should look different from shadows');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-sun-hours.png') });

    // Turning the layer off clears the table.
    await press('Sunlight', false);
    await dev.locator('.layer-card:not(.is-active)', { hasText: 'Sunlight' }).waitFor();
    await dev.waitForTimeout(500);
    const off = await table.screenshot();
    assert.notDeepEqual(off, day, 'the overlay should disappear when the layer is off');
    await press('Sunlight', true);
    await tv.getByRole('radio', { name: 'Shadows' }).click();

    // The TV invites phones with a QR code. Read it the way a phone camera would.
    const pixels = await tv.locator('.join-qr svg').evaluate(async (svg) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 330;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 330, 330);
      return Array.from(context.getImageData(0, 0, 330, 330).data);
    });
    const scanned = jsQR(Uint8ClampedArray.from(pixels), 330, 330)?.data;
    assert.equal(scanned, `${base}/phone?c=${code}`, 'the QR code carries the join address');

    // Without the right code a phone gets the code form, not the controls.
    const stranger = await open(`/phone?c=${code === '0000' ? '1111' : '0000'}`, { width: 390, height: 800 });
    await stranger.getByText('That code did not work').waitFor();

    // A phone that scanned the code sees only phone controls and cannot switch layers.
    const phone = await open(scanned.slice(base.length), { width: 390, height: 800 });
    await sunlight(phone).getByLabel('Time of day').waitFor();
    await phone.getByText('You are 1').waitFor();
    assert.equal(await phone.getByLabel('Turn Sunlight on or off').count(), 0);
    assert.equal(await phone.getByText('Opacity').count(), 0);
    await tv.getByText('1 phone', { exact: true }).waitFor();
    await sunlight(phone).getByLabel('Time of day').fill('18');
    await tv.locator(clock, { hasText: '18:00' }).waitFor();
    // The controller's sky follows the phone: at six in the evening the sun is in the west.
    await tv.locator('.sun-hero-fact b', { hasText: /^west$/ }).waitFor();

    // Phone tools: a point, a line and an area drawn on the small map arrive on the table.
    const pad = phone.locator('.tool-map');
    // The sketch card is above Sunlight's, so the pad is found again for each tap: the page may have scrolled.
    const tap = async (u, v) => {
      await pad.scrollIntoViewIfNeeded();
      const box = await pad.boundingBox();
      await phone.mouse.click(box.x + u * box.width, box.y + v * box.height);
    };
    const before = await table.screenshot();
    await tap(0.5, 0.5);
    // The sketch's panel counts the marks (#137: a stat tile, which fits its tile at any canvas height).
    const marks = (n) => tv.locator('[data-panel$="/marks"] .mrs-number', { hasText: new RegExp(`^${n}$`) }).waitFor();
    await marks(1);
    await dev.waitForTimeout(500);
    const marked = await table.screenshot();
    assert.notDeepEqual(marked, before, 'the point should be drawn on the table');

    await phone.getByRole('radio', { name: 'Route' }).click();
    assert.equal(await phone.getByRole('button', { name: 'Send line' }).isDisabled(), true, 'a line needs two points');
    await tap(0.2, 0.3);
    await tap(0.4, 0.7);
    await tap(0.6, 0.3);
    await phone.getByRole('button', { name: 'Undo' }).click();
    await tap(0.7, 0.4);
    await phone.getByRole('button', { name: 'Send line' }).click();
    await phone.getByText('Sent to the table.').waitFor();
    await marks(2);

    await phone.getByRole('radio', { name: 'Area' }).click();
    await tap(0.75, 0.6);
    await tap(0.95, 0.6);
    await tap(0.85, 0.9);
    if (shots) await phone.screenshot({ path: path.join(shots, 'phone.png') });
    await phone.getByRole('button', { name: 'Send area' }).click();
    await marks(3);
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), marked, 'the line and the area should be drawn too');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-sketch.png') });

    // A second phone types the code instead of scanning, and gets the next slot.
    const typist = await open('/phone', { width: 390, height: 800 });
    await typist.getByLabel('Session code').fill(code);
    await typist.getByRole('button', { name: 'Join' }).click();
    await typist.getByText('You are 2').waitFor();
    await tv.getByText('2 phones').waitFor();

    // A reload brings the first phone back to its own slot instead of a third one.
    await phone.reload();
    await phone.getByText('You are 1').waitFor();
    await tv.getByText('2 phones').waitFor();
    assert.equal(await tv.locator('.join-person').count(), 2);
    if (shots) await tv.screenshot({ path: path.join(shots, 'tv.png') });

    // The TV clears the sketch, from the sketch's More settings.
    await tv.locator('.layer-open', { hasText: 'Mark places' }).locator('summary', { hasText: 'More settings' }).click();
    await tv.getByRole('button', { name: 'Clear the sketch' }).click();
    await marks(0);


    // ---- The model surface ----

    // The sample site lights the twin, so the flat map is laid over it rather than shown on its own.
    await dev.locator('.table-surface.is-draped canvas.table-model').waitFor();
    // With the lighting off the table is the flat map again, and looks different.
    await scrub(15);
    await tv.locator(clock, { hasText: '15:00' }).waitFor();
    await dev.waitForTimeout(800);
    const relit = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-relit.png') });
    // The lighting switch is one of Sunlight's finer settings.
    await sunlight(tv).locator('summary', { hasText: 'More settings' }).click();
    await tv.getByLabel('Light the 3D model').uncheck();
    await dev.locator('.table-surface:not(.is-draped)').waitFor();
    await dev.waitForTimeout(800);
    assert.notDeepEqual(await table.screenshot(), relit, 'relighting should change the table');
    await tv.getByLabel('Light the 3D model').check();

    // The projected table takes up a projector calibration the moment the host has one.
    const projected = await open('/table', { width: 1500, height: 800 });
    await projected.locator('canvas.table-model').waitFor();
    await projected.waitForTimeout(1500);
    const flat = await projected.screenshot();
    const controller = await join('dev');
    // A projector above and to the south of the model, looking down at it at an angle.
    const projector = { version: 1, matrix: PROJECTOR, image: { width: 1500, height: 800 }, pairs: [], error_px: 0, camera: {} };
    await controller.request('calibration.set', { projector });
    await projected.locator('.table-surface.is-projector').waitFor();
    await projected.waitForTimeout(1500);
    assert.notDeepEqual(await projected.screenshot(), flat, 'the calibrated table should show the twin through the projector');
    if (shots) await projected.screenshot({ path: path.join(shots, 'table-projector.png') });
    // The dev surface stays a flat preview.
    assert.equal(await dev.locator('.table-surface.is-projector').count(), 0);

    // Any controller can open the calibration tool on the table. It starts from a dark surface and counts corners.
    await controller.request('calibration.mode', { active: true });
    await projected.getByText('Corner 1 of 10').waitFor();
    await projected.mouse.click(300, 200);
    await projected.getByText('1 of at least 6 corners placed.').waitFor();
    if (shots) await projected.screenshot({ path: path.join(shots, 'table-calibrating.png') });
    await projected.keyboard.press('Escape');
    await projected.locator('.table-surface.is-projector:not(.is-calibrating)').waitFor();
    assert.equal(await projected.locator('.calibration').count(), 0);
    // The dev surface opened its preview of the tool too; close it for the layers that follow.
    await controller.request('calibration.mode', { active: false });
    await dev.locator('.calibration').waitFor({ state: 'detached' });

    // Clearing the calibration brings the flat table back.
    await controller.request('calibration.set', { projector: null });
    await projected.locator('.table-surface:not(.is-projector)').waitFor();
    controller.close();


    // CoolPaths: routes over the site's walkways, costed by the engine's shade.
    const card = (name) => tv.locator('.layer-card', { hasText: name });
    await press('Sunlight', false);
    await press('Cool paths', true);
    const cool = card('Cool paths');
    // A layer's own panel sits on the dashboard canvas; its controls stay in its card.
    const coolPanel = tv.locator('[data-panel="coolpaths/walks"]');
    await coolPanel.getByText(/less sun|already the coolest/).waitFor();
    // Its drawing starts under its title, never over it (#137).
    const [coolTitle, coolBody] = await Promise.all([coolPanel.locator('.mrs-panel-title').boundingBox(), coolPanel.locator('.coolpaths-head').boundingBox()]);
    assert.ok(coolBody.y >= coolTitle.y + coolTitle.height, 'the walks sit under the panel title');
    await dev.waitForTimeout(500);
    const walk = await table.screenshot();
    assert.notDeepEqual(walk, off, 'the network and routes should be drawn');
    assert.match(await coolPanel.locator('[data-route="shortest"] .coolpaths-length').textContent(), /^\d+ m$/);
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-coolpaths.png') });
    // A phone may ask for another walk, and the table answers with a different one.
    await phone.getByRole('button', { name: 'Try another walk' }).click();
    await dev.waitForTimeout(800);
    assert.notDeepEqual(await table.screenshot(), walk, 'another walk should be drawn');
    // With no detour allowed the coolest walk is the shortest one.
    await cool.getByLabel('Longest detour').fill('0');
    await coolPanel.getByText('the shortest walk is already the coolest').waitFor();
    // At night there is no sun to avoid.
    await cool.getByLabel('Time of day').fill('1');
    await coolPanel.getByText(/the sun is down/).waitFor();
    await coolPanel.getByText(/^0 m sun,/).first().waitFor();
    await press('Cool paths', false);

    // Mobility: the site's trips played over time.
    await press('Mobility', true);
    const moving = card('Mobility');
    const movingPanel = tv.locator('[data-panel="mobility/panel"]');
    await movingPanel.getByText(/of 60 arrived/).first().waitFor();
    await moving.getByLabel('Play', { exact: true }).uncheck();
    await moving.getByLabel('Time', { exact: true }).fill('0');
    await movingPanel.getByText('0 of 60 arrived').first().waitFor();
    await dev.waitForTimeout(500);
    const start = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-mobility.png') });
    await moving.getByLabel('Time', { exact: true }).fill('100');
    await movingPanel.getByText('60 of 60 arrived').nth(1).waitFor();
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), start, 'travellers should move with the time');
    await press('Mobility', false);


    // Wind: the simulation streams while it settles, tracers move, and a faster wind only rescales.
    await press('Sunlight', false);
    await dev.waitForTimeout(500);
    const calm = await table.screenshot();
    await press('Wind', true);
    await tv.getByText(/Settling, \d+%|Steady/).waitFor({ timeout: 60_000 });
    await dev.getByText(/Fastest spot [\d.]+ m\/s/).waitFor({ timeout: 120_000 });
    const windy = await table.screenshot();
    assert.notDeepEqual(windy, calm, 'wind should draw on the table');
    await dev.waitForTimeout(300);
    assert.notDeepEqual(await table.screenshot(), windy, 'tracers should keep moving');
    await tv.getByLabel('Wind speed').fill('10');
    await dev.getByText('10 m/s', { exact: true }).waitFor();
    await tv.getByLabel('Wind from').fill('180');
    await dev.getByText('from the south').waitFor();
    await tv.getByRole('radio', { name: 'Speed map' }).click();
    await dev.waitForTimeout(500);
    const still = await table.screenshot();
    await dev.waitForTimeout(100);
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-wind.png') });
    await tv.getByRole('radio', { name: 'Ribbons' }).click();
    await dev.waitForTimeout(1500);
    assert.notDeepEqual(await table.screenshot(), still, 'ribbons should come back');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-wind-ribbons.png') });
    await press('Wind', false);


    // ---- The scene composer ----
    // The pages that are done with are closed first: every open table costs rendering time.
    for (const page of [stranger, phone, typist, projected]) await page.close();
    // Tall enough that the whole stack is on screen while one layer's settings are open.
    const compose = await open('/compose', { width: 1700, height: 1200 });
    const stage = compose.locator('.table-surface');
    const rows = () => compose.locator('.stack-row strong').allTextContents();
    await compose.locator('.palette-group', { hasText: 'Analysis' }).getByText('Sunlight').waitFor();
    assert.deepEqual(await rows(), ['Wind', 'Mobility', 'Cool paths', 'Sketch', 'Slideshow', 'Trees', 'Public transport', 'Traffic', 'Building lights', 'Sunlight', 'Base map']);
    const drag = async (from, to, where = 0.5) => {
      const a = await from.boundingBox();
      const b = await to.boundingBox();
      await compose.mouse.move(a.x + 12, a.y + a.height / 2);
      await compose.mouse.down();
      await compose.mouse.move(a.x + 40, a.y + a.height / 2 + 10, { steps: 3 });
      await compose.mouse.move(b.x + b.width / 2, b.y + b.height * where, { steps: 8 });
      await compose.mouse.up();
    };
    const row = (name) => compose.locator('.stack-row', { has: compose.getByText(name, { exact: true }) });

    // Pressing + adds a second copy of a layer on top, under its own id, and saves it.
    await compose.getByLabel('Add Traffic').click();
    await row('Traffic (cars-2)').waitFor();
    assert.deepEqual(savedLayers().at(-1), { use: 'cars', id: 'cars-2', active: true });

    // Its settings form is generated from the manifest, and what it changes is saved.
    await compose.getByLabel('Cars per kilometre of street').fill('25');
    await compose.waitForFunction(() => true);
    await assert.doesNotReject(async () => {
      for (let i = 0; savedLayers().at(-1).params?.density !== 25; i++) {
        if (i > 50) throw new Error('density was not saved');
        await compose.waitForTimeout(100);
      }
    });

    // Dragging from the palette into the stack adds a layer at that place.
    await drag(compose.locator('.palette-item[data-layer="trees"]'), row('Base map'), 0.9);
    await row('Trees (trees-2)').waitFor();
    assert.equal(savedLayers()[0].id, 'trees-2', 'dropped below the base map, so first in site.json');

    // Draw order follows the list: with the opaque base map on top, nothing below shows through.
    await compose.getByLabel('Show Slideshow').waitFor();
    await drag(row('Base map').locator('.stack-head'), row('Traffic (cars-2)'), 0.05);
    await compose.waitForFunction(() => document.querySelector('.stack-row strong')?.textContent === 'Base map');
    assert.equal(savedLayers().at(-1).use, 'basemap');
    await compose.waitForTimeout(600);
    // The outermost pixels are left out: a quad's edge is blended with what is under it.
    const inner = async () => {
      const box = await stage.boundingBox();
      return compose.screenshot({ clip: { x: box.x + 4, y: box.y + 4, width: box.width - 8, height: box.height - 8 } });
    };
    const covered = await inner();
    await compose.waitForTimeout(400);
    assert.ok(covered.equals(await inner()), 'the base map on top should hide the moving layers');
    await drag(row('Base map').locator('.stack-head'), row('Trees (trees-2)'), 0.9);
    await compose.waitForFunction(() => [...document.querySelectorAll('.stack-row strong')].at(-1)?.textContent === 'Base map');
    assert.equal(savedLayers()[0].use, 'basemap');
    await compose.waitForTimeout(600);
    assert.ok(!covered.equals(await inner()), 'with the base map at the bottom the scene shows again');

    // The eye switch and the remove button.
    await compose.getByLabel('Show Slideshow').check();
    await tv.getByText('What the buildings are used for').waitFor();
    if (shots) await compose.screenshot({ path: path.join(shots, 'compose.png') });
    await compose.getByLabel('Show Slideshow').uncheck();
    await compose.getByLabel('Remove Traffic (cars-2)').click();
    await compose.getByLabel('Remove Trees (trees-2)').click();
    await row('Trees (trees-2)').waitFor({ state: 'detached' });
    assert.deepEqual(savedLayers().map((l) => l.id ?? l.use), ['basemap', 'sunlight', 'building-lights', 'cars', 'transit', 'trees', 'slideshow', 'sketch', 'coolpaths', 'mobility', 'wind']);

    // ---- The editor ----
    await compose.close();
    const editor = await open('/edit', { width: 1440, height: 900 });
    const treeLayers = () => editor.locator('.ed-tree .ed-row[data-layer] .ed-row-label').allTextContents();
    await editor.locator('.ed-row[data-context="home"]').waitFor();
    assert.deepEqual(await treeLayers(), ['Wind', 'Mobility', 'Cool paths', 'Sketch', 'Slideshow', 'Sunlight']);
    // The home screen holds the base map and the ambient life, and offers more of it.
    assert.deepEqual(await editor.locator('.ed-inspector .ed-row .ed-row-label').allTextContents(), ['Trees', 'Public transport', 'Traffic', 'Building lights', 'Base map']);
    await editor.locator('.ed-ribbon .ed-tool[data-layer="trees"]').click();
    await editor.locator('.ed-inspector .ed-row[data-layer="trees-2"][aria-current="true"]').waitFor();
    // Ambient life joins the home screen, under the layers.
    assert.equal(savedLayers()[6].id, 'trees-2');
    // Its settings open in the inspector and are saved.
    await editor.getByLabel('Shown on the map').uncheck();
    await editor.waitForFunction(() => document.querySelector('.ed-inspector .ed-row[data-layer="trees-2"]')?.classList.contains('is-off'));
    assert.equal(savedLayers()[6].active, false);
    // The ribbon's tools act on what is selected.
    await editor.locator('.ed-ribbon').getByText('Send back').click();
    await editor.waitForFunction(() => document.querySelectorAll('.ed-inspector .ed-row[data-layer]')[1]?.getAttribute('data-layer') === 'trees-2');
    assert.equal(savedLayers()[5].id, 'trees-2');
    await editor.locator('.ed-ribbon').getByText('Remove').click();
    await editor.locator('.ed-inspector .ed-row[data-layer="trees-2"]').waitFor({ state: 'detached' });
    // Inside a layer the ambient tools add into that layer: an item that shows only while it is open (#69).
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    await editor.locator('.ed-ribbon .ed-tool[data-layer="trees"]').click();
    await editor.locator('.ed-tree .ed-row.is-item[data-layer="trees-2"][aria-current="true"]').waitFor();
    await editor.locator('.ed-inspector [data-items="mobility"] .ed-row[data-layer="trees-2"]').waitFor();
    assert.deepEqual(savedLayers().find((l) => l.id === 'mobility').items, [{ use: 'trees', id: 'trees-2' }]);
    assert.ok(!savedLayers().some((l) => l.id === 'trees-2'), 'an item is not a layer of the scene');
    await editor.getByLabel('Comes on with the layer').waitFor();
    await editor.locator('.ed-ribbon').getByText('Remove').click();
    await editor.locator('.ed-tree .ed-row[data-layer="trees-2"]').waitFor({ state: 'detached' });
    assert.equal(savedLayers().find((l) => l.id === 'mobility').items, undefined);
    await editor.locator('.ed-ribbon .ed-tool[data-layer="sunlight"]').waitFor();
    await editor.locator('.ed-inspector').getByText('Show trips').waitFor();
    // The eye beside a setting takes that control off the controller, and it is saved. The editor keeps it.
    await editor.getByRole('switch', { name: 'Show Show trips on the controller' }).click();
    await editor.waitForFunction(() => document.querySelector('.ed-eye[aria-label="Show Show trips on the controller"]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(savedLayers().find((l) => l.use === 'mobility').hide, ['trips']);
    await press('Mobility', true);
    assert.equal(await card('Mobility').getByText('Show trips').isVisible(), false);
    assert.equal(await card('Mobility').getByLabel('Play', { exact: true }).isVisible(), true);
    await editor.getByRole('switch', { name: 'Show Show trips on the controller' }).click();
    await card('Mobility').getByText('Show trips').waitFor();
    assert.equal(savedLayers().find((l) => l.use === 'mobility').hide, undefined);
    // A layer's button on the controller: name, description, side and icon, saved with the scene.
    await editor.getByLabel('Name').fill('Getting here');
    await editor.getByLabel('Name').blur();
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"] .ed-row-label', { hasText: 'Getting here' }).waitFor();
    await editor.getByLabel('Description').fill('How people reach the square');
    await editor.getByLabel('Description').blur();
    await editor.getByRole('radiogroup', { name: 'Side of the controller' }).getByText('Right').click();
    await editor.getByRole('radiogroup', { name: 'Icon' }).getByLabel('tram').click();
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"] .ed-row-side', { hasText: 'Right' }).waitFor();
    await editor.locator('.ed-canvas-head strong', { hasText: 'Getting here' }).waitFor();
    const named = { name: 'Getting here', description: 'How people reach the square', side: 'right', icon: 'tram' };
    await editor.waitForFunction(() => document.querySelector('.ed-icon-choice[aria-label="tram"]')?.getAttribute('aria-checked') === 'true');
    assert.deepEqual(savedLayers().find((l) => l.use === 'mobility').button, named);
    // The controller goes by the same words.
    await tv.locator('.controller-right .layer-button', { hasText: 'Getting here' }).waitFor();
    // A group puts the button under the group's name on its rail.
    await editor.getByLabel('Group').fill('Movement');
    await editor.getByLabel('Group').blur();
    await tv.locator('.controller-right .rail-group', { hasText: 'Movement' }).waitFor();
    assert.equal(savedLayers().find((l) => l.use === 'mobility').button.group, 'Movement');
    // Opening a layer closes the one that was open, except a layer made to run alongside.
    await press('Sunlight', true);
    // The editor shows the live controller beside the map, and follows a press on it.
    await editor.locator('.ed-tree .ed-row[data-layer="sunlight"][aria-current="true"]').waitFor();
    await editor.frameLocator('.ed-preview iframe').locator('.layer-open-name', { hasText: 'Sunlight' }).waitFor();
    await press('Getting here', true);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"][aria-current="true"]').waitFor();
    await tv.getByText('How people reach the square').waitFor();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Sunlight' }).waitFor();
    await tv.locator('.layer-button[aria-pressed="true"]', { hasText: 'Sketch' }).waitFor();
    if (shots) await tv.screenshot({ path: path.join(shots, 'tv-buttons.png') });
    // There is no Home button: pressing the open layer again closes it, and the editor goes back to the map at rest.
    assert.equal(await tv.getByRole('button', { name: 'Home', exact: true }).count(), 0);
    await tv.locator('.layer-button', { hasText: 'Getting here' }).click();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Getting here' }).waitFor();
    await editor.locator('.ed-row[data-context="home"][aria-current="true"]').waitFor();
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    if (shots) await editor.screenshot({ path: path.join(shots, 'editor.png') });
    await editor.getByLabel('Name').fill('');
    await editor.getByLabel('Name').blur();
    await editor.getByLabel('Description').fill('');
    await editor.getByLabel('Description').blur();
    await editor.getByLabel('Group').fill('');
    await editor.getByLabel('Group').blur();
    await tv.locator('.rail-group').first().waitFor({ state: 'detached' });
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"] .ed-row-label', { hasText: 'Mobility' }).waitFor();
    await tv.locator('.controller-right .layer-button', { hasText: 'Mobility' }).waitFor();
    assert.deepEqual(savedLayers().map((l) => l.id ?? l.use), ['basemap', 'sunlight', 'building-lights', 'cars', 'transit', 'trees', 'slideshow', 'sketch', 'coolpaths', 'mobility', 'wind']);

    // A refused file answers 422, which the browser logs on its own.
    const real = errors.filter((e) => !/wrong session code|WebSocket|status of 422/.test(e));
    assert.deepEqual(real, [], 'no page errors');
    // ---- The setup wizard ----
    // A new table opens in the guide; here it runs on the sample, whose name and place are already set.
    const guide = await open('/edit?welcome=1', { width: 1440, height: 900 });
    // It starts with the place itself: the files the table is made from. The host checks a file, then brings it in.
    await guide.locator('.wz h2', { hasText: 'Your place' }).waitFor();
    await guide.getByRole('button', { name: 'Close guide' }).waitFor();
    // Back reaches the table's name and place, which can be changed: the table moves and every surface starts again.
    await guide.getByRole('button', { name: 'Back' }).click();
    await guide.locator('.wz h2', { hasText: 'Name and place' }).waitFor();
    assert.equal(await guide.getByRole('button', { name: 'Back' }).isDisabled(), true);
    assert.equal(await guide.getByLabel('Name').inputValue(), 'Sample district');
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.locator('.wz h2', { hasText: 'Your place' }).waitFor();
    await guide.locator('.wz-step button', { hasText: 'Name and place' }).click();
    await guide.getByLabel('Name').fill('Sample square');
    // The sample's ground is a raw height grid made for its extent, so it cannot move; the guide says why and stays.
    await guide.getByLabel('Width, metres').fill('800');
    await guide.getByRole('button', { name: 'Move the table' }).click();
    await guide.getByRole('alert').getByText(/GeoTIFF/).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'site.json'), 'utf8')).name, 'Sample district', 'a refused move writes nothing');
    // A new name alone is fine.
    await guide.getByLabel('Width, metres').fill('1000');
    await guide.getByRole('button', { name: 'Move the table' }).click();
    await guide.waitForFunction(() => document.querySelector('.wz h2')?.textContent === 'Your place' && document.querySelector('.ed-name strong')?.textContent === 'Sample square');
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'site.json'), 'utf8')).name, 'Sample square');
    // The controller screen has no header in its rails any more; it carries the site's name in its title.
    await tv.waitForFunction(() => document.title.endsWith('· Sample square'));
    assert.equal(await guide.locator('.wz-place[data-target="buildings"] .wz-state').textContent(), 'On the table');
    await guide.getByLabel('File for Trees').setInputFiles(path.join(site, 'data', 'trees.geojson'));
    await guide.locator('.wz-place[data-target="trees"] .wz-summary', { hasText: /trees/ }).waitFor();
    if (shots) await guide.screenshot({ path: path.join(shots, 'wizard-place.png') });
    const written = fs.statSync(path.join(site, 'data', 'trees.geojson')).mtimeMs;
    await guide.getByRole('button', { name: 'Add to the table' }).click();
    // Every surface starts again with the new data, and the guide comes back where it was.
    await guide.waitForFunction(() => !document.querySelector('.wz-report') && document.querySelector('.wz h2')?.textContent === 'Your place');
    await guide.locator('.wz-place[data-target="trees"] .wz-state', { hasText: 'On the table' }).waitFor();
    assert.ok(fs.statSync(path.join(site, 'data', 'trees.geojson')).mtimeMs > written, 'the file is written into the table');
    // A file that is not what was asked for is refused with a reason, and nothing is written.
    await guide.getByLabel('File for Buildings').setInputFiles(path.join(site, 'data', 'trees.geojson'));
    await guide.locator('.wz-place[data-target="buildings"] .wz-issue.is-blocker').waitFor();
    assert.equal(await guide.locator('.wz-place[data-target="buildings"]').getByRole('button', { name: 'Add to the table' }).isDisabled(), true);
    await guide.locator('.wz-place[data-target="buildings"]').getByRole('button', { name: 'Cancel' }).click();
    // A ground file that does not say where it is: the author names its coordinate system, and it is read again.
    const ground = guide.locator('.wz-place[data-target="terrain"]');
    await guide.getByLabel('File for Ground').setInputFiles(path.join(root, 'sites', 'chalmers', 'data', 'terrain.tif'));
    await guide.getByLabel('EPSG code of the file').fill('3006');
    await ground.getByRole('button', { name: 'Read it again' }).click();
    // Read as that system it lies far from this table, and the host says so.
    await ground.locator('.wz-issue.is-blocker', { hasText: /table/ }).waitFor();
    // The code stays in reach, to try another.
    assert.equal(await guide.getByLabel('EPSG code of the file').inputValue(), '3006');
    assert.equal(await ground.getByRole('button', { name: 'Add to the table' }).isDisabled(), true);
    await ground.getByRole('button', { name: 'Cancel' }).click();
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.locator('.wz h2', { hasText: 'At rest' }).waitFor();
    assert.equal(await guide.locator('.wz input[data-layer="trees"]').isChecked(), true);
    // The base map's style is picked right under its row, with its map's credit, and saved (#127).
    await guide.getByLabel('Style').selectOption('light');
    await guide.locator('.wz-style .wz-credit', { hasText: 'Map: © OpenStreetMap contributors' }).waitFor();
    assert.equal(savedLayers().find((l) => l.use === 'basemap').params.style, 'light');
    if (shots) await guide.screenshot({ path: path.join(shots, 'at-rest-light.png') });
    await guide.getByLabel('Style').selectOption('dark');
    await guide.waitForFunction(() => document.querySelector('.wz-style .wz-credit')?.textContent === '');
    await guide.getByRole('button', { name: 'Next' }).click();
    // The building blocks demo is for developers, not offered to authors.
    assert.equal(await guide.locator('.wz input[data-layer="blocks-demo"]').count(), 0);
    // A layer switched off leaves the scene and is saved; switched on it is back, its button on the emptier side.
    await guide.locator('.wz-choice', { hasText: 'Sketch' }).click();
    await guide.waitForFunction(() => document.querySelector('.wz input[data-layer="sketch"]')?.checked === false);
    assert.equal(savedLayers().some((l) => l.use === 'sketch'), false);
    await guide.locator('.wz-choice', { hasText: 'Sketch' }).click();
    await guide.waitForFunction(() => document.querySelector('.wz input[data-layer="sketch"]')?.checked === true);
    assert.equal(savedLayers().at(-1).use, 'sketch');
    assert.ok(['left', 'right'].includes(savedLayers().at(-1).button.side));
    await guide.getByRole('button', { name: 'Next' }).click();
    // Buttons are named beside the live controller.
    const live = guide.frameLocator('.ed-preview iframe');
    await live.locator('.layer-button', { hasText: 'Wind' }).waitFor();
    // A theme picked here restyles the live controller at once and is saved (#126). Midnight, the default, clears it.
    const savedTv = () => JSON.parse(fs.readFileSync(path.join(site, 'site.json'), 'utf8')).tv;
    await guide.locator('.wz-theme', { hasText: 'Ocean' }).click();
    await guide.locator('.wz-theme[aria-checked="true"]', { hasText: 'Ocean' }).waitFor();
    await live.locator('html[style*="--bg: #06121f"]').waitFor();
    assert.equal(savedTv().theme_name, 'ocean');
    // A look is more than colours (#126): Minimal dark takes the tiles and panels away on the controller.
    await guide.locator('.wz-theme', { hasText: 'Minimal dark' }).click();
    await live.locator('body[data-density="minimal"][data-rail-look="bare"][data-surface="plain"]').waitFor();
    assert.equal(savedTv().theme_name, 'minimal-dark');
    if (shots) await guide.screenshot({ path: path.join(shots, 'guide-minimal-dark.png') });
    await guide.locator('.wz-theme', { hasText: 'Glass' }).click();
    await live.locator('body[data-surface="glass"][data-density="comfortable"]').waitFor();
    await guide.locator('.wz-theme', { hasText: 'Ocean' }).click();
    await live.locator('html[style*="--bg: #06121f"]').waitFor();
    await guide.locator('.wz-look [role="radio"]', { hasText: 'Icons and names' }).click();
    await live.locator('body[data-rail-style="labelled"]').waitFor();
    assert.equal(savedTv().rail_style, 'labelled');
    await guide.locator('.wz-theme', { hasText: 'Midnight' }).click();
    await guide.locator('.wz-look [role="radio"]', { hasText: /^Icons$/ }).click();
    await live.locator('body[data-rail-style="icons"]').waitFor();
    await guide.waitForFunction(() => document.querySelector('.wz-theme[aria-checked="true"]')?.textContent?.includes('Midnight'));
    assert.equal(savedTv(), undefined, 'the default look leaves no tv settings behind');
    await guide.getByLabel('Name of Wind').fill('Windy corners');
    await guide.getByLabel('Name of Wind').blur();
    await live.locator('.layer-button', { hasText: 'Windy corners' }).waitFor();
    assert.equal(savedLayers().find((l) => l.use === 'wind').button.name, 'Windy corners');
    await guide.getByLabel('Name of Wind').fill('');
    await guide.getByLabel('Name of Wind').blur();
    await live.locator('.layer-button', { hasText: 'Wind' }).waitFor();
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.getByText('6 layers, each a button on the controller').waitFor();
    if (shots) await guide.screenshot({ path: path.join(shots, 'wizard.png') });
    // Leaving the guide lands in the editor, and the guide stays one click away.
    await guide.getByRole('button', { name: 'Fine-tune in the editor' }).click();
    await guide.locator('.ed-tree .ed-row[data-context="home"]').waitFor();
    assert.equal(await guide.locator('.wz').count(), 0);
    // A reload stays in the editor, and the guide's button says it is closed.
    assert.equal(await guide.evaluate(() => location.search.includes('welcome')), false);
    await guide.getByRole('button', { name: 'Setup guide' }).waitFor();
    // A table with its place, its map at rest and its layers has nothing left to ask for.
    assert.equal(await guide.locator('.ed-next').isVisible(), false);
    await guide.getByRole('button', { name: 'Setup guide' }).click();
    await guide.locator('.wz h2', { hasText: 'Name and place' }).waitFor();
    await guide.close();

    // ---- Add data: the same importer as Your place, with the kind of data left to the author ----
    const adder = await open('/edit', { width: 1440, height: 900 });
    await adder.locator('.ed-ribbon').getByText('Add data').click();
    const dialog = adder.locator('dialog.im-dialog');
    // Each kind explains what its file should look like.
    await dialog.locator('.im-example', { hasText: 'GeoJSON polygons' }).waitFor();
    await dialog.getByLabel('What the file holds').selectOption('own');
    await dialog.getByLabel('Name of the dataset').fill('Places');
    await dialog.getByLabel('File for the dataset').setInputFiles(path.join(root, 'samples', 'kit', 'places.geojson'));
    // What was read is drawn against the table's outline before anything is written.
    await dialog.locator('.im-map .im-map-table').waitFor();
    assert.equal(await dialog.locator('.im-map-data circle').count(), 6);
    await dialog.getByRole('button', { name: /^Add (to|and show on) the table$/ }).click();
    await adder.waitForFunction(() => !document.querySelector('dialog.im-dialog'));
    await adder.locator('.ed-tree .ed-row[data-context="home"]').waitFor();
    assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'site.json'), 'utf8')).data.places, 'data/places.geojson');
    // In Your place each row has its "?" and, where OpenStreetMap has the data, a fetch beside the file.
    await adder.getByRole('button', { name: 'Setup guide' }).click();
    await adder.locator('.wz-step button', { hasText: 'Your place' }).click();
    const streets = adder.locator('.wz-place[data-target="data:roads"]');
    await streets.getByRole('button', { name: 'What a streets file looks like' }).click();
    await streets.locator('.im-example', { hasText: 'LineString' }).waitFor();
    assert.equal(await streets.getByRole('button', { name: 'From OpenStreetMap' }).count(), 1);
    assert.equal(await adder.locator('.wz-place[data-target="trips"]').getByRole('button', { name: 'From OpenStreetMap' }).count(), 0);
    await adder.close();

    // The wizard's first step is a page of its own, for a table that does not exist yet. The app creates the table.
    const fresh = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await mockTiles(fresh);
    await fresh.addInitScript(() => {
      window.shellCalls = [];
      window.__TAURI__ = { core: { invoke: async (command, args) => (window.shellCalls.push([command, args]), '/sites/harbour') } };
    });
    await fresh.goto(base + '/new');
    await fresh.getByLabel('Name').fill('Harbour');
    await fresh.getByRole('button', { name: 'Create the table' }).click();
    await fresh.getByRole('alert').getByText(/Paste the coordinates/).waitFor();
    await fresh.getByLabel('Centre of the table').fill('https://www.openstreetmap.org/#map=16/57.7069/11.9386');
    // The table shows on the map, upright as it stands in the room. Turning turns the map under it.
    await fresh.locator('.pm-handle.is-corner').waitFor();
    const centreOf = async (selector) => {
      const box = await fresh.locator(selector).boundingBox();
      return [box.x + box.width / 2, box.y + box.height / 2];
    };
    for (let i = 0; i < 2; i++) await fresh.getByRole('button', { name: 'Turn the map right' }).click();
    assert.equal(await fresh.getByLabel('Turned').inputValue(), '10');
    const [mx, my] = await centreOf('.pm-handle.is-centre');
    const [kx, ky] = await centreOf('.pm-handle.is-corner');
    // The corner is still up and to the right of the middle, at the table's own shape: the outline did not tilt.
    assert.ok(kx > mx && ky < my && Math.abs((kx - mx) / (my - ky) - 1000 / 600) < 0.05, `the table stays upright: ${[mx, my, kx, ky]}`);
    // The scale holds still: a new scale keeps the ground and resizes the table, and the table's
    // width and height each set the ground's at that scale, so the table can have any shape (#128).
    const value = (label) => fresh.getByLabel(label).inputValue();
    await fresh.getByRole('button', { name: '1 : 2 000' }).click();
    assert.deepEqual([await value('Width, metres'), await value('Height, metres'), await value('Table width, cm'), await value('Table height, cm')], ['1000', '600', '50', '30']);
    await fresh.locator('input[name="scale"]').fill('1250');
    await fresh.locator('.wz-scale-words', { hasText: 'The table, 80 × 48 cm, shows 1 000 × 600 m at 1 : 1 250' }).waitFor();
    await fresh.getByLabel('Table height, cm').fill('60');
    assert.deepEqual([await value('Width, metres'), await value('Height, metres'), await fresh.locator('input[name="scale"]').inputValue()], ['1000', '750', '1250']);
    await fresh.getByLabel('Width, metres').fill('1600');
    assert.deepEqual([await value('Table width, cm'), await fresh.locator('input[name="scale"]').inputValue()], ['128', '1250']);
    await fresh.getByLabel('Width, metres').fill('1000');
    await fresh.getByLabel('Height, metres').fill('600');
    assert.deepEqual([await value('Table width, cm'), await value('Table height, cm')], ['80', '48']);
    // 3D-printing tiles: a grid on the map, and a clear problem when they do not fit (#129).
    await fresh.getByLabel('Show 3D-printing tiles').check();
    await fresh.getByLabel('Tile size, cm').fill('16');
    await fresh.locator('.wz-tiles', { hasText: '5 × 3 tiles, 15 to print.' }).waitFor();
    await fresh.getByLabel('Tile size, cm').fill('15');
    await fresh.locator('.wz-tiles .wz-problem', { hasText: 'not a whole number' }).waitFor();
    await fresh.getByRole('button', { name: 'Create the table' }).click();
    await fresh.locator('.wz-form > .wz-problem', { hasText: 'not a whole number' }).waitFor();
    await fresh.getByLabel('Tile size, cm').fill('16');
    if (shots) await fresh.screenshot({ path: path.join(shots, 'new-table-tiles.png') });
    // Dragging the corner in covers less ground, keeping the table's shape.
    await fresh.waitForTimeout(200);
    const [nx, ny] = await centreOf('.pm-handle.is-centre');
    const [cx2, cy2] = await centreOf('.pm-handle.is-corner');
    await fresh.mouse.move(cx2, cy2);
    await fresh.mouse.down();
    await fresh.mouse.move(nx + (cx2 - nx) * 0.7, ny + (cy2 - ny) * 0.7, { steps: 8 });
    await fresh.mouse.up();
    const [grownWidth, grownHeight] = [Number(await fresh.getByLabel('Width, metres').inputValue()), Number(await fresh.getByLabel('Height, metres').inputValue())];
    assert.ok(grownWidth > 600 && grownWidth < 800, `the corner takes the table to 70% of its width, got ${grownWidth}`);
    assert.ok(Math.abs(grownWidth / grownHeight - 1000 / 600) < 0.05, 'the shape is kept');
    if (shots) await fresh.screenshot({ path: path.join(shots, 'new-table-map.png') });
    await fresh.getByLabel('Width, metres').fill('1000');
    await fresh.getByLabel('Height, metres').fill('600');
    await fresh.getByRole('button', { name: 'Create the table' }).click();
    await fresh.waitForFunction(() => window.shellCalls.length === 2);
    assert.deepEqual(await fresh.evaluate(() => window.shellCalls), [
      ['create_site', { site: { name: 'Harbour', lat: 57.7069, lon: 11.9386, width_m: 1000, height_m: 600, rotation_deg: 10, table_width_cm: 80, tile_cm: 16 } }],
      ['open_site', { path: '/sites/harbour', welcome: true }],
    ]);
    await fresh.close();
    assert.deepEqual(await (await fetch(base + '/features.json')).json(), { new_table_wizard: true });

    // Inside the desktop app the editor drives the shell itself: Present becomes Stop presenting.
    const shelled = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await shelled.addInitScript(() => {
      window.shellCalls = [];
      let presenting = false;
      window.__TAURI__ = { core: { invoke: async (command, args) => {
        window.shellCalls.push(command === 'open_view' ? `open_view ${args.role}` : command === 'file_action' ? `file_action ${args.action}` : command);
        if (command === 'present') presenting = true;
        if (command === 'stop_presenting') presenting = false;
        if (command === 'colour_state') return { displays: [{ display: 0, name: 'Projector', role: null, colour: { saturation: 1.4, contrast: 1, brightness: 1, gamma: 1, temperature: 0, tint: 0 } }], presets: [], layers: [] };
        return { presenting };
      } } };
    });
    await shelled.goto(base + '/edit');
    await shelled.getByRole('button', { name: 'Present', exact: true }).click();
    await shelled.getByRole('button', { name: 'Stop presenting' }).click();
    await shelled.getByRole('button', { name: 'Present', exact: true }).waitFor();
    // Preview and "Open in a window" ask the app for a window, rather than window.open, which macOS drops (#51).
    let popups = 0;
    shelled.on('popup', () => popups++);
    await shelled.getByRole('button', { name: 'Preview', exact: true }).click();
    for (const name of ['Map', 'Controller', 'Developer']) await shelled.locator('.ed-ribbon').getByRole('button', { name, exact: true }).click();
    // The Display tab (#151): the colour pass of each display, previewed on the editor's map while it is open.
    await shelled.getByRole('tab', { name: 'Display' }).click();
    await shelled.locator('.dt-slider').first().waitFor();
    await shelled.waitForFunction(() => document.querySelector('.ed-canvas').style.filter.includes('saturate(1.4'));
    await shelled.getByRole('tab', { name: 'Edit' }).click();
    assert.equal(await shelled.$eval('.ed-canvas', (n) => n.style.filter), '', 'the preview goes with the tab');
    await shelled.getByRole('button', { name: 'All tables', exact: true }).click();
    assert.equal(await shelled.evaluate(() => window.mrsShellControls), true);
    // "All tables" goes through the File menu's action (#130): it keeps a picture of the map first, then asks the app.
    await shelled.waitForFunction(() => window.shellCalls.includes('file_action home'));
    assert.deepEqual(await shelled.evaluate(() => window.shellCalls.filter((c) => c !== 'presenting_state')), [
      'present', 'stop_presenting', 'open_view table', 'open_view table', 'open_view tv', 'open_view dev', 'colour_state', 'file_action home',
    ]);
    assert.equal(popups, 0, 'no browser window is opened inside the app');
    await shelled.close();

    console.log('e2e passed');
  } finally {
    await browser.close();
    host.kill();
    fs.rmSync(site, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
