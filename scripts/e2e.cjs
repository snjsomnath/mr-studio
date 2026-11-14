// End-to-end check in a real browser: the host, the engine, the surfaces, the sunlight layer,
// the ambient scene and the scene composer.
//   pnpm build && cargo build -p mrs-cli && node scripts/e2e.cjs [screenshot-dir]
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

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
    ['dev', '--site', site, '--web', 'packages/runtime/dist', '--port', String(port), '--backend', 'cpu'],
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
    await dev.getByText(/\d+ cars on the streets/).waitFor();
    await dev.getByText(/\d+ vehicles running/).waitFor();
    const still = async () => {
      const first = await table.screenshot();
      await dev.waitForTimeout(400);
      return first.equals(await table.screenshot());
    };
    assert.equal(await still(), false, 'the ambient scene should be moving');
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-ambient.png') });

    // Sunlight is in the scene but off; the TV turns it on.
    const tv = await open('/tv', { width: 900, height: 900 });
    await tv.getByLabel('Turn Sunlight on or off').check();
    await dev.getByText(/sun [\d.]+° up/).waitFor();
    await dev.waitForTimeout(500);
    const afternoon = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-shadows.png') });

    // A change made on the TV reaches the host, the engine and the dev surface.
    await tv.getByLabel('Time of day').fill('8.5');
    await dev.getByText('08:30').waitFor();
    await dev.getByText(/bearing 9\d/).waitFor();
    await dev.waitForTimeout(500);
    const morning = await table.screenshot();
    assert.notDeepEqual(morning, afternoon, 'shadows should move when the time changes');
    assert.equal(await tv.locator('.sunlight-clock').textContent(), '08:30');

    // Sun hours accumulate progressively and finish.
    await tv.getByRole('radio', { name: 'Sun hours' }).click();
    await dev.getByText(/h of daylight/).waitFor({ timeout: 120_000 });
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

    // A phone needs the code, sees only phone controls and cannot switch layers.
    const stranger = await open('/phone', { width: 390, height: 800 });
    await stranger.getByText(/wrong session code/).waitFor();
    const phone = await open(`/phone?c=${code}`, { width: 390, height: 800 });
    await phone.getByLabel('Time of day').waitFor();
    assert.equal(await phone.getByLabel('Turn Sunlight on or off').count(), 0);
    assert.equal(await phone.getByText('Opacity').count(), 0);
    await tv.getByText('1 phones').waitFor();
    await phone.getByLabel('Time of day').fill('18');
    await tv.getByText('18:00').waitFor();
    // The table recomputed for the phone's time and published the new sun position to the TV.
    await tv.getByText(/sun 2\d\.\d° up, bearing 2[5-8]\d/).waitFor();
    if (shots) {
      await phone.screenshot({ path: path.join(shots, 'phone.png') });
      await tv.screenshot({ path: path.join(shots, 'tv.png') });
    }

    // ---- The scene composer ----
    const compose = await open('/compose', { width: 1700, height: 900 });
    const stage = compose.locator('.table-surface');
    const rows = () => compose.locator('.stack-row strong').allTextContents();
    await compose.locator('.palette-group', { hasText: 'Analysis' }).getByText('Sunlight').waitFor();
    assert.deepEqual(await rows(), ['Slideshow', 'Trees', 'Public transport', 'Traffic', 'Building lights', 'Sunlight', 'Dark base map']);
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
    assert.deepEqual(savedLayers().map((l) => l.id ?? l.use), ['basemap', 'sunlight', 'building-lights', 'cars', 'transit', 'trees', 'slideshow']);
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
