// The editor's scene list (#182, #183, #368, #382, #385, #69): map life at rest, layers and their
// buttons, and the live controller beside the map.
const { test, assert, controller, layerCard } = require('./studio.cjs');

/** The editor, with New layer from Insert's gallery (#460); the rest of these steps work from Home. */
async function editorPage(studio) {
  const editor = await studio.open('/edit', { width: 1440, height: 900 });
  await editor.locator('.ed-row[data-context="home"]').waitFor();
  const newLayer = async (pick, back = true) => {
    await editor.locator('.ed-tab[data-tab="insert"]').click();
    await editor.locator('.ed-ribbon [data-command="layer.new"]').click();
    await editor.locator(`.lg-gallery .lg-card[data-layer="${pick}"] .lg-pick`).click();
    await editor.locator('.lg-gallery').waitFor({ state: 'detached' });
    if (back) await editor.locator('.ed-tab[data-tab="home"]').click();
  };
  return { editor, newLayer };
}

test.describe('editor scene', () => {
  test('the list holds the layers, and map life under At rest (#382)', async ({ studio }) => {
    const { editor } = await editorPage(studio);
    assert.deepEqual(await editor.locator('.ed-tree .ed-row.is-layer[data-layer] .ed-row-label').allTextContents(), ['Building uses', 'Wind', 'Mobility', 'Isovist', 'Cool paths', 'Sketch', 'Slideshow', 'Sunlight']);
    assert.deepEqual(await editor.locator('.ed-tree .ed-row.is-rest .ed-row-label').allTextContents(), ['Trees', 'Public transport', 'Traffic', 'Building lights', 'Base map']);
  });

  test('a second Trees asks first, and map life is hidden, moved and removed from the ribbon (#183, #182)', async ({ studio }) => {
    const { editor, newLayer } = await editorPage(studio);
    await newLayer('trees', false);
    // Trees are already at rest, so the editor asks before adding a second one (#183).
    await editor.locator('.ed-ask h2', { hasText: 'Trees is already on the map at rest' }).waitFor();
    await editor.locator('.ed-ask [data-choice="add"]').click();
    await editor.locator('.ed-tree .ed-row[data-layer="trees-2"][aria-current="true"]').waitFor();
    await editor.locator('.ed-tab[data-tab="home"]').click();
    // Ambient life joins the home screen, under the layers.
    assert.equal(studio.savedLayers()[6].id, 'trees-2');
    // Its eye hides it, and that is saved.
    await editor.locator('.ed-tree .ed-row[data-layer="trees-2"] [data-setting="maplife.shown"]').click();
    await editor.waitForFunction(() => document.querySelector('.ed-tree .ed-row[data-layer="trees-2"]')?.classList.contains('is-off'));
    assert.equal(studio.savedLayers()[6].active, false);
    // The ribbon's tools act on what is selected.
    await editor.locator('.ed-ribbon').getByText('Move down').click();
    await editor.waitForFunction(() => document.querySelectorAll('.ed-tree .ed-row.is-rest[data-layer]')[1]?.getAttribute('data-layer') === 'trees-2');
    assert.equal(studio.savedLayers()[5].id, 'trees-2');
    await editor.locator('.ed-ribbon').getByText('Remove').click();
    await editor.locator('.ed-tree .ed-row[data-layer="trees-2"]').waitFor({ state: 'detached' });
    // The ribbon stays the same whatever is selected (#182): nothing selected greys the selection tools out.
    assert.equal(await editor.locator('.ed-ribbon').getByRole('button', { name: 'Remove', exact: true }).isDisabled(), true);
  });

  test('opening a tab changes the ribbon only, not the selection (#385)', async ({ studio }) => {
    const { editor } = await editorPage(studio);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    for (const tab of ['insert', 'design', 'present', 'view', 'help', 'home']) {
      await editor.locator(`.ed-tab[data-tab="${tab}"]`).click();
      await editor.locator('.ed-tree .ed-row[data-layer="mobility"][aria-current="true"]').waitFor();
      assert.equal(await editor.locator('.ed-inspector-head strong').textContent(), 'Mobility');
    }
  });

  test('map life taken out comes back from the gallery, the base map at the bottom (#368)', async ({ studio }) => {
    const { editor, newLayer } = await editorPage(studio);
    const restRow = (id) => editor.locator(`.ed-tree .ed-row.is-rest[data-layer="${id}"]`);
    for (const id of ['basemap', 'trees']) {
      await restRow(id).click();
      await editor.locator('.ed-ribbon [data-command="layer.remove"]').click();
      await restRow(id).waitFor({ state: 'detached' });
      await newLayer(id);
      await restRow(id).waitFor();
      const first = studio.savedLayers()[0];
      assert.equal(first.id ?? first.use, 'basemap', id === 'basemap' ? 'the base map goes back to the bottom' : 'map life goes back above the base map');
    }
    assert.deepEqual(studio.layerIds(), ['basemap', 'sunlight', 'building-lights', 'cars', 'transit', 'trees', 'slideshow', 'sketch', 'coolpaths', 'isovist', 'mobility', 'wind', 'uses']);
  });

  test('inside a layer, the gallery\'s map life is an item that shows while the layer is open (#69)', async ({ studio }) => {
    const { editor, newLayer } = await editorPage(studio);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    await newLayer('trees');
    await editor.locator('.ed-tree .ed-row.is-item[data-layer="trees-2"][aria-current="true"]').waitFor();
    await editor.locator('.ed-inspector [data-items="mobility"] .ed-row[data-layer="trees-2"]').waitFor();
    assert.deepEqual(studio.savedLayer('mobility').items, [{ use: 'trees', id: 'trees-2' }]);
    assert.ok(!studio.savedLayers().some((l) => l.id === 'trees-2'), 'an item is not a layer of the scene');
    await editor.getByLabel('Comes on with the layer').waitFor();
    await editor.locator('.ed-ribbon').getByText('Remove').click();
    await editor.locator('.ed-tree .ed-row[data-layer="trees-2"]').waitFor({ state: 'detached' });
    assert.equal(studio.savedLayer('mobility').items, undefined);
  });

  test('the eye beside a setting takes that control off the controller, and is saved', async ({ studio }) => {
    const { editor } = await editorPage(studio);
    const { tv, press } = await controller(studio);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    await editor.locator('.ed-inspector').getByText('Show trips').waitFor();
    await editor.getByRole('switch', { name: 'Show Show trips on the controller' }).click();
    await editor.waitForFunction(() => document.querySelector('.ed-eye[aria-label="Show Show trips on the controller"]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(studio.savedLayer('mobility').hide, ['trips']);
    await press('Mobility', true);
    const card = layerCard(tv, 'Mobility');
    assert.equal(await card.getByText('Show trips').isVisible(), false);
    assert.equal(await card.getByRole('radiogroup', { name: 'Speed' }).isVisible(), true);
    await editor.getByRole('switch', { name: 'Show Show trips on the controller' }).click();
    await card.getByText('Show trips').waitFor();
    assert.equal(studio.savedLayer('mobility').hide, undefined);
  });

  test('a layer\'s button (name, description, side, icon, group) is saved and the controller goes by it', async ({ studio }) => {
    const { editor } = await editorPage(studio);
    const { tv, press } = await controller(studio);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    await editor.getByLabel('Name').fill('Getting here');
    await editor.getByLabel('Name').blur();
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"] .ed-row-label', { hasText: 'Getting here' }).waitFor();
    await editor.getByLabel('Description').fill('How people reach the square');
    await editor.getByLabel('Description').blur();
    await editor.getByRole('radiogroup', { name: 'Side of the controller' }).getByText('Right').click();
    await editor.getByRole('radiogroup', { name: 'Icon' }).getByLabel('tram').click();
    await editor.locator('.ed-tree .ed-rail[data-side="right"] .ed-row[data-layer="mobility"]').waitFor();
    await editor.locator('.ed-canvas-head strong', { hasText: 'Getting here' }).waitFor();
    await editor.waitForFunction(() => document.querySelector('.ed-icon-choice[aria-label="tram"]')?.getAttribute('aria-checked') === 'true');
    assert.deepEqual(studio.savedLayer('mobility').button, { name: 'Getting here', description: 'How people reach the square', side: 'right', icon: 'tram' });
    // The controller goes by the same words.
    await tv.locator('.controller-right .layer-button', { hasText: 'Getting here' }).waitFor();
    // A group puts the button under the group's name on its rail.
    await editor.getByLabel('Group').fill('Movement');
    await editor.getByLabel('Group').blur();
    await tv.locator('.controller-right .rail-group', { hasText: 'Movement' }).waitFor();
    assert.equal(studio.savedLayer('mobility').button.group, 'Movement');
    await press('Getting here', true);
    await tv.getByText('How people reach the square').waitFor();
    await studio.shot(tv, 'tv-buttons');
    await press('Getting here', false);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"]').click();
    await studio.shot(editor, 'editor');
    // Each field saves when it loses the focus; the Format pane is drawn again with the new words, so the
    // focus is let go from the page rather than from a field that may already have been replaced.
    const clear = async (label) => {
      await editor.getByLabel(label).fill('');
      await editor.evaluate(() => document.activeElement?.blur());
    };
    await clear('Name');
    await editor.waitForFunction(() => document.querySelector('.ed-inspector-head strong')?.textContent === 'Mobility');
    await clear('Description');
    await clear('Group');
    // The operator's own rail headings (Map controls, About) stay; the layer group heading goes.
    await tv.locator('.rail-group', { hasNotText: /^(Map controls|About)$/ }).first().waitFor({ state: 'detached' });
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"] .ed-row-label', { hasText: 'Mobility' }).waitFor();
    await tv.locator('.controller-right .layer-button', { hasText: 'Mobility' }).waitFor();
  });

  test('the editor follows presses on the live controller; pressing the open layer again goes back to the map at rest', async ({ studio }) => {
    const { editor } = await editorPage(studio);
    const { tv, press } = await controller(studio);
    // Opening a layer closes the one that was open, except a layer made to run alongside.
    await press('Sunlight', true);
    // The editor shows the live controller beside the map, and follows a press on it.
    await editor.locator('.ed-tree .ed-row[data-layer="sunlight"][aria-current="true"]').waitFor();
    await editor.frameLocator('.ed-preview iframe').locator('.layer-open-name', { hasText: 'Sunlight' }).waitFor();
    await press('Mobility', true);
    await editor.locator('.ed-tree .ed-row[data-layer="mobility"][aria-current="true"]').waitFor();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Sunlight' }).waitFor();
    await tv.locator('.layer-button[aria-pressed="true"]', { hasText: 'Sketch' }).waitFor();
    // There is no Home button: pressing the open layer again closes it, and the editor goes back to the map at rest.
    assert.equal(await tv.getByRole('button', { name: 'Home', exact: true }).count(), 0);
    await tv.locator('.layer-button', { hasText: 'Mobility' }).click();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Mobility' }).waitFor();
    await editor.locator('.ed-row[data-context="home"][aria-current="true"]').waitFor();
  });

  test('the old scene composer\'s address opens the editor (#87)', async ({ studio }) => {
    const compose = await studio.open('/compose', { width: 1440, height: 900 });
    await compose.waitForURL(/\/edit/);
    await compose.locator('.ed-ribbon').waitFor();
  });
});
