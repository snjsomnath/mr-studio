// The controller (#74, #76, #137, #473): its home, its rails, Sunlight's hero and panels, and two layers at once.
const { test, assert, controller, devSurface, layerCard, scrub } = require('./studio.cjs');

const clock = '.sun-hero-clock b';

test.describe('controller', () => {
  test('home loops through the layers on the rails, each over a background effect (#74)', async ({ studio }) => {
    const { tv } = await controller(studio);
    const home = tv.locator('.layer-welcome.attract');
    await home.waitFor();
    const firstStop = await home.getAttribute('data-layer');
    await tv.waitForFunction((first) => document.querySelector('.layer-welcome.attract')?.getAttribute('data-layer') !== first, firstStop, { timeout: 8000 });
    await home.locator('.attract-name').filter({ hasText: /\S/ }).waitFor();
    assert.ok(await home.getAttribute('data-effect'), 'each stop has a background effect');
    await studio.shot(tv, 'tv-home');
  });

  test('a controller left alone goes home, as Reset does', async ({ studio }) => {
    const { tv: idle } = await controller(studio, '/tv?idle=2');
    await idle.locator('.layer-button', { hasText: 'Building uses' }).click();
    await idle.locator('.layer-button[aria-pressed="true"]', { hasText: 'Building uses' }).waitFor();
    await idle.locator('.layer-welcome.attract').waitFor({ state: 'hidden' });
    await idle.locator('.layer-welcome.attract').waitFor({ timeout: 8000 });
    await idle.locator('.layer-button[aria-pressed="false"]', { hasText: 'Building uses' }).waitFor();
  });

  test('map life has no button, and the buttons are shared out over both rails', async ({ studio }) => {
    const { tv } = await controller(studio);
    await tv.locator('.layer-button').first().waitFor();
    assert.equal(await tv.locator('.layer-button', { hasText: 'Traffic' }).count(), 0);
    const leftButtons = await tv.locator('.controller:not(.controller-right) .layer-button-card').count();
    const rightButtons = await tv.locator('.controller-right .layer-button-card').count();
    assert.ok(rightButtons > 0 && leftButtons >= rightButtons && leftButtons - rightButtons <= 1, `buttons ${leftButtons} left, ${rightButtons} right`);
  });

  test('a time set on Sunlight\'s sky reaches the host, the engine and the table (#137)', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    // The table is running Sunlight: it publishes the colour key the dashboard shows.
    await dev.locator('[data-panel="sunlight/key"]', { hasText: 'Shade' }).waitFor();
    await dev.waitForTimeout(500);
    const afternoon = await table.screenshot();
    await studio.shot(dev, 'dev-shadows');
    await scrub(tv, 8.5);
    await tv.locator(clock, { hasText: '08:30' }).waitFor();
    await layerCard(dev, 'Sunlight').locator('.control-value', { hasText: '08:30' }).waitFor();
    // The sun comes from the east at half past eight on midsummer morning.
    await tv.locator('.sun-hero-fact b', { hasText: /^east$/ }).waitFor();
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), afternoon, 'shadows should move when the time changes');
  });

  test('an open layer is its hero, its main choices and its panels, which fit the canvas (#137)', async ({ studio }) => {
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    const sunlight = layerCard(tv, 'Sunlight');
    // The open layer is its hero, its main choices and "More settings", closed.
    await sunlight.locator('.controls-primary [role="radio"]', { hasText: 'Midsummer' }).waitFor();
    assert.equal(await sunlight.locator('.controls-primary [role="radio"]', { hasText: 'Midsummer' }).count(), 1);
    assert.equal(await sunlight.getByText('Opacity').isVisible(), false, 'the finer settings wait behind More settings');
    // The TV is a rail of controls beside the dashboard canvas, and the layer's panels sit on the grid.
    // The hero shows the time, so Sunlight brings two panels (tree shade and the colour key). The sketch's
    // marks card stays off while nothing is drawn (#752).
    await tv.locator('[data-panel="sunlight/key"]').waitFor();
    await tv.waitForFunction(() => document.querySelectorAll('.mrs-panel').length === 2);
    // Under the hero the canvas is short, so it has fewer rows, not tiny text (#137): the titles stay
    // readable, both panels share the one page, and nothing spills out of its panel.
    const fit = await tv.evaluate(() => ({
      title: Math.min(...[...document.querySelectorAll('.mrs-panel-title')].map((t) => parseFloat(getComputedStyle(t).fontSize))),
      shown: [...document.querySelectorAll('.mrs-panel')].filter((p) => p.closest('.mrs-page:not([hidden])')).length,
      spills: [...document.querySelectorAll('.mrs-panel-body')].filter((b) => b.scrollHeight > b.clientHeight + 1).length,
    }));
    assert.ok(fit.title >= 16, `panel titles are ${fit.title}px`);
    assert.deepEqual([fit.shown, fit.spills], [2, 0]);
    const band = await tv.locator('[data-panel="sunlight/key"]').boundingBox();
    const canvas = await tv.locator('.mrs-dash').boundingBox();
    assert.ok(band.width > canvas.width * 0.9 && band.y + band.height > canvas.y + canvas.height * 0.9, 'the colour key spans the bottom row');
    assert.equal(await tv.locator('.mrs-issues').isVisible(), false);
    await studio.shot(tv, 'tv-shadows');
  });

  test('Reset closes the open layer and shows the welcome; the sketch tool stays on', async ({ studio }) => {
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    // Reset, the dashed button at the foot of the rail. About is there only when the site has words for it.
    await tv.locator('.action-button[title^="Reset"]').click();
    await tv.locator('.layer-button[aria-pressed="false"]', { hasText: 'Sunlight' }).waitFor();
    await tv.locator('.layer-welcome:not([hidden])').waitFor();
    assert.equal(await tv.locator('.layer-button[aria-pressed="true"]', { hasText: 'Sketch' }).count(), 1);
    assert.equal(await tv.locator('.action-button[title="About"]').count(), 0);
  });

  test('sun hours add up the whole day, and the hero counts daylight instead of a time', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    await dev.locator('[data-panel="sunlight/key"]', { hasText: 'Shade' }).waitFor();
    await dev.waitForTimeout(500);
    const shadows = await table.screenshot();
    await tv.getByRole('radio', { name: 'Sun hours' }).click();
    await dev.getByText('whole day added up').waitFor({ timeout: 120_000 });
    // The hero follows the mode: it counts the day's daylight and has no time to set; the daylight panel arrives.
    await tv.locator(clock, { hasText: /\sh$/ }).waitFor();
    assert.equal(await tv.locator('.sun-hero-play').isVisible(), false);
    await tv.locator('[data-panel="sunlight/daylight"]').waitFor();
    await studio.shot(tv, 'tv-sun-hours');
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), shadows, 'sun hours should look different from shadows');
    await studio.shot(dev, 'dev-sun-hours');
  });

  test('turning a layer off clears it from the table', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { press } = await controller(studio);
    await press('Sunlight', true);
    await dev.locator('[data-panel="sunlight/key"]', { hasText: 'Shade' }).waitFor();
    await dev.waitForTimeout(500);
    const on = await table.screenshot();
    await press('Sunlight', false);
    await dev.locator('.layer-card:not(.is-active)', { hasText: 'Sunlight' }).waitFor();
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), on, 'the overlay should disappear when the layer is off');
  });

  test('two layers at once: Shift-click adds, the chip swaps, a held press adds and a plain press opens one (#473)', async ({ studio }) => {
    const { tv, press } = await controller(studio);
    const lit = (name, on) => tv.locator(`.layer-button[aria-pressed="${on}"]`, { hasText: name }).waitFor();
    await press('Sunlight', true);
    await tv.locator('.layer-button', { hasText: 'Wind' }).click({ modifiers: ['Shift'] });
    await lit('Wind', true);
    await lit('Sunlight', true);
    const pair = tv.locator('.layer-pair');
    await pair.locator('.layer-pair-name', { hasText: 'Sunlight' }).waitFor();
    await tv.locator('.layer-open[data-layer="wind"]:not([hidden])').waitFor();
    assert.ok(await tv.locator('.layer-open[data-layer="sunlight"]').isHidden(), 'only the newest layer shows its controls');
    await studio.shot(tv, 'tv-two-layers');
    // The chip swaps them.
    await pair.locator('.layer-pair-swap').click();
    await tv.locator('.layer-open[data-layer="sunlight"]:not([hidden])').waitFor();
    await pair.locator('.layer-pair-name', { hasText: 'Wind' }).waitFor();
    // Holding a third button until its ring closes adds it, and the older of the two goes.
    const hold = async (name, ms) => {
      const box = await tv.locator('.layer-button', { hasText: name }).boundingBox();
      await tv.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await tv.mouse.down();
      await tv.waitForTimeout(ms);
      await tv.mouse.up();
    };
    await hold('Mobility', 1100);
    await lit('Mobility', true);
    await lit('Sunlight', false);
    await lit('Wind', true);
    // Letting go before the ring closes adds nothing, and doesn't open the layer either.
    await hold('Sunlight', 450);
    await tv.waitForTimeout(800);
    assert.equal(await tv.locator('.layer-button[aria-pressed="true"]', { hasText: 'Sunlight' }).count(), 0, 'a hold let go early adds nothing');
    // A plain press opens one layer alone.
    await tv.locator('.layer-button', { hasText: 'Sunlight' }).click();
    await lit('Sunlight', true);
    await lit('Wind', false);
    await lit('Mobility', false);
    assert.ok(await pair.isHidden());
    // The slideshow never shares the table: Shift-click opens it alone.
    await tv.locator('.layer-button', { hasText: 'Slideshow' }).click({ modifiers: ['Shift'] });
    await lit('Slideshow', true);
    await lit('Sunlight', false);
  });
});
