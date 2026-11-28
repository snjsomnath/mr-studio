// Getting a table going: Add data, Your place's rows, the new-table page, and the editor inside the
// desktop app, where it drives the shell (#51, #63, #128, #129, #393, #580).
const { test, assert, kit } = require('./studio.cjs');
const path = require('node:path');

test.describe('import and new tables', () => {
  test('Add data draws what was read against the table before anything is written', async ({ studio }) => {
    const adder = await studio.open('/edit', { width: 1440, height: 900 });
    await adder.locator('.ed-tab[data-tab="insert"]').click();
    await adder.locator('.ed-ribbon [data-command="data.file"]').click();
    const dialog = adder.locator('dialog.im-dialog');
    // Each kind explains what its file should look like,
    // folded away behind "Show the file format" (#712).
    await studio.shot(dialog, 'import/712-format-folded');
    await dialog.locator('.im-format summary', { hasText: 'Show the file format' }).click();
    await dialog.locator('.im-example', { hasText: 'GeoJSON polygons' }).waitFor();
    await dialog.getByLabel('What the file holds').selectOption('own');
    await dialog.getByLabel('Name of the dataset').fill('Places');
    await dialog.getByLabel('File for the dataset').setInputFiles(path.join(kit, 'places.geojson'));
    await dialog.locator('.im-map .im-map-table').waitFor();
    assert.equal(await dialog.locator('.im-map-data circle').count(), 6);
    await dialog.getByRole('button', { name: /^Add (to|and show on) the table$/ }).click();
    await adder.waitForFunction(() => !document.querySelector('dialog.im-dialog'));
    await adder.locator('.ed-tree .ed-row[data-context="home"]').waitFor();
    assert.equal(studio.saved().data.places, 'data/places.geojson');
  });

  test('in Your place each row explains its file, and offers OpenStreetMap where it has the data', async ({ studio }) => {
    const adder = await studio.open('/edit?setup=1', { width: 1440, height: 900 });
    await adder.locator('.wz-step button', { hasText: 'Data' }).click();
    const streets = adder.locator('.wz-place[data-target="data:roads"]');
    await streets.getByRole('button', { name: 'What a streets file looks like' }).click();
    await streets.locator('.im-example', { hasText: 'LineString' }).waitFor();
    assert.equal(await streets.getByRole('button', { name: 'From OpenStreetMap' }).count(), 1);
    assert.equal(await adder.locator('.wz-place[data-target="trips"]').getByRole('button', { name: 'From OpenStreetMap' }).count(), 0);
  });

  test('the new-table page turns, scales and tiles the table, and asks the app to create it (#128, #129, #580)', async ({ studio }) => {
    // The page is for a table that does not exist yet; the app creates the table.
    const fresh = await studio.open('/new', { width: 1440, height: 900 }, {
      init: () => {
        window.shellCalls = [];
        window.__TAURI__ = { core: { invoke: async (command, args) => (window.shellCalls.push([command, args]), '/sites/harbour') } };
      },
    });
    await fresh.getByLabel('Name').fill('Harbour');
    await fresh.getByRole('button', { name: 'Create the table' }).click();
    await fresh.getByRole('alert').getByText(/paste the coordinates/i).waitFor();
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
    // A new scale keeps the ground and resizes the table, and the table's width and height each
    // set the ground's at that scale, so the table can have any shape (#128).
    const value = (label) => fresh.getByLabel(label).inputValue();
    const scale = () => fresh.locator('input[name="scale"]').inputValue();
    await fresh.getByRole('button', { name: '1 : 2 000' }).click();
    assert.deepEqual([await value('Width, metres'), await value('Height, metres'), await value('Table width, cm'), await value('Table height, cm')], ['1000', '600', '50', '30']);
    await fresh.locator('input[name="scale"]').fill('1250');
    await fresh.locator('.wz-scale-words', { hasText: 'The table, 80 × 48 cm, shows 1 000 × 600 m at 1 : 1 250' }).waitFor();
    await fresh.getByLabel('Table height, cm').fill('60');
    assert.deepEqual([await value('Width, metres'), await value('Height, metres'), await scale()], ['1000', '750', '1250']);
    // The physical table holds still when the ground changes (#580): more ground is a new scale,
    // and the other side follows so the ground keeps the table's shape.
    await fresh.getByLabel('Width, metres').fill('1600');
    assert.deepEqual([await value('Table width, cm'), await scale(), await value('Height, metres')], ['80', '2000', '1200']);
    await fresh.getByLabel('Width, metres').fill('1000');
    assert.deepEqual([await scale(), await value('Height, metres')], ['1250', '750']);
    await fresh.getByLabel('Table height, cm').fill('48');
    assert.deepEqual([await value('Width, metres'), await value('Height, metres'), await value('Table width, cm'), await value('Table height, cm')], ['1000', '600', '80', '48']);
    // 3D-printing tiles: a grid on the map, and a clear problem when they do not fit (#129).
    await fresh.getByLabel('Show 3D-printing tiles').check();
    await fresh.getByLabel('Tile size, cm').fill('16');
    await fresh.locator('.wz-tiles', { hasText: '5 × 3 tiles, 15 to print.' }).waitFor();
    await fresh.getByLabel('Tile size, cm').fill('15');
    await fresh.locator('.wz-tiles .wz-problem', { hasText: 'not a whole number' }).waitFor();
    await fresh.getByRole('button', { name: 'Create the table' }).click();
    await fresh.locator('.wz-foot > .wz-problem', { hasText: 'not a whole number' }).waitFor();
    await fresh.getByLabel('Tile size, cm').fill('16');
    await studio.shot(fresh, 'new-table-tiles');
    // Dragging the corner in covers less ground, keeping the table's shape.
    await fresh.waitForTimeout(200);
    const [nx, ny] = await centreOf('.pm-handle.is-centre');
    const [cx, cy] = await centreOf('.pm-handle.is-corner');
    await fresh.mouse.move(cx, cy);
    await fresh.mouse.down();
    await fresh.mouse.move(nx + (cx - nx) * 0.7, ny + (cy - ny) * 0.7, { steps: 8 });
    await fresh.mouse.up();
    const [width, height] = [Number(await value('Width, metres')), Number(await value('Height, metres'))];
    assert.ok(width > 600 && width < 800, `the corner takes the table to 70% of its width, got ${width}`);
    assert.ok(Math.abs(width / height - 1000 / 600) < 0.05, 'the shape is kept');
    await studio.shot(fresh, 'new-table-map');
    await fresh.getByLabel('Width, metres').fill('1000');
    await fresh.getByLabel('Height, metres').fill('600');
    await fresh.getByRole('button', { name: 'Create the table' }).click();
    await fresh.waitForFunction(() => window.shellCalls.length === 2);
    assert.deepEqual(await fresh.evaluate(() => window.shellCalls), [
      ['create_site', { site: { name: 'Harbour', lat: 57.7069, lon: 11.9386, width_m: 1000, height_m: 600, rotation_deg: 10, table_width_cm: 80, tile_cm: 16, detail: 'normal' } }],
      ['open_site', { path: '/sites/harbour', welcome: true }],
    ]);
    assert.deepEqual(await (await fetch(studio.base + '/features.json')).json(), { new_table_wizard: true });
  });

  test('inside the desktop app the editor drives the shell: Present, windows, Settings and File › Open (#51, #63, #393)', async ({ studio }) => {
    const shelled = await studio.open('/edit', { width: 1440, height: 900 }, {
      init: () => {
        window.shellCalls = [];
        let presenting = false;
        window.__TAURI__ = {
          core: {
            invoke: async (command, args) => {
              window.shellCalls.push(command === 'open_view' ? `open_view ${args.role}` : command === 'file_action' ? `file_action ${args.action}` : command);
              if (command === 'present') presenting = true;
              if (command === 'stop_presenting') presenting = false;
              if (command === 'colour_state') return { displays: [{ display: 0, name: 'Projector', role: null, colour: { saturation: 1.4, contrast: 1, brightness: 1, gamma: 1.2, temperature: 0.3, tint: 0 } }], presets: [], layers: [] };
              return { presenting };
            },
          },
        };
      },
    });
    await shelled.getByRole('button', { name: 'Present', exact: true }).click();
    // The sample's projector is not calibrated on this computer: Present asks first (#63).
    await shelled.locator('.ed-ask', { hasText: 'before presenting' }).getByRole('button', { name: 'Present anyway' }).click();
    await shelled.getByRole('button', { name: 'Stop presenting' }).click();
    await shelled.getByRole('button', { name: 'Present', exact: true }).waitFor();
    // Preview and "Open in a window" ask the app for a window, rather than window.open, which macOS drops (#51).
    let popups = 0;
    shelled.on('popup', () => popups++);
    await shelled.getByRole('tab', { name: 'View' }).click();
    for (const id of ['table', 'tv', 'dev']) await shelled.locator(`.ed-ribbon [data-command="window.${id}"]`).click();
    // Screens and calibration (#382, #393): in the app this computer's screens, calibration and colour
    // have one home, File › Settings. The dialog keeps the table's quality and the way there.
    await shelled.getByRole('tab', { name: 'Present' }).click();
    await shelled.locator('.ed-ribbon [data-command="dialog.screens"]').click();
    await shelled.locator('dialog.is-screens [data-setting="computer.quality"]').waitFor();
    assert.equal(await shelled.locator('dialog.is-screens [data-setting="computer.colour"]').count(), 0, 'colour is set in Settings only');
    await studio.shot(shelled, 'screens-dialog-app');
    await shelled.locator('dialog.is-screens [data-command="settings.computer"]').click();
    await shelled.waitForFunction(() => window.shellCalls.includes('open_settings'));
    await shelled.locator('dialog.is-screens').getByRole('button', { name: 'Close' }).click();
    // The logo is File › Open (#393): it keeps a picture of the map first, then asks the app for the list of tables.
    assert.equal(await shelled.getByRole('button', { name: 'All tables', exact: true }).count(), 0);
    await shelled.locator('button.ed-brand').click();
    assert.equal(await shelled.evaluate(() => window.mrsShellControls), true);
    await shelled.waitForFunction(() => window.shellCalls.includes('file_action open'));
    assert.deepEqual(await shelled.evaluate(() => window.shellCalls.filter((c) => c !== 'presenting_state')), [
      'present', 'stop_presenting', 'open_view table', 'open_view tv', 'open_view dev', 'open_settings', 'file_action open',
    ]);
    assert.equal(popups, 0, 'no browser window is opened inside the app');
  });
});
