// The editor's flows (#67, #426): the flows that broke by hand before (#47). Navigation, the list,
// the Format pane, dialogs, the tour, two authors, the drawing frame and controller pages.
const path = require('node:path');
const { test, assert, kit, mod, until } = require('./studio.cjs');

// The editor's own checks watch for thrown errors only: a missing picture is not its concern here.
test.use({ setup: 'editor', consoleErrors: false });

/** The editor at `hash`, and the ways these cases read it. */
async function editorAt(studio, hash = '') {
  const page = await studio.open(`/edit${hash}`, { width: 1440, height: 900 });
  const inspector = () => page.locator('.ed-inspector-head strong').first().innerText();
  const row = (id) => page.locator(`.ed-row.is-layer[data-layer="${id}"]`);
  await page.locator('.ed-tree .ed-row').first().waitFor();
  return { page, inspector, row };
}

/** Types into the control `label` of the inspector, under More settings, as a number or a clock. */
async function typeControl(page, label, text) {
  const more = page.locator('.ed-inspector details.ed-more');
  if (!(await more.evaluate((d) => d.open))) await more.locator('summary').click();
  await page.locator('.ed-inspector .control', { hasText: label }).locator('.control-value').click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.describe('editor', () => {
  test('the editor opens at the layer in the address, in its rail', async ({ studio }) => {
    const { page, inspector } = await editorAt(studio, '#layer=wind');
    await page.locator('.ed-rail[data-side="left"] .ed-row[data-layer="wind"][aria-current="true"]').waitFor();
    assert.equal(await inspector(), 'Wind');
    await studio.shot(page, 'editor/editor');
  });

  test('the status bar says phones and simulations in plain words, with a Fix that opens the phones setting (#713)', async ({ studio }) => {
    const page = await studio.open('/edit', { width: 1440, height: 900 }, {
      init: () => {
        window.calls = [];
        window.__TAURI__ = { core: { invoke: async (command, args) => (window.calls.push([command, args]), {}) } };
      },
    });
    const bar = page.locator('footer.ed-status');
    await bar.locator('.ed-engine svg').waitFor();
    const text = await bar.innerText();
    for (const word of ['Engine:', 'llvmpipe', 'Vulkan', 'cannot join']) assert.ok(!text.includes(word), `the status bar says "${word}"`);
    assert.match(await bar.locator('.ed-engine').innerText(), /^(Fast|Slower) simulations$/);
    const phones = bar.locator('.ed-phones');
    if (await phones.evaluate((p) => p.classList.contains('is-off'))) {
      await phones.getByRole('button', { name: 'Fix' }).click();
      assert.deepEqual(await page.evaluate(() => window.calls.find(([c]) => c === 'open_settings')), ['open_settings', { page: 'startup' }]);
    } else assert.match(await phones.innerText(), /^Phones: /);
    await studio.shot(bar, 'editor/713-status-bar');
  });

  test('Back returns to the layer before (#47)', async ({ studio }) => {
    const { page, inspector, row } = await editorAt(studio, '#layer=wind');
    await until(async () => (await inspector()) === 'Wind', 'Wind in the inspector');
    await row('mobility').click();
    await until(async () => (await inspector()) === 'Mobility', 'Mobility in the inspector');
    await page.goBack();
    await until(async () => (await inspector()) === 'Wind', 'Wind again after Back');
    assert.equal(await page.evaluate(() => location.hash), '#layer=wind');
  });

  test('command search goes to a layer (#65)', async ({ studio }) => {
    const { page, inspector } = await editorAt(studio);
    await page.keyboard.press(`${mod}+k`);
    await page.locator('.ed-commands[open]').waitFor();
    await page.keyboard.type('isovist');
    await page.keyboard.press('Enter');
    await until(async () => (await inspector()) === 'Isovist', 'Isovist from the command search');
  });

  test('Duplicate adds a selected copy, Delete removes it, Undo brings it back, and F2 renames it (#58)', async ({ studio }) => {
    const { page, row } = await editorAt(studio);
    const before = studio.layerIds().length;
    await row('isovist').click();
    await page.keyboard.press(`${mod}+d`);
    await until(() => studio.layerIds().length === before + 1, 'the copy in site.json');
    const copy = studio.layerIds().find((id) => id.startsWith('isovist') && id !== 'isovist');
    await row(copy).waitFor();
    await row(copy).click();
    await page.keyboard.press('Delete');
    await until(() => studio.layerIds().length === before, 'the copy gone from site.json');
    await page.locator('.ed-toast', { hasText: 'Removed' }).waitFor();
    await page.keyboard.press(`${mod}+z`);
    await until(() => studio.layerIds().includes(copy), 'the copy back after Undo');
    await row(copy).click();
    await page.keyboard.press('F2');
    const field = page.locator('.ed-row input');
    await field.fill('Viewshed');
    await field.press('Enter');
    await until(() => studio.savedLayer(copy)?.button?.name === 'Viewshed', 'the new name in site.json');
  });

  test('a button changes side in its Format pane, the one place for it; rows are not dragged (#58)', async ({ studio }) => {
    const { page, row } = await editorAt(studio, '#layer=wind');
    await row('wind').waitFor();
    assert.equal(await page.locator('.ed-tree [draggable="true"]').count(), 0, 'no row in the list can be dragged');
    await page.locator('[data-setting="button.side"] [role="radio"]', { hasText: 'Right' }).click();
    await until(() => studio.savedLayer('wind')?.button?.side === 'right', 'Wind on the right in site.json');
    await page.locator('.ed-rail[data-side="right"] .ed-row[data-layer="wind"]').waitFor();
    await studio.shot(page, 'editor/58-side-format');
  });

  test('a time is typed as a clock and kept apart from the saved start (#64, #61)', async ({ studio }) => {
    const { page } = await editorAt(studio, '#layer=sunlight');
    await page.locator('.ed-time').waitFor();
    const start = studio.savedLayer('sunlight')?.params?.hour;
    assert.notEqual(start, 13.5);
    await typeControl(page, 'Time of day', '13:30');
    await page.locator('.ed-inspector .control-value', { hasText: '13:30' }).waitFor();
    await until(() => studio.savedLayer('sunlight')?.params?.hour === 13.5, 'the typed time saved as 13.5');
    // The time bar previews another hour without changing the saved start.
    await page.locator('.ed-time-track').focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    assert.equal(studio.savedLayer('sunlight')?.params?.hour, 13.5, 'previewing a time does not change what is saved');
  });

  test('Table size and place saves where visitors stand and the ribbons (#62, #382)', async ({ studio }) => {
    const { page } = await editorAt(studio, '#table');
    const dialog = page.locator('dialog.is-place');
    await dialog.locator('[data-setting="table.front"]').selectOption('left');
    await until(() => studio.saved().table?.front === 'left', 'table.front in site.json');
    await dialog.getByLabel('Left ribbon').selectOption('12');
    await until(() => studio.saved().table?.ribbons?.left?.cm === 12, 'the left ribbon in site.json');
    await studio.shot(page, 'editor/table-size-and-place');
    await page.keyboard.press('Escape');
  });

  test('the Checks button lists what is left (#63)', async ({ studio }) => {
    const { page } = await editorAt(studio);
    const checks = page.locator('.ed-checks');
    await checks.waitFor();
    await checks.click();
    await page.locator('.ed-checks-list').waitFor();
    await studio.shot(page, 'editor/checks');
    await page.locator('.ed-checks-list .ed-icon-button').click();
  });

  test('Rehearse shows a controller and a phone, and puts the layers back (#97)', async ({ studio }) => {
    const { page } = await editorAt(studio, '#layer=sunlight');
    await page.locator('.ed-tab[data-tab="present"]').click();
    await page.locator('.ed-ribbon [data-command="present.rehearse"]').click();
    const tv = page.frameLocator('.ed-rehearse-controller iframe');
    await tv.locator('button', { hasText: 'Mobility' }).first().click();
    await page.locator('.ed-rehearse-phone iframe').waitFor();
    await studio.shot(page, 'editor/rehearse');
    await page.locator('.ed-rehearse-bar').getByRole('button', { name: 'Finish rehearsal' }).click();
    await page.locator('.ed-rehearse-summary', { hasText: /You opened \d+ of \d+ layers/ }).waitFor();
    await page.locator('.ed-rehearse-summary .is-primary').click();
    assert.equal(await page.locator('.ed.is-rehearse').count(), 0);
  });

  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    test(`every tab of the ribbon fits ${width} px without running off the edge (#66, #382)`, async ({ studio }) => {
      const { page } = await editorAt(studio, '#layer=sunlight');
      await page.setViewportSize({ width, height });
      await page.locator('.ed-ribbon .ed-group').first().waitFor();
      for (const tab of await page.locator('.ed-tab').evaluateAll((tabs) => tabs.map((t) => t.dataset.tab))) {
        await page.locator(`.ed-tab[data-tab="${tab}"]`).click();
        await page.waitForTimeout(200);
        const [scroll, inside] = await page.locator('.ed-ribbon').evaluate((r) => [r.scrollWidth, r.clientWidth]);
        assert.ok(scroll <= inside + 1, `${tab} is ${scroll} px wide in ${inside} at ${width} px`);
        // Opening a tab leaves the selection as it was (#385).
        await page.locator('.ed-row[data-layer="sunlight"][aria-current="true"]').waitFor();
      }
      await studio.shot(page, `editor/ribbon-${width}`);
    });
  }

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
    test(`Add data explains what is wrong with ${file}`, async ({ studio }) => {
      const { page } = await editorAt(studio);
      await page.keyboard.press(`${mod}+k`);
      await page.locator('.ed-commands[open]').waitFor();
      await page.keyboard.type('data file');
      await page.keyboard.press('Enter');
      const dialog = page.locator('dialog[open]');
      // The editor's own list (#712): open it, then pick.
      await dialog.getByRole('combobox', { name: 'What the file holds' }).click();
      await dialog.getByRole('option', { name: kind, exact: true }).click();
      await page.locator(`input[type=file][aria-label="File for ${kind}"]`).setInputFiles(path.join(kit, 'broken', file));
      await until(async () => says.test(await dialog.innerText()), `the message for ${file}`, 15000);
      if (file === 'buildings-3km-away.geojson') await studio.shot(page, 'editor/import-3km');
    });
  }

  test('the tour points at the parts of the window, and Help replays it (#451)', async ({ studio }) => {
    // Under automation the tour does not open by itself; Help › Tour of the editor runs it.
    const { page } = await editorAt(studio);
    await page.locator('.ed-tab[data-tab="help"]').click();
    await page.locator('.ed-ribbon [data-command="help.tour"]').click();
    const card = page.locator('.ed-tour-card');
    await card.locator('strong', { hasText: 'The ribbon' }).waitFor();
    await studio.shot(page, 'editor/451-tour');
    assert.equal(await card.getByLabel('Show this tour when the editor opens').isChecked(), true);
    // Its tick box is the one home of the startup choice: off, it stays off.
    await card.getByLabel('Show this tour when the editor opens').uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem('mrs-editor-tour')), 'off');
    for (let i = 0; i < 10 && (await card.getByRole('button', { name: 'Next' }).count()); i++) await card.getByRole('button', { name: 'Next' }).click();
    await card.locator('strong', { hasText: 'Help, and this tour again' }).waitFor();
    await card.getByRole('button', { name: 'Done' }).click();
    await page.locator('.ed-tour').waitFor({ state: 'detached' });
  });

  test('Add inside puts a layer inside the selected one, and X-ray glass is in the gallery (#453)', async ({ studio }) => {
    const { page, row } = await editorAt(studio, '#layer=wind');
    await row('wind').waitFor();
    await page.locator('.ed-tab[data-tab="insert"]').click();
    await page.locator('.ed-ribbon [data-command="dialog.inside"]').click();
    const gallery = page.locator('dialog.lg-gallery[data-into="wind"]');
    await gallery.locator('h2', { hasText: 'Add inside Wind' }).waitFor();
    await gallery.locator('.lg-card[data-layer="trees"] .lg-pick').click();
    await until(async () => (studio.savedLayer('wind')?.items ?? []).some((i) => i.use === 'trees'), 'trees inside wind');
    // The gallery offers the Magnifier's X-ray by name; picked, it opens empty, with the way in.
    await page.locator('.ed-ribbon [data-command="layer.new"]').click();
    await page.locator('dialog.lg-gallery .lg-card[data-layer="lens:xray"] .lg-pick').click();
    await until(async () => studio.savedLayers().some((l) => l.use === 'lens' && l.params?.show === 'under'), 'an X-ray glass');
    await page.locator('section[data-items] [data-command="dialog.inside"]').waitFor();
    await studio.shot(page, 'editor/453-xray-empty');
  });

  test('File › Version history… says what a version changed (#395)', async ({ studio }) => {
    const { page, row } = await editorAt(studio, '#layer=wind');
    await row('wind').waitFor();
    // A change to remember: the wind's speed.
    const speed = studio.savedLayer('wind')?.params?.speed ?? 5;
    await typeControl(page, 'Wind speed', String(speed + 3));
    await until(async () => studio.savedLayer('wind')?.params?.speed === speed + 3, 'the new speed saved');
    await page.locator('.ed-file-button, [data-file-menu]').first().click();
    await page.getByRole('menuitem', { name: 'Version history…' }).click();
    const panel = page.locator('.ed-history[aria-label="Version history"]');
    await panel.waitFor();
    await panel.locator('.ed-history-row').first().locator('.ed-history-what').click();
    await panel.locator('.ed-history-detail li', { hasText: `wind speed ${speed} → ${speed + 3} m/s` }).waitFor();
    await studio.shot(page, 'editor/395-version-history');
    await page.keyboard.press('Escape');
  });

  test('a change from another editor updates in place and never overwrites what is being typed (#396)', async ({ studio }) => {
    const { page, row } = await editorAt(studio, '#layer=wind');
    await row('wind').waitFor();
    // The other author has a window of their own, so this one keeps its focus.
    const other = await studio.open('/edit#layer=wind', { width: 1280, height: 800 });
    const fields = (p) => p.locator('.ed-inspector');
    await fields(other).getByLabel('Description').waitFor();
    // The other editor changes the description: here it updates in place.
    await fields(other).getByLabel('Description').fill('Air between the houses');
    await fields(other).getByLabel('Description').press('Tab');
    await until(async () => (await fields(page).getByLabel('Description').inputValue()) === 'Air between the houses', 'the description updated in place');
    // Typing a name here while the other editor renames: what is typed stays, theirs is offered.
    await fields(page).getByLabel('Name').fill('Our wind');
    await fields(other).getByLabel('Name').fill('Their wind');
    await fields(other).getByLabel('Name').press('Tab');
    await page.locator('.ed-toast', { hasText: 'while you were typing' }).getByRole('button', { name: 'Use theirs' }).waitFor();
    assert.equal(await fields(page).getByLabel('Name').inputValue(), 'Our wind');
    await studio.shot(page, 'editor/396-two-authors');
    await fields(page).getByLabel('Name').press('Tab');
    await until(async () => studio.savedLayer('wind')?.button?.name === 'Our wind', 'the name being typed winning when it is finished');
  });

  test('the controller docks small and enlarges again (#388)', async ({ studio }) => {
    const { page, row } = await editorAt(studio, '#layer=wind');
    await row('wind').waitFor();
    const area = (b) => Math.round(b.width * b.height);
    const half = area(await page.locator('.ed-surface.is-map').boundingBox());
    await page.locator('.ed-surface-shrink').click();
    await page.locator('.ed-surfaces.is-controller-small').waitFor();
    const map = await page.locator('.ed-surface.is-map').boundingBox();
    assert.ok(area(map) > half * 1.5, `the map has the canvas (${half}px², now ${area(map)}px²)`);
    assert.equal(await page.evaluate(() => localStorage.getItem('mrs-controller-small')), '1');
    await studio.shot(page, 'editor/388-controller-small');
    await page.locator('.ed-surface-enlarge').click();
    await page.locator('.ed-surfaces:not(.is-controller-small)').waitFor();
  });

  test('View › Phone shows a live phone beside the map (#389)', async ({ studio }) => {
    const { page } = await editorAt(studio, '#layer=wind');
    await page.locator('.ed-tab[data-tab="view"]').click();
    await page.locator('.ed-ribbon [data-command="view.phone"]').click();
    await page.locator('.ed-surfaces.has-phone .ed-phone-screen iframe').waitFor();
    await page.waitForTimeout(1500);
    await studio.shot(page, 'editor/389-phone');
    await page.locator('.ed-ribbon [data-command="view.phone"]').click();
    await page.locator('.ed-surfaces:not(.has-phone)').waitFor();
  });

  test('Ctrl or ⌘ click selects several rows, and Delete removes them together (#399)', async ({ studio }) => {
    const { page, row } = await editorAt(studio, '#layer=wind');
    await row('wind').waitFor();
    await row('wind').click();
    await row('isovist').click({ modifiers: [mod] });
    await page.locator('.ed-row.is-also[data-layer="isovist"]').waitFor();
    await studio.shot(page, 'editor/399-multi');
    const before = studio.layerIds().length;
    await page.locator('.ed-ribbon [data-command="layer.remove"]').click();
    await until(async () => !studio.layerIds().includes('wind') && !studio.layerIds().includes('isovist'), 'both rows removed');
    assert.equal(studio.layerIds().length, before - 2);
  });

  test('the drawing follows its frame while it moves, and arrow keys nudge it (#405)', async ({ studio }) => {
    const { page } = await editorAt(studio);
    await page.locator('.ed-tab[data-tab="insert"]').click();
    await page.locator('.ed-ribbon [data-command="layer.new"]').click();
    await page.locator('dialog.lg-gallery .lg-card[data-layer="plan"] .lg-pick').click();
    const body = page.locator('.ed-drawing-frame .ed-df-body');
    await body.waitFor();
    const plan = () => studio.savedLayers().find((l) => l.use === 'plan');
    await until(async () => Boolean(plan()), 'a Masterplan');
    // Mid-drag the drawing itself is shown in the frame.
    const box = await body.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2 - 30, { steps: 6 });
    const ghost = page.locator('.ed-drawing-frame.is-dragging .ed-df-ghost image[href^="blob:"]');
    await ghost.waitFor();
    await ghost.evaluate((image) => image.decode?.().catch(() => {}));
    await page.mouse.move(box.x + box.width / 2 - 64, box.y + box.height / 2 - 32);
    await page.waitForTimeout(300);
    await studio.shot(page, 'editor/405-drawing-drag');
    await page.mouse.up();
    await until(async () => Boolean(plan()?.params?.corners), 'the dragged frame saved');
    const dragged = JSON.stringify(plan().params.corners);
    await body.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await until(async () => JSON.stringify(plan()?.params?.corners) !== dragged, 'the nudged frame saved');
  });

  test('a click on the map selects the layer that drew there, a drag does not, and Sunlight keeps its clicks (#425)', async ({ studio }) => {
    const { page } = await editorAt(studio, '#rest');
    const surface = page.locator('.ed-canvas .table-surface');
    const clickAt = async (fx, fy) => {
      const box = await surface.boundingBox();
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(300);
      return page.evaluate(() => location.hash);
    };
    // At rest the map life under the pointer is picked: the lit buildings in one place, the base map in another.
    await surface.waitFor();
    await page.waitForTimeout(2500);
    // Map life draws a moment after the page opens, so the click is tried again until it lands.
    await until(async () => (await clickAt(0.2, 0.8)) === '#rest=building-lights', 'the lit buildings picked', 10000);
    await page.locator('.ed-row.is-rest[data-layer="building-lights"][aria-current="true"]').waitFor();
    await studio.shot(page, 'editor/425-map-pick');
    // Lit windows come and go, so a few places are tried until one has only the base map under it.
    const spots = [[0.7, 0.6], [0.55, 0.15], [0.85, 0.35], [0.4, 0.9], [0.62, 0.72]];
    let tries = 0;
    await until(async () => {
      const [fx, fy] = spots[tries++ % spots.length];
      return (await clickAt(fx, fy)) === '#rest=basemap';
    }, 'the base map picked', 15000);
    // A drag is not a pick.
    const box = await surface.boundingBox();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.7, { steps: 4 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => location.hash), '#rest=basemap');
    // Sunlight reads clicks itself (its spot), so they stay with it while it is open.
    await page.goto(`${studio.base}/edit#layer=sunlight`);
    await surface.waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await clickAt(0.2, 0.8), '#layer=sunlight');
  });

  test('Design › Starter tables… opens the guide at Start from…, and a dialog opened over it keeps it (#469)', async ({ studio }) => {
    const { page } = await editorAt(studio);
    await page.locator('.ed-tab[data-tab="design"]').click();
    await page.locator('.ed-ribbon [data-command="dialog.starters"]').click();
    await page.locator('.wz h2', { hasText: 'Start from' }).waitFor();
    await page.locator('.wz-starter[data-starter]').first().waitFor();
    await studio.shot(page, 'editor/469-starters');
    // A fix such as Write a welcome opens its dialog over the guide; closing it comes back.
    await page.keyboard.press(`${mod}+k`);
    await page.locator('.ed-commands-field').fill('welcome and languages');
    await page.keyboard.press('Enter');
    const dialog = page.locator('dialog.ed-dialog.is-welcome');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.locator('.wz h2', { hasText: 'Start from' }).waitFor();
  });

  test('a Through time slider reads the year on show and snaps to each column (#408)', async ({ studio }) => {
    // The editor's map is the table that runs the layer.
    await editorAt(studio);
    const remote = await studio.join('dev');
    const series = [2000, 2005, 2010, 2015, 2020].map((y) => `pop_${y}`);
    await remote.request('custom.save', {
      id: 'growth',
      recipe: {
        name: 'Growth',
        data: [{ id: 'zones', dataset: 'growth' }],
        look: [{ id: 'look', block: 'fill', data: 'zones', props: { colour: { by: 'pop_2000', kind: 'number' } } }],
        motion: [{ id: 'look-time', block: 'timeline', on: 'look', props: { series } }],
      },
    });
    // With a button, so it is a layer of the controller rather than map life at rest.
    await remote.request('scene.add', { use: 'custom:growth', button: { name: 'Growth', side: 'left' } });
    remote.close();
    const tv = await studio.open('/tv?idle=0', { width: 1600, height: 900 });
    await tv.locator('.layer-button', { hasText: 'Growth' }).click();
    const open = tv.locator('.layer-open[data-layer="growth"]');
    await open.getByRole('checkbox', { name: 'Play' }).uncheck();
    const when = open.getByRole('slider', { name: 'When' });
    await when.waitFor();
    assert.equal(await when.getAttribute('step'), '25', 'one step per column');
    await when.focus();
    await tv.keyboard.press('Home');
    for (let i = 0; i < 2; i++) await tv.keyboard.press('ArrowRight');
    await open.locator('.control', { hasText: 'When' }).locator('.control-value', { hasText: '2010' }).waitFor();
    await tv.waitForTimeout(400);
    await studio.shot(tv, 'editor/408-when-year');
  });

  test('Add data says what each column holds (#52)', async ({ studio }) => {
    const { page } = await editorAt(studio);
    await page.locator('.ed-tab[data-tab="insert"]').click();
    await page.locator('.ed-ribbon [data-command="data.file"]').click();
    const dialog = page.locator('dialog.im-dialog');
    await dialog.getByRole('combobox', { name: 'What the file holds' }).click();
    await dialog.getByRole('option', { name: /^Something else/ }).click();
    await dialog.getByLabel('Name of the dataset').fill('districts');
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Choose a file' }).first().click();
    await (await chooser).setFiles(path.join(kit, 'zones.geojson'));
    const columns = page.locator('.im-columns');
    await columns.locator('.im-column[data-column="zone"][data-role="id"]').waitFor();
    await columns.locator('.im-column[data-column="population"][data-role="value"]').waitFor();
    await studio.shot(page, 'editor/52-columns');
    await page.keyboard.press('Escape');
  });

  test('a picture with its side file is placed on the map by the edges it gives (#52)', async ({ studio }) => {
    const { page } = await editorAt(studio);
    await page.locator('.ed-tab[data-tab="insert"]').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ed-ribbon [data-command="media.picture"]').click();
    await (await chooser).setFiles([path.join(kit, 'overlay.png'), path.join(kit, 'overlay.json')]);
    await until(() => studio.savedLayers().some((l) => l.use === 'media' && /^11\.96/.test(String(l.params?.bounds ?? ''))), 'a placed Picture layer', 15000);
    await page.waitForTimeout(1500);
    await studio.shot(page, 'editor/52-placed-picture');
  });

  test('controller pages are made in the editor, placed by clicking, within the budget (#155)', async ({ studio }) => {
    const { page } = await editorAt(studio);
    await page.locator('.ed-tab[data-tab="design"]').click();
    await page.locator('.ed-ribbon [data-command="dialog.pages"]').click();
    const dialog = page.locator('dialog.ed-dialog.is-pages');
    await dialog.locator('.pe-start').first().waitFor();
    await dialog.locator('[data-command="pages.add"]').click();
    const pick = dialog.locator('.pe-add select');
    const add = dialog.locator('[data-command="pages.panel"]');
    for (const widget of ['stat', 'bars', 'list']) {
      await pick.selectOption(widget);
      await add.click();
      await dialog.locator(`.pe-panel[data-panel="${widget}"]`).waitFor();
    }
    // The stat goes on the left, the bars next to it; the list takes the first free place.
    await until(() => (studio.saved().tv?.pages?.[0]?.panels ?? []).length === 3, 'three panels saved');
    const at = (id) => studio.saved().tv.pages[0].panels.find((p) => p.id === id).at;
    assert.deepEqual(at('stat'), { col: 1, row: 1 });
    // Selected, the list moves a cell with the arrow keys, or to a highlighted cell when clicked.
    await dialog.locator('.pe-panel[data-panel="list"]').click();
    const before = at('list');
    await page.keyboard.press('ArrowDown');
    await until(() => at('list').row === before.row + 1, 'the list moved down');
    await dialog.locator('.pe-cell.can-take[data-cell="7,4"]').click();
    await until(() => at('list').col === 7 && at('list').row === 4, 'the list put at 7,4');
    // Its title and a value bound to a layer.
    await dialog.locator('.pe-inspector').getByLabel('Title').fill('Busiest roofs');
    await dialog.locator('.pe-inspector').getByLabel('Title').press('Tab');
    await until(() => studio.saved().tv.pages[0].panels.find((p) => p.id === 'list').title === 'Busiest roofs', 'the title saved');
    assert.match(await dialog.locator('.pe-budget').textContent(), /of 24 reads/);
    assert.equal(await dialog.locator('.pe-problems li').count(), 0, 'the page passes the rules');
    await studio.shot(dialog, 'editor/155-pages-editor');
    // The controller shows the page.
    const tv = await studio.open('/tv?idle=0', { width: 1600, height: 900 });
    await tv.locator('[data-panel="page/stat"], [data-panel$="/stat"]').first().waitFor();
    await tv.waitForTimeout(800);
    await studio.shot(tv, 'editor/155-controller-page');
    await tv.close();
    // Removing the page gives the controller back to the layers' own panels.
    await dialog.locator('[data-command="pages.remove"]').click();
    await until(() => !studio.saved().tv?.pages, 'no pages left');
    await dialog.getByRole('button', { name: 'Close' }).click();
  });

  test('the controller carries no operator text (#50)', async ({ studio }) => {
    const tv = await studio.open('/tv', { width: 1600, height: 900 });
    await tv.locator('body').waitFor();
    await tv.waitForTimeout(1500);
    const text = await tv.locator('body').innerText();
    for (const word of ['Engine:', 'Phones join with', 'site.json', 'localhost', '127.0.0.1']) assert.ok(!text.includes(word), `the controller says "${word}"`);
  });
});
