// End-to-end check in a real browser: the host, the engine, three surfaces and the sunlight layer.
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

    // The dev surface renders the layer that site.json turns on.
    const dev = await open('/dev', { width: 1500, height: 800 });
    const table = dev.locator('.table-surface');
    await dev.getByText(/sun [\d.]+° up/).waitFor();
    await dev.waitForTimeout(500);
    const afternoon = await table.screenshot();
    if (shots) await dev.screenshot({ path: path.join(shots, 'dev-shadows.png') });

    // A change made on the TV reaches the host, the engine and the dev surface.
    const tv = await open('/tv', { width: 900, height: 900 });
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
    await dev.locator('.layer-card:not(.is-active)').waitFor();
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
