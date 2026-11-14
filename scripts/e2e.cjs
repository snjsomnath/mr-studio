// End-to-end check in a real browser: the host, the engine, three surfaces and the core layers.
//   pnpm build && cargo build -p mrs-cli && node scripts/e2e.cjs [screenshot-dir]
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 4199;
const base = `http://127.0.0.1:${port}`;
const shots = process.argv[2];

async function main() {
  const host = spawn(
    path.join(root, 'target/debug/mrstudio'),
    ['dev', '--site', 'sites/sample', '--web', 'packages/runtime/dist', '--port', String(port), '--backend', 'cpu'],
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

    // Controls are looked up inside their layer's card: layers may share control names.
    const sunlight = (page) => page.locator('.layer-card', { hasText: 'Sunlight' });

    // The dev surface renders the layer that site.json turns on.
    const dev = await open('/dev', { width: 1500, height: 800 });
    const table = dev.locator('.table-surface');
    await dev.getByText(/sun [\d.]+° up/).waitFor();
    await dev.waitForTimeout(500);
    const afternoon = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-shadows.png') });

    // A change made on the TV reaches the host, the engine and the dev surface.
    const tv = await open('/tv', { width: 900, height: 900 });
    await sunlight(tv).getByLabel('Time of day').fill('8.5');
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
    assert.equal(await sunlight(tv).getByLabel('Time of day').isVisible(), false, 'the time control hides in sun hours mode');
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
    await sunlight(phone).getByLabel('Time of day').waitFor();
    assert.equal(await phone.getByLabel('Turn Sunlight on or off').count(), 0);
    assert.equal(await phone.getByText('Opacity').count(), 0);
    await tv.getByText('1 phones').waitFor();
    await sunlight(phone).getByLabel('Time of day').fill('18');
    await tv.getByText('18:00').waitFor();
    // The table recomputed for the phone's time and published the new sun position to the TV.
    await tv.getByText(/sun 2\d\.\d° up, bearing 2[5-8]\d/).waitFor();
    if (shots) {
      await phone.screenshot({ path: path.join(shots, 'phone.png') });
      await tv.screenshot({ path: path.join(shots, 'tv.png') });
    }

    // CoolPaths: routes over the site's walkways, costed by the engine's shade.
    const card = (name) => tv.locator('.layer-card', { hasText: name });
    await tv.getByLabel('Turn Sunlight on or off').uncheck();
    await tv.getByLabel('Turn Cool paths on or off').check();
    const cool = card('Cool paths');
    await cool.getByText(/less sun|already the coolest/).waitFor();
    await dev.waitForTimeout(500);
    const walk = await table.screenshot();
    assert.notDeepEqual(walk, off, 'the network and routes should be drawn');
    assert.match(await cool.locator('[data-route="shortest"] .coolpaths-length').textContent(), /^\d+ m$/);
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-coolpaths.png') });
    // A phone may ask for another walk, and the table answers with a different one.
    await phone.getByRole('button', { name: 'Try another walk' }).click();
    await dev.waitForTimeout(800);
    assert.notDeepEqual(await table.screenshot(), walk, 'another walk should be drawn');
    // With no detour allowed the coolest walk is the shortest one.
    await cool.getByLabel('Longest detour').fill('0');
    await cool.getByText('the shortest walk is already the coolest').waitFor();
    // At night there is no sun to avoid.
    await cool.getByLabel('Time of day').fill('1');
    await cool.getByText(/the sun is down/).waitFor();
    await cool.getByText('0 m in the sun').first().waitFor();
    await tv.getByLabel('Turn Cool paths on or off').uncheck();

    // Mobility: the site's trips played over time.
    await tv.getByLabel('Turn Mobility on or off').check();
    const moving = card('Mobility');
    await moving.getByText(/of 60 arrived/).first().waitFor();
    await moving.getByLabel('Play', { exact: true }).uncheck();
    await moving.getByLabel('Time', { exact: true }).fill('0');
    await moving.getByText('0 of 60 arrived').first().waitFor();
    await dev.waitForTimeout(500);
    const start = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-mobility.png') });
    await moving.getByLabel('Time', { exact: true }).fill('100');
    await moving.getByText('60 of 60 arrived').nth(1).waitFor();
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), start, 'travellers should move with the time');
    await tv.getByLabel('Turn Mobility on or off').uncheck();

    const real = errors.filter((e) => !/wrong session code|WebSocket/.test(e));
    assert.deepEqual(real, [], 'no page errors');
    console.log('e2e passed');
  } finally {
    await browser.close();
    host.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
