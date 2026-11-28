// The setup guide (#390, #382, #512): a new table opens in it. Here it runs on the sample, whose
// name and place are already set.
const fs = require('node:fs');
const path = require('node:path');
const { test, assert, root, controller, until } = require('./studio.cjs');

/** The guide, at its Data step: a table just made starts there. */
async function guidePage(studio) {
  const guide = await studio.open('/edit?welcome=1', { width: 1440, height: 900 });
  await guide.locator('.wz h2', { hasText: 'Data' }).waitFor();
  return guide;
}

test.describe('setup guide', () => {
  test('the guide has three steps, and Back reaches the table\'s name and place (#390)', async ({ studio }) => {
    const guide = await guidePage(studio);
    assert.deepEqual(await guide.locator('.wz-step span:not(.wz-dot)').allInnerTexts(), ['Name and place', 'Data', 'Start from…']);
    await guide.getByRole('button', { name: 'Close guide' }).waitFor();
    await guide.getByRole('button', { name: 'Back' }).click();
    await guide.locator('.wz h2', { hasText: 'Name and place' }).waitFor();
    assert.equal(await guide.getByRole('button', { name: 'Back' }).isDisabled(), true);
    assert.equal(await guide.getByLabel('Name').inputValue(), 'Sample district');
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.locator('.wz h2', { hasText: 'Data' }).waitFor();
  });

  test('a move the ground cannot follow is refused and writes nothing; a new name alone moves the table', async ({ studio }) => {
    const { tv } = await controller(studio);
    const guide = await guidePage(studio);
    await guide.locator('.wz-step button', { hasText: 'Name and place' }).click();
    await guide.getByLabel('Name').fill('Sample square');
    // The sample's ground is a raw height grid made for its extent, so it cannot move; the guide says why and stays.
    await guide.getByLabel('Width, metres').fill('800');
    await guide.getByRole('button', { name: 'Move the table' }).click();
    await guide.getByRole('alert').getByText(/GeoTIFF/).waitFor();
    assert.equal(studio.saved().name, 'Sample district', 'a refused move writes nothing');
    await guide.getByLabel('Width, metres').fill('1000');
    await guide.getByRole('button', { name: 'Move the table' }).click();
    await guide.waitForFunction(() => document.querySelector('.wz h2')?.textContent === 'Data' && document.querySelector('.ed-name strong')?.textContent === 'Sample square');
    assert.equal(studio.saved().name, 'Sample square');
    // Every surface starts again. The controller has no header in its rails; it carries the name in its title.
    await tv.waitForFunction(() => document.title.endsWith('· Sample square'));
  });

  test('Data adds a file beside the earlier one, so Undo can bring it back (#512)', async ({ studio }) => {
    const guide = await guidePage(studio);
    assert.equal(await guide.locator('.wz-place[data-target="buildings"] .wz-state').textContent(), 'On the table');
    await guide.getByLabel('File for Trees').setInputFiles(path.join(studio.site, 'data', 'trees.geojson'));
    await guide.locator('.wz-place[data-target="trees"] .wz-summary', { hasText: /trees/ }).waitFor();
    await studio.shot(guide, 'wizard-place');
    await guide.getByRole('button', { name: 'Add to the table' }).click();
    // Every surface starts again with the new data, and the guide comes back where it was.
    await guide.waitForFunction(() => !document.querySelector('.wz-report') && document.querySelector('.wz h2')?.textContent === 'Data');
    await guide.locator('.wz-place[data-target="trees"] .wz-state', { hasText: 'On the table' }).waitFor();
    // The table names the trees it now uses, and that file is there. Data that differs from what
    // was there is saved beside it (trees.v2.geojson).
    const treesFile = JSON.stringify(studio.saved()).match(/"(data\/trees(?:\.v\d+)?\.geojson)"/)?.[1];
    assert.ok(treesFile && fs.existsSync(path.join(studio.site, treesFile)), 'the file is written into the table');
    assert.ok(fs.existsSync(path.join(studio.site, 'data', 'trees.geojson')), 'the earlier trees are kept');
  });

  test('Data refuses a file that is not what was asked for, with a reason', async ({ studio }) => {
    const guide = await guidePage(studio);
    await guide.getByLabel('File for Buildings', { exact: true }).setInputFiles(path.join(studio.site, 'data', 'trees.geojson'));
    const buildings = guide.locator('.wz-place[data-target="buildings"]');
    await buildings.locator('.wz-issue.is-blocker').waitFor();
    assert.equal(await buildings.getByRole('button', { name: 'Add to the table' }).isDisabled(), true);
    await buildings.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a ground file that does not say where it is is read again in the system the author names', async ({ studio }) => {
    const guide = await guidePage(studio);
    const ground = guide.locator('.wz-place[data-target="terrain"]');
    await guide.getByLabel('File for Ground').setInputFiles(path.join(root, 'crates', 'mrs-site', 'tests', 'fixtures', 'campus-terrain.tif'));
    await guide.getByLabel('EPSG code of the file').fill('3006');
    await ground.getByRole('button', { name: 'Read it again' }).click();
    // Read as that system it lies far from this table, and the host says so.
    await ground.locator('.wz-issue.is-blocker', { hasText: /table/ }).waitFor();
    // The code stays in reach, to try another.
    assert.equal(await guide.getByLabel('EPSG code of the file').inputValue(), '3006');
    assert.equal(await ground.getByRole('button', { name: 'Add to the table' }).isDisabled(), true);
    await ground.getByRole('button', { name: 'Cancel' }).click();
  });

  test('a starter sets the layers, the map life and the theme, and another takes it back (#390)', async ({ studio }) => {
    const guide = await guidePage(studio);
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.locator('.wz h2', { hasText: 'Start from…' }).waitFor();
    assert.deepEqual(await guide.locator('.wz-starter').evaluateAll((cards) => cards.map((c) => c.dataset.starter)), ['climate', 'movement', 'story', 'blank']);
    const savedTv = () => studio.saved().tv;
    // The sample has most layers already; Movement adds the one it lacks, Street life, at rest.
    await guide.locator('.wz-starter[data-starter="movement"]').click();
    await guide.locator('.wz-starter[data-starter="movement"][aria-checked="true"]').waitFor();
    await until(() => studio.savedLayers().some((l) => l.use === 'street-life'), 'Movement adding Street life');
    // Another pick takes back what the first added, and keeps the table's own layers.
    await guide.locator('.wz-starter[data-starter="story"]').click();
    await guide.locator('.wz-starter[data-starter="story"][aria-checked="true"]').waitFor();
    await until(() => !studio.savedLayers().some((l) => l.use === 'street-life') && savedTv().theme_name === 'paper', 'Story taking Street life back and setting its theme');
    assert.ok(studio.savedLayers().some((l) => l.use === 'wind'), 'the table keeps its own layers');
    await studio.shot(guide, 'wizard');
    await guide.locator('.wz-starter[data-starter="blank"]').click();
    await guide.locator('.wz-starter[data-starter="blank"][aria-checked="true"]').waitFor();
    // Blank keeps the default look, which leaves no tv settings of its own behind.
    await until(() => !savedTv().theme_name, 'Blank going back to the default theme');
    assert.deepEqual(savedTv(), { attract_s: 2, idle_reset_s: 0 }, 'the default look leaves no tv settings behind');
  });

  test('the last step hands over to the editor, which does not offer the guide again (#382)', async ({ studio }) => {
    const guide = await guidePage(studio);
    await guide.getByRole('button', { name: 'Next' }).click();
    await guide.getByRole('button', { name: 'Open the editor' }).click();
    await guide.locator('.ed-tree .ed-row[data-context="home"]').waitFor();
    assert.equal(await guide.locator('.wz').count(), 0);
    // A reload stays in the editor.
    assert.equal(await guide.evaluate(() => location.search.includes('welcome')), false);
    // The guide only starts a table (#382): once in the editor, it does not come back as a second editor.
    assert.equal(await guide.getByRole('button', { name: 'Setup guide' }).count(), 0);
    // A table with its place, its map at rest and its layers has nothing left to ask for.
    assert.equal(await guide.locator('.ed-next').isVisible(), false);
    // Its first step is Design › Table size and place… (#382).
    await guide.locator('.ed-tab[data-tab="design"]').click();
    await guide.locator('[data-command="dialog.place"]').click();
    await guide.locator('dialog.is-place [data-setting="table.name"]').waitFor();
    assert.equal(await guide.locator('dialog.is-place [data-setting="table.timezone"]').count(), 1);
    await guide.keyboard.press('Escape');
    await guide.locator('dialog.is-place').waitFor({ state: 'detached' });
  });
});
