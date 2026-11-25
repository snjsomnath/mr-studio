// The editor, end to end (#67): the flows that broke by hand before (#47), driven in Chromium
// against `mrstudio dev` on a copy of the sample site. Each step says what it checks; a failure
// names the step and leaves screenshots of where it was.
//   pnpm build && cargo build -p mrs-cli && node scripts/e2e-editor.cjs [screenshot-dir]
// Needs Playwright with Chromium.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const port = 4198;
const base = `http://127.0.0.1:${port}`;
const shots = process.argv[2];
const kit = path.join(root, 'samples/kit');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function main() {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-editor-'));
  fs.cpSync(path.join(root, 'sites/sample'), site, { recursive: true });
  const saved = () => JSON.parse(fs.readFileSync(path.join(site, 'site.json'), 'utf8'));
  const layerIds = () => saved().layers.map((l) => l.id ?? l.use);
  const savedLayer = (id) => saved().layers.find((l) => (l.id ?? l.use) === id);
  if (shots) fs.mkdirSync(shots, { recursive: true });

  const host = spawn(
    path.join(root, 'target/debug/mrstudio'),
    ['dev', '--site', site, '--web', 'packages/runtime/dist', '--port', String(port), '--backend', 'cpu', '--public-url', base],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MRS_JOIN_PAGE: 'off' } },
  );
  let log = '';
  host.stdout.on('data', (d) => (log += d));
  host.stderr.on('data', (d) => (log += d));
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  let page;
  let step = 'starting';
  const shot = async (name) => shots && page && (await page.screenshot({ path: path.join(shots, `${name}.png`) }));
  /** Polls until `check` holds: the host saves a moment after the page asks. */
  const until = async (check, what, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const run = async (name, body) => {
    step = name;
    await body();
    console.log(`ok  ${name}`);
  };
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/edit`)).ok) break;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    // Map tiles come from the internet; the editor works without them.
    await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org|api\.mapbox\.com/, (r) => r.abort());
    page.on('pageerror', (e) => errors.push(e.message));
    const inspector = () => page.locator('.ed-inspector-head strong').first().innerText();
    const row = (id) => page.locator(`.ed-row.is-layer[data-layer="${id}"]`);

    await run('the editor opens at the layer in the address, in its rail', async () => {
      await page.goto(`${base}/edit#layer=wind`);
      await page.locator('.ed-rail[data-side="left"] .ed-row[data-layer="wind"][aria-current="true"]').waitFor();
      assert.equal(await inspector(), 'Wind');
      await shot('editor');
    });

    await run('Back returns to the layer before (#47)', async () => {
      await row('mobility').click();
      await until(async () => (await inspector()) === 'Mobility', 'Mobility in the inspector');
      await page.goBack();
      await until(async () => (await inspector()) === 'Wind', 'Wind again after Back');
      assert.equal(await page.evaluate(() => location.hash), '#layer=wind');
    });

    await run('command search goes to a layer (#65)', async () => {
      await page.keyboard.press(`${mod}+k`);
      await page.locator('.ed-commands[open]').waitFor();
      await page.keyboard.type('isovist');
      await page.keyboard.press('Enter');
      await until(async () => (await inspector()) === 'Isovist', 'Isovist from the command search');
    });

    let copy;
    await run('Duplicate adds a selected copy; Delete removes it; Undo brings it back (#58)', async () => {
      const before = layerIds().length;
      await row('isovist').click();
      await page.keyboard.press(`${mod}+d`);
      await until(() => layerIds().length === before + 1, 'the copy in site.json');
      copy = layerIds().find((id) => id.startsWith('isovist') && id !== 'isovist');
      await row(copy).waitFor();
      await row(copy).click();
      await page.keyboard.press('Delete');
      await until(() => layerIds().length === before, 'the copy gone from site.json');
      await page.locator('.ed-toast', { hasText: 'Removed' }).waitFor();
      await page.keyboard.press(`${mod}+z`);
      await until(() => layerIds().includes(copy), 'the copy back after Undo');
    });

    await run('F2 renames the button (#58)', async () => {
      await row(copy).click();
      await page.keyboard.press('F2');
      const field = page.locator('.ed-row input');
      await field.fill('Viewshed');
      await field.press('Enter');
      await until(() => savedLayer(copy)?.button?.name === 'Viewshed', 'the new name in site.json');
    });

    await run('dragging a layer to the other rail moves its button (#58)', async () => {
      await row('wind').dragTo(page.locator('.ed-rail[data-side="right"]'));
      await until(() => savedLayer('wind')?.button?.side === 'right', 'Wind on the right in site.json');
      await page.locator('.ed-rail[data-side="right"] .ed-row[data-layer="wind"]').waitFor();
    });

    await run('a time is typed as a clock and kept apart from the saved start (#64, #61)', async () => {
      await page.goto(`${base}/edit#layer=sunlight`);
      await page.locator('.ed-time').waitFor();
      const start = savedLayer('sunlight')?.params?.hour;
      // Time of day is under More settings.
      const more = page.locator('.ed-inspector details.ed-more');
      if (!(await more.evaluate((d) => d.open))) await more.locator('summary').click();
      const readout = page.locator('.ed-inspector .control', { hasText: 'Time of day' }).locator('.control-value');
      await readout.click();
      await page.keyboard.press(`${mod}+a`);
      await page.keyboard.type('13:30');
      await page.keyboard.press('Enter');
      await page.locator('.ed-inspector .control-value', { hasText: '13:30' }).waitFor();
      await until(() => savedLayer('sunlight')?.params?.hour === 13.5, 'the typed time saved as 13.5');
      // The time bar previews another hour without changing the saved start.
      const track = page.locator('.ed-time-track');
      await track.focus();
      for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(500);
      assert.equal(savedLayer('sunlight')?.params?.hour, 13.5, 'previewing a time does not change what is saved');
      assert.notEqual(start, 13.5);
    });

    await run('Table size and place saves where visitors stand (#62, #382)', async () => {
      await page.goto(`${base}/edit#table`);
      const dialog = page.locator('dialog.is-place');
      await dialog.locator('[data-setting="table.front"]').selectOption('left');
      await until(() => saved().table?.front === 'left', 'table.front in site.json');
      await dialog.getByLabel('Left ribbon').selectOption('12');
      await until(() => saved().table?.ribbons?.left?.cm === 12, 'the left ribbon in site.json');
      await shot('table-size-and-place');
      await page.keyboard.press('Escape');
    });

    await run('the Checks button counts what is left (#63)', async () => {
      await page.goto(`${base}/edit`);
      const checks = page.locator('.ed-checks');
      await checks.waitFor();
      await checks.click();
      await page.locator('.ed-checks-list').waitFor();
      await shot('checks');
      await page.locator('.ed-checks-list .ed-icon-button').click();
    });

    await run('Rehearse shows a controller and a phone, and puts the layers back (#97)', async () => {
      await page.goto(`${base}/edit#layer=sunlight`);
      await page.locator('.ed-tab[data-tab="present"]').click();
      await page.locator('.ed-ribbon [data-command="present.rehearse"]').click();
      const tv = page.frameLocator('.ed-rehearse-controller iframe');
      await tv.locator('button', { hasText: 'Mobility' }).first().click();
      await page.locator('.ed-rehearse-phone iframe').waitFor();
      await shot('rehearse');
      await page.locator('.ed-rehearse-bar').getByRole('button', { name: 'Finish rehearsal' }).click();
      await page.locator('.ed-rehearse-summary', { hasText: /You opened \d+ of \d+ layers/ }).waitFor();
      await page.locator('.ed-rehearse-summary .is-primary').click();
      assert.equal(await page.locator('.ed.is-rehearse').count(), 0);
    });

    await run('every tab of the ribbon fits 1280 and 1440 px without running off the edge (#66, #382)', async () => {
      for (const [width, height] of [[1280, 800], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`${base}/edit#layer=sunlight`);
        await page.locator('.ed-ribbon .ed-group').first().waitFor();
        for (const tab of await page.locator('.ed-tab').evaluateAll((tabs) => tabs.map((t) => t.dataset.tab))) {
          await page.locator(`.ed-tab[data-tab="${tab}"]`).click();
          await page.waitForTimeout(200);
          const [scroll, inside] = await page.locator('.ed-ribbon').evaluate((r) => [r.scrollWidth, r.clientWidth]);
          assert.ok(scroll <= inside + 1, `${tab} is ${scroll} px wide in ${inside} at ${width} px`);
          // Opening a tab leaves the selection as it was (#385).
          await page.locator('.ed-row[data-layer="sunlight"][aria-current="true"]').waitFor();
        }
        await shot(`ribbon-${width}`);
      }
    });

    // Each file of the sample data kit's broken/ folder says what is wrong with it (samples/kit/README.md).
    const broken = [
      ['buildings-3km-away.geojson', 'Buildings', /none on the table[\s\S]*3\.\d km/i],
      ['buildings-lat-lon-swapped.geojson', 'Buildings', /swapped/i],
      ['buildings-no-heights.geojson', 'Buildings', /no height/i],
      ['buildings-half-off.geojson', 'Buildings', /outside the table/i],
      ['walkways-are-points.geojson', 'Walking paths', /need lines/i],
      ['trees-no-position.csv', 'Trees', /No position columns/i],
    ];
    for (const [file, kind, says] of broken) {
      await run(`Add data explains ${file}`, async () => {
        await page.goto(`${base}/edit`);
        await page.locator('.ed-tree .ed-row').first().waitFor();
        await page.keyboard.press(`${mod}+k`);
        await page.locator('.ed-commands[open]').waitFor();
        await page.keyboard.type('data file');
        await page.keyboard.press('Enter');
        const dialog = page.locator('dialog[open]');
        await dialog.locator('select').first().selectOption({ label: kind });
        await page.locator(`input[type=file][aria-label="File for ${kind}"]`).setInputFiles(path.join(kit, 'broken', file));
        await until(async () => says.test(await dialog.innerText()), `the message for ${file}`, 15000);
        if (file === 'buildings-3km-away.geojson') await shot('import-3km');
      });
    }

    await run('the tour points at the parts of the window, and Help replays it (#451)', async () => {
      // Under automation the tour does not open by itself; Help › Tour of the editor runs it.
      await page.goto(`${base}/edit`);
      await page.locator('.ed-tab[data-tab="help"]').click();
      await page.locator('.ed-ribbon [data-command="help.tour"]').click();
      const card = page.locator('.ed-tour-card');
      await card.locator('strong', { hasText: 'The ribbon' }).waitFor();
      await shot('451-tour');
      assert.equal(await card.getByLabel('Show this tour when the editor opens').isChecked(), true);
      // Its tick box is the one home of the startup choice: off, it stays off.
      await card.getByLabel('Show this tour when the editor opens').uncheck();
      assert.equal(await page.evaluate(() => localStorage.getItem('mrs-editor-tour')), 'off');
      for (let i = 0; i < 10 && (await card.getByRole('button', { name: 'Next' }).count()); i++) await card.getByRole('button', { name: 'Next' }).click();
      await card.locator('strong', { hasText: 'Help, and this tour again' }).waitFor();
      await card.getByRole('button', { name: 'Done' }).click();
      await page.locator('.ed-tour').waitFor({ state: 'detached' });
    });

    await run('Add inside puts a layer inside the selected one, and X-ray glass is in the gallery (#453)', async () => {
      await page.goto(`${base}/edit#layer=wind`);
      await row('wind').waitFor();
      await page.locator('.ed-tab[data-tab="insert"]').click();
      await page.locator('.ed-ribbon [data-command="dialog.inside"]').click();
      const gallery = page.locator('dialog.lg-gallery[data-into="wind"]');
      await gallery.locator('h2', { hasText: 'Add inside Wind' }).waitFor();
      await gallery.locator('.lg-card[data-layer="trees"] .lg-pick').click();
      await until(async () => (savedLayer('wind')?.items ?? []).some((i) => i.use === 'trees'), 'trees inside wind');
      // The gallery offers the Magnifier's X-ray by name; picked, it opens empty, with the way in.
      await page.locator('.ed-ribbon [data-command="layer.new"]').click();
      await page.locator('dialog.lg-gallery .lg-card[data-layer="lens:xray"] .lg-pick').click();
      await until(async () => saved().layers.some((l) => l.use === 'lens' && l.params?.show === 'under'), 'an X-ray glass');
      await page.locator('section[data-items] [data-command="dialog.inside"]').waitFor();
      await shot('453-xray-empty');
    });

    await run('the controller carries no operator text (#50)', async () => {
      const tv = await browser.newPage({ viewport: { width: 1600, height: 900 } });
      await tv.goto(`${base}/tv`);
      await tv.locator('body').waitFor();
      await tv.waitForTimeout(1500);
      const text = await tv.locator('body').innerText();
      for (const word of ['Engine:', 'Phones join with', 'site.json', 'localhost', '127.0.0.1']) assert.ok(!text.includes(word), `the controller says "${word}"`);
      await tv.close();
    });

    assert.deepEqual(errors, [], 'the editor threw');
    console.log('editor e2e: all passed');
  } catch (error) {
    console.error(`FAILED at: ${step}`);
    await shot('failed').catch(() => {});
    console.error(error);
    if (errors.length) console.error('page errors:', errors);
    console.error(log.slice(-4000));
    process.exitCode = 1;
  } finally {
    await browser.close();
    host.kill();
    fs.rmSync(site, { recursive: true, force: true });
  }
}

main();
