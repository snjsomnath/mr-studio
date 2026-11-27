// The table and the core layers: the moving scene, the 3D model and a projector, CoolPaths, Mobility,
// the slideshow, a legend that reveals, and the wind.
const { test, assert, controller, devSurface, layerCard, phoneJoined, scrub } = require('./studio.cjs');

// The 3 x 4 matrix of a test projector for a 1500 x 800 image (see docs/contracts/model.md).
const PROJECTOR = [1242.805279, 295.385556, -503.172347, 720252.706881, -99.105566, -449.278568, -1134.560204, 408103.300056, 0.159737, 0.724142, -0.670896, 966.942839];

test.describe('table and layers', () => {
  test('the dev surface draws the scene in site.json, and its map life moves', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const unmoved = async () => {
      const first = await table.screenshot();
      await dev.waitForTimeout(400);
      return first.equals(await table.screenshot());
    };
    // The layers load their data first, so the scene is given a few seconds to start moving.
    let ambient = false;
    for (let i = 0; i < 20 && !ambient; i++) ambient = !(await unmoved());
    assert.ok(ambient, 'the ambient scene should be moving');
    await studio.shot(dev, 'dev-ambient');
  });

  test('the flat map is draped over the lit 3D model, and the lighting switch changes the table', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    // The sample site lights the twin, so the flat map is laid over it rather than shown on its own.
    await dev.locator('.table-surface.is-draped canvas.table-model').waitFor();
    await scrub(tv, 15);
    await tv.locator('.sun-hero-clock b', { hasText: '15:00' }).waitFor();
    await dev.waitForTimeout(800);
    const relit = await table.screenshot();
    await studio.shot(dev, 'dev-relit');
    // The lighting switch is one of Sunlight's finer settings. With it off the table is the flat map again.
    await layerCard(tv, 'Sunlight').locator('summary', { hasText: 'More settings' }).click();
    await tv.getByLabel('Light the 3D model').uncheck();
    await dev.locator('.table-surface:not(.is-draped)').waitFor();
    await dev.waitForTimeout(800);
    assert.notDeepEqual(await table.screenshot(), relit, 'relighting should change the table');
  });

  test('a calibrated projector shows the twin, and the controller runs the calibration tool (#594)', async ({ studio }) => {
    const { dev } = await devSurface(studio);
    const { tv } = await controller(studio);
    // The projected table takes up a projector calibration the moment the host has one.
    const projected = await studio.open('/table?intro=0', { width: 1500, height: 800 });
    await projected.locator('canvas.table-model').waitFor();
    await projected.waitForTimeout(1500);
    const flat = await projected.screenshot();
    const remote = await studio.join('dev');
    // A projector above and to the south of the model, looking down at it at an angle.
    const projector = { version: 1, matrix: PROJECTOR, image: { width: 1500, height: 800 }, pairs: [], error_px: 0, camera: {} };
    await remote.request('calibration.set', { projector });
    await projected.locator('.table-surface.is-projector').waitFor();
    await projected.waitForTimeout(1500);
    assert.notDeepEqual(await projected.screenshot(), flat, 'the calibrated table should show the twin through the projector');
    await studio.shot(projected, 'table-projector');
    // The dev surface stays a flat preview.
    assert.equal(await dev.locator('.table-surface.is-projector').count(), 0);

    // Any controller can open the calibration tool on the table. It starts from a dark surface and counts corners.
    // The table shows only the cross; the corner to find and the buttons are on the controller (#594).
    await remote.request('calibration.mode', { active: true });
    const panel = tv.locator('.open-layers .calibration-remote');
    await panel.getByText(/^Corner 1 of \d+$/).waitFor();
    assert.equal(await projected.locator('.calibration-remote').count(), 0, 'the table should show no calibration panel');
    await projected.mouse.click(300, 200);
    await panel.getByText('1 of at least 6 corners placed.').waitFor();
    // The controller's arrows nudge the cross on the table.
    const cross = () => projected.locator('.calibration-marker').evaluate((node) => node.style.transform);
    const placedAt = await cross();
    await panel.getByTitle('Right 10 px').click();
    await projected.waitForFunction((was) => document.querySelector('.calibration-marker').style.transform !== was, placedAt);
    assert.match(await cross(), /translate\(310px, 200px\)/);
    await panel.getByRole('button', { name: 'Next', exact: true }).click();
    await panel.getByText(/^Corner 2 of \d+$/).waitFor();
    await studio.shot(projected, 'table-calibrating');
    await studio.shot(tv, 'controller-calibrating');
    await projected.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    await projected.locator('.table-surface.is-projector:not(.is-calibrating)').waitFor();
    assert.equal(await projected.locator('.calibration').count(), 0);
    // The dev surface opened its preview of the tool too.
    await remote.request('calibration.mode', { active: false });
    await dev.locator('.calibration').waitFor({ state: 'detached' });

    // Clearing the calibration brings the flat table back.
    await remote.request('calibration.set', { projector: null });
    await projected.locator('.table-surface:not(.is-projector)').waitFor();
    remote.close();
  });

  test('Cool paths draws the walks, compares their heat, and a phone asks for another walk (#196, #76)', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    const { phone, openApp } = await phoneJoined(studio);
    await dev.waitForTimeout(500);
    const off = await table.screenshot();
    await press('Cool paths', true);
    const cool = layerCard(tv, 'Cool paths');
    // A layer's own panel sits on the dashboard canvas; its controls stay in its card.
    const coolPanel = tv.locator('[data-panel="coolpaths/walks"]');
    await coolPanel.getByText(/less heat|already the coolest/).waitFor();
    // Its drawing starts under its title, never over it (#137).
    const [coolTitle, coolBody] = await Promise.all([coolPanel.locator('.mrs-panel-title').boundingBox(), coolPanel.locator('.coolpaths-verdict').boundingBox()]);
    assert.ok(coolBody.y >= coolTitle.y + coolTitle.height, 'the walks sit under the panel title');
    await dev.waitForTimeout(500);
    const walk = await table.screenshot();
    assert.notDeepEqual(walk, off, 'the network and routes should be drawn');
    assert.match(await coolPanel.locator('[data-route="shortest"][data-fact="length"]').textContent(), /^\d+\sm$/);
    // The demo's comparison: mean PET and heat exposure for each walk.
    assert.match(await coolPanel.locator('[data-route="shortest"][data-fact="pet"]').textContent(), /^\d+\.\d\s°C PET$/);
    assert.match(await coolPanel.locator('[data-route="shortest"][data-fact="heat"]').textContent(), /^\d+\.\dk °C·m heat$/);
    await studio.shot(dev, 'dev-coolpaths');
    // Its hero is the time of day, and says what the coolest walk saves (#76).
    await cool.locator('.mrs-hero-fact', { hasText: /% less heat|is the shortest/ }).waitFor();
    // Its main action is one large button at the top of its stage (#76).
    assert.equal(await cool.locator('.controls-primary button.action', { hasText: 'Try another walk' }).count(), 1);
    await studio.shot(tv, 'tv-coolpaths');
    // A phone may ask for another walk, and the table answers with a different one.
    // Its button sits under the map, beside the walk it changes.
    await openApp('Cool paths');
    await phone.getByRole('tab', { name: 'Map' }).click();
    await phone.getByRole('button', { name: 'Try another walk' }).click();
    await dev.waitForTimeout(800);
    assert.notDeepEqual(await table.screenshot(), walk, 'another walk should be drawn');
  });

  test('Cool paths: with no detour the shortest walk is the coolest, and at night there is no sun to avoid', async ({ studio }) => {
    // The table draws the layer and works out what the controller shows.
    await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Cool paths', true);
    const cool = layerCard(tv, 'Cool paths');
    const coolPanel = tv.locator('[data-panel="coolpaths/walks"]');
    await coolPanel.getByText(/less heat|already the coolest/).waitFor();
    await cool.getByLabel('Longest detour').fill('0');
    await coolPanel.getByText('the shortest walk is already the coolest').waitFor();
    // The time is set on the hero (#76): Home is midnight, and → moves a quarter of an hour.
    await cool.getByRole('slider', { name: 'Time of day' }).focus();
    await tv.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await tv.keyboard.press('ArrowRight');
    await cool.locator('.mrs-hero-readout b', { hasText: '01:00' }).waitFor();
    await cool.locator('.mrs-hero-fact', { hasText: 'is down' }).waitFor();
    await coolPanel.getByText(/the sun is down/).waitFor();
    await coolPanel.getByText(/estimated PET/).waitFor();
  });

  test('Mobility plays the trips over time, paused and scrubbed on its hero (#76)', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Mobility', true);
    const moving = layerCard(tv, 'Mobility');
    const movingPanel = tv.locator('[data-panel="mobility/panel"]');
    await movingPanel.getByText(/of 60 arrived/).first().waitFor();
    await moving.getByRole('button', { name: 'Pause' }).click();
    await moving.getByRole('button', { name: 'Play' }).waitFor();
    const tripsClock = moving.getByRole('slider', { name: 'Time of the trips' });
    await tripsClock.focus();
    await tv.keyboard.press('Home');
    await movingPanel.getByText('0 of 60 arrived').first().waitFor();
    await moving.locator('.mrs-hero-readout b', { hasText: /^0:00min$/ }).waitFor();
    await dev.waitForTimeout(500);
    const start = await table.screenshot();
    await studio.shot(dev, 'dev-mobility');
    await tripsClock.focus();
    await tv.keyboard.press('End');
    await moving.locator('.mrs-hero-fact', { hasText: '60 of 60' }).first().waitFor();
    await studio.shot(tv, 'tv-mobility');
    await movingPanel.getByText('60 of 60 arrived').nth(1).waitFor();
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), start, 'travellers should move with the time');
  });

  test('a slideshow steps through layers with ◀ ▶ and the arrow keys, and loops (#43, #76)', async ({ studio }) => {
    const { tv, press } = await controller(studio);
    await press('Slideshow', true);
    const strip = tv.locator('.layer-open[data-layer="slideshow"] .step-strip');
    await strip.locator('.step-count', { hasText: '1 of 2' }).waitFor();
    await strip.locator('.step-title', { hasText: 'Morning shadows' }).waitFor();
    await strip.locator('.step-source', { hasText: 'NOAA' }).waitFor();
    // The layer on show is part of the slideshow: its button is marked, and it is not a second open layer.
    await tv.locator('.layer-button.is-shown', { hasText: 'Sunlight' }).waitFor();
    assert.equal(await tv.locator('.layer-open:not([hidden])', { hasText: 'Shadows at any moment' }).count(), 0);
    await studio.shot(tv, 'tv-slideshow');
    await strip.getByRole('button', { name: 'Next step' }).click();
    await strip.locator('.step-count', { hasText: '2 of 2' }).waitFor();
    await strip.locator('.step-title', { hasText: 'Street trees' }).waitFor();
    await tv.keyboard.press('ArrowLeft');
    await strip.locator('.step-count', { hasText: '1 of 2' }).waitFor();
    await tv.keyboard.press('ArrowRight');
    await strip.locator('.step-count', { hasText: '2 of 2' }).waitFor();
    // It loops: Next on the last step is the first again.
    await tv.keyboard.press('ArrowRight');
    await strip.locator('.step-count', { hasText: '1 of 2' }).waitFor();
    // Opening the layer on show from its own button takes it out of the slideshow, which closes.
    await tv.locator('.layer-button.is-shown', { hasText: 'Sunlight' }).click();
    await tv.locator('.layer-button[aria-pressed="true"]', { hasText: 'Sunlight' }).waitFor();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Slideshow' }).waitFor();
  });

  test('the legend zone reveals one use at a time, the rest faint (#76)', async ({ studio }) => {
    // The table draws the layer and works out what the controller shows.
    await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Building uses', true);
    const uses = tv.locator('.layer-open[data-layer="uses"]');
    const legendRows = uses.locator('.stage-legend .legend-row');
    await legendRows.nth(3).waitFor();
    assert.equal(await legendRows.count(), 4);
    assert.equal(await uses.locator('.legend-row.is-waiting, .legend-row.is-current').count(), 0, 'the overview shows every use');
    await uses.locator('.step-count', { hasText: '0 of 4 shown' }).waitFor();
    await uses.getByRole('button', { name: 'Next step' }).click();
    await uses.locator('.legend-row.is-current').waitFor();
    assert.equal(await uses.locator('.legend-row.is-waiting').count(), 3);
    // The legend names the reveal, so the strip's row of names steps aside.
    assert.equal(await uses.locator('.step-subs').isVisible(), false);
    // The map's settings are the author's, behind More settings: the stage is the legend and the steps.
    assert.equal(await uses.getByLabel('Colour by', { exact: true }).isVisible(), false);
    await uses.getByRole('button', { name: 'Next step' }).click();
    await uses.locator('.step-count', { hasText: '2 of 4 shown' }).waitFor();
    assert.equal(await uses.locator('.legend-row.is-waiting').count(), 2);
    await studio.shot(tv, 'tv-legend');
  });

  test('the wind settles while it streams, its tracers move, and its hero sets speed and direction (#590)', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    await dev.waitForTimeout(500);
    const calm = await table.screenshot();
    await press('Wind', true);
    await tv.getByText(/Settling, \d+%|Steady/).waitFor({ timeout: 60_000 });
    await dev.getByText(/Fastest spot [\d.]+ m\/s/).waitFor({ timeout: 120_000 });
    const windy = await table.screenshot();
    assert.notDeepEqual(windy, calm, 'wind should draw on the table');
    await dev.waitForTimeout(300);
    assert.notDeepEqual(await table.screenshot(), windy, 'tracers should keep moving');
    // On the controller the wind is set on its hero (#76): the band at its foot is the speed, the dial the direction.
    const windHero = tv.locator('.wind-hero');
    await windHero.getByRole('slider', { name: 'Speed of the wind' }).focus();
    await tv.keyboard.press('PageUp');
    // The dev page draws the wind, the traffic and the lights in software here, and runs well behind:
    // its checks wait longer. "10 m/s" alone also names a colour range, so the dashboard's reading is the one.
    const slow = { timeout: 120_000 };
    await dev.locator('.mrs-dash').getByText('10 m/s', { exact: true }).waitFor(slow);
    await windHero.locator('.wind-hero-readout', { hasText: 'Fresh breeze, from the west' }).waitFor();
    await windHero.getByRole('slider', { name: 'Direction the wind comes from' }).focus();
    await tv.keyboard.press('PageDown');
    await tv.keyboard.press('PageDown');
    await dev.getByText('from the south').waitFor(slow);
    // A tap on the dial turns it there: tapped at the dial's top, the wind comes from the table's top.
    // The dial is drawn anew on every update, so a ring found in one step can be gone by the next and
    // measure 0 × 0, sending the tap to the dial's corner (#590). Where its top is comes from the ring
    // on the page in one go; the place stays the same however often the dial is redrawn.
    const top = await windHero.evaluate((hero) => {
      const box = hero.querySelector('.wind-hero-ring').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + 2 };
    });
    await tv.mouse.click(top.x, top.y);
    await windHero.locator('.wind-hero-dial[aria-valuenow="0"]').waitFor();
    await dev.getByText('from the north').waitFor(slow);
    await studio.shot(tv, 'tv-wind');
  });

  test('the wind\'s speed map holds still, and ribbons come back', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Wind', true);
    await dev.getByText(/Fastest spot [\d.]+ m\/s/).waitFor({ timeout: 120_000 });
    await tv.getByRole('radio', { name: 'Speed map' }).click();
    await dev.waitForTimeout(500);
    const still = await table.screenshot();
    await dev.waitForTimeout(100);
    await studio.shot(dev, 'dev-wind');
    await tv.getByRole('radio', { name: 'Ribbons' }).click();
    await dev.waitForTimeout(1500);
    assert.notDeepEqual(await table.screenshot(), still, 'ribbons should come back');
    await studio.shot(dev, 'dev-wind-ribbons');
  });
});
