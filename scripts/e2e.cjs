// End-to-end check in a real browser: the host, the engine, the surfaces, the sunlight layer,
// the ambient scene, the scene composer,
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
    const open = async (url, viewport) => {
      const page = await browser.newPage({ viewport });
      page.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && errors.push(`${url}: ${m.text()}`));
      await page.goto(base + url);
      return page;
    };

    // The dev surface renders the scene in site.json: a dark base map with ambient layers that move.
    const dev = await open('/dev', { width: 1500, height: 800 });
    const table = dev.locator('.table-surface');
    const still = async () => {
      const first = await table.screenshot();
      await dev.waitForTimeout(400);
      return first.equals(await table.screenshot());
    };
    // The layers load their data first, so give the scene a few seconds to start moving.
    let moving = false;
    for (let i = 0; i < 20 && !moving; i++) moving = !(await still());
    assert.ok(moving, 'the ambient scene should be moving');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-ambient.png') });

    // Sunlight is in the scene but off; the TV turns it on.
    const tv = await open('/tv', { width: 1920, height: 1080 });
    await tv.getByLabel('Turn Sunlight on or off').check();
    await dev.getByText(/sun [\d.]+° up/).waitFor();
    await dev.waitForTimeout(500);
    const afternoon = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-shadows.png') });

    // A change made on the TV reaches the host, the engine and the dev surface.
    const clock = '[data-panel="sunlight/time"] .mrs-number';
    await tv.getByLabel('Time of day').fill('8.5');
    await dev.locator(clock, { hasText: '08:30' }).waitFor();
    await dev.getByText(/bearing 9\d/).waitFor();
    await dev.waitForTimeout(500);
    const morning = await table.screenshot();
    assert.notDeepEqual(morning, afternoon, 'shadows should move when the time changes');
    assert.equal(await tv.locator(clock).textContent(), '08:30');
    // The TV is a rail of controls beside the dashboard canvas, and the layer's panels sit on the grid.
    // Sunlight's five panels and the sketch layer's one. Ambient layers take no room on the TV.
    assert.equal(await tv.locator('.mrs-panel').count(), 6);
    const band = await tv.locator('[data-panel="sunlight/day"]').boundingBox();
    const canvas = await tv.locator('.mrs-dash').boundingBox();
    assert.ok(band.width > canvas.width * 0.9 && band.y + band.height > canvas.y + canvas.height * 0.9, 'the timeline spans the bottom row');
    assert.equal(await tv.locator('.mrs-issues').isVisible(), false);
    if (shots) await tv.screenshot({ path: path.join(shots, 'tv-shadows.png') });

    // Sun hours accumulate progressively and finish.
    await tv.getByRole('radio', { name: 'Sun hours' }).click();
    await dev.getByText('whole day added up').waitFor({ timeout: 120_000 });
    // Panels follow the mode: the clock and the timeline leave, the sun-hours key arrives.
    assert.equal(await tv.locator(clock).count(), 0);
    await tv.locator('[data-panel="sunlight/daylight"]').waitFor();
    if (shots) await tv.screenshot({ path: path.join(shots, 'tv-sun-hours.png') });
    await dev.waitForTimeout(500);
    const day = await table.screenshot();
    assert.notDeepEqual(day, morning, 'sun hours should look different from shadows');
    assert.equal(await tv.getByLabel('Time of day').isVisible(), false, 'the time control hides in sun hours mode');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-sun-hours.png') });

    // Turning the layer off clears the table.
    await tv.getByLabel('Turn Sunlight on or off').uncheck();
    await dev.locator('.layer-card:not(.is-active)', { hasText: 'Sunlight' }).waitFor();
    await dev.waitForTimeout(500);
    const off = await table.screenshot();
    assert.notDeepEqual(off, day, 'the overlay should disappear when the layer is off');
    await tv.getByLabel('Turn Sunlight on or off').check();
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
    await phone.getByLabel('Time of day').waitFor();
    await phone.getByText('You are 1').waitFor();
    assert.equal(await phone.getByLabel('Turn Sunlight on or off').count(), 0);
    assert.equal(await phone.getByText('Opacity').count(), 0);
    await tv.getByText('1 phone', { exact: true }).waitFor();
    await phone.getByLabel('Time of day').fill('18');
    await tv.locator(clock, { hasText: '18:00' }).waitFor();
    // The table recomputed for the phone's time and published the new sun position to the TV.
    await tv.getByText(/sun 2\d\.\d° up, bearing 2[5-8]\d/).waitFor();

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
    await tv.getByText('1 mark on the table').waitFor();
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
    await tv.getByText('2 marks on the table').waitFor();

    await phone.getByRole('radio', { name: 'Area' }).click();
    await tap(0.75, 0.6);
    await tap(0.95, 0.6);
    await tap(0.85, 0.9);
    if (shots) await phone.screenshot({ path: path.join(shots, 'phone.png') });
    await phone.getByRole('button', { name: 'Send area' }).click();
    await tv.getByText('3 marks on the table').waitFor();
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

    // The TV clears the sketch.
    await tv.getByRole('button', { name: 'Clear the sketch' }).click();
    await tv.getByText('Nothing marked yet').waitFor();


    // ---- The scene composer ----
    // Tall enough that the whole stack is on screen while one layer's settings are open.
    const compose = await open('/compose', { width: 1700, height: 1200 });
    const stage = compose.locator('.table-surface');
    const rows = () => compose.locator('.stack-row strong').allTextContents();
    await compose.locator('.palette-group', { hasText: 'Analysis' }).getByText('Sunlight').waitFor();
    assert.deepEqual(await rows(), ['Sketch', 'Slideshow', 'Trees', 'Public transport', 'Traffic', 'Building lights', 'Sunlight', 'Dark base map']);
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
    await tv.getByRole('heading', { name: 'Traffic (cars-2)' }).waitFor();

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
    await drag(compose.locator('.palette-item', { hasText: 'Trees' }), row('Dark base map'), 0.9);
    await row('Trees (trees-2)').waitFor();
    assert.equal(savedLayers()[0].id, 'trees-2', 'dropped below the base map, so first in site.json');

    // Draw order follows the list: with the opaque base map on top, nothing below shows through.
    await compose.getByLabel('Show Slideshow').waitFor();
    await drag(row('Dark base map').locator('.stack-head'), row('Traffic (cars-2)'), 0.05);
    await compose.waitForFunction(() => document.querySelector('.stack-row strong')?.textContent === 'Dark base map');
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
    await drag(row('Dark base map').locator('.stack-head'), row('Trees (trees-2)'), 0.9);
    await compose.waitForFunction(() => [...document.querySelectorAll('.stack-row strong')].at(-1)?.textContent === 'Dark base map');
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
    assert.deepEqual(savedLayers().map((l) => l.id ?? l.use), ['basemap', 'sunlight', 'building-lights', 'cars', 'transit', 'trees', 'slideshow', 'sketch']);
    assert.equal(await tv.getByRole('heading', { name: 'Traffic (cars-2)' }).count(), 0);

    const real = errors.filter((e) => !/wrong session code|WebSocket/.test(e));
    assert.deepEqual(real, [], 'no page errors');
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
