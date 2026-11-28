// The phones (#335, #339): joining by QR code or by typing the code, a phone's layers and tools,
// coming back after a reload, and the operator looking after them.
const jsQR = require('jsqr');
const { test, assert, controller, devSurface, layerCard, namePhone, phoneJoined } = require('./studio.cjs');

test.describe('phones', () => {
  test('the controller\'s QR code carries the join address, and a wrong code gets the code form', async ({ studio }) => {
    const { tv } = await controller(studio);
    // Read the code the way a phone camera would.
    const pixels = await tv.locator('.join-qr svg').evaluate(async (svg) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 330;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 330, 330);
      return Array.from(context.getImageData(0, 0, 330, 330).data);
    });
    const scanned = jsQR(Uint8ClampedArray.from(pixels), 330, 330)?.data;
    assert.equal(scanned, `${studio.base}/phone?c=${studio.code}`, 'the QR code carries the join address');
    // Without the right code a phone gets the code form, not the controls.
    const stranger = await studio.open(`/phone?c=${studio.code === '0000' ? '1111' : '0000'}`, { width: 390, height: 800 });
    await stranger.getByText('That code did not work').waitFor();
  });

  test('a phone lists every layer, opens one, and is named by its visitor (#335, #339)', async ({ studio }) => {
    const { tv } = await controller(studio);
    const { phone, openApp } = await phoneJoined(studio);
    await openApp('Sunlight');
    await layerCard(phone, 'Sunlight').getByLabel('Time of day').waitFor();
    await phone.getByRole('button', { name: 'Back to all layers' }).click();
    // The phone is an animal with a fun name (#339); its visitor names it and picks the whale.
    await namePhone(phone, 'Ada');
    await studio.shot(phone, 'phone-profile');
    await phone.getByRole('button', { name: 'Done' }).click();
    await phone.locator('.phone-badge', { hasText: 'Ada' }).waitFor();
    await tv.locator('.join-person[title="Ada"]', { hasText: '🐳' }).waitFor();
    // A phone has the visitor's controls only.
    assert.equal(await phone.getByText('Opacity').count(), 0);
    await tv.getByText('1 phone', { exact: true }).waitFor();
  });

  test('a phone turns a layer on beside the open one, and the controller says who did it (#473)', async ({ studio }) => {
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    const { phone } = await phoneJoined(studio);
    await namePhone(phone, 'Ada');
    await phone.getByRole('button', { name: 'Done' }).click();
    const sunlight = layerCard(phone, 'Sunlight');
    const windCard = phone.locator('.layer-card', { hasText: 'Wind' });
    await windCard.getByLabel('Turn Wind on or off').check();
    // The controller follows, and says a phone did it; the open Sunlight stays, as the two share the table.
    await tv.getByText('Ada turned on Wind').waitFor();
    await sunlight.locator('input.switch:checked').waitFor();
    // The rail's buttons fade between pressed and not.
    if (studio.shots) await tv.waitForTimeout(800);
    await studio.shot(tv, 'tv-phone-cue');
    await studio.shot(phone, 'phone-switch');
    // The phone turns Wind off again; Sunlight stays.
    await windCard.getByLabel('Turn Wind on or off').uncheck();
    await windCard.locator('input.switch:not(:checked)').waitFor();
    await sunlight.locator('input.switch:checked').waitFor();
  });

  test('a time set on a phone moves the controller\'s sun', async ({ studio }) => {
    const { tv, press } = await controller(studio);
    await press('Sunlight', true);
    const { phone, openApp } = await phoneJoined(studio);
    await openApp('Sunlight');
    await layerCard(phone, 'Sunlight').getByLabel('Time of day').fill('18');
    await tv.locator('.sun-hero-clock b', { hasText: '18:00' }).waitFor();
    // The controller's sky follows the phone: at six in the evening the sun is in the west.
    await tv.locator('.sun-hero-fact b', { hasText: /^west$/ }).waitFor();
  });

  test('a point, a line, an area and a pen stroke drawn on a phone arrive on the table, and the controller clears them', async ({ studio }) => {
    const { dev, table } = await devSurface(studio);
    const { tv } = await controller(studio);
    const { phone, openApp } = await phoneJoined(studio);
    await openApp('Sketch');
    const pad = phone.locator('.layer-card', { hasText: 'Sketch' }).locator('.tool-map');
    // The pad is found again for each tap: the page may have scrolled.
    const tap = async (u, v) => {
      await pad.scrollIntoViewIfNeeded();
      const box = await pad.boundingBox();
      await phone.mouse.click(box.x + u * box.width, box.y + v * box.height);
    };
    await dev.waitForTimeout(500);
    const before = await table.screenshot();
    await tap(0.5, 0.5);
    // The sketch's panel counts the marks (#137: a stat tile, which fits its tile at any canvas height).
    const marks = (n) => tv.locator('[data-panel$="/marks"] .mrs-number', { hasText: new RegExp(`^${n}$`) }).waitFor();
    await marks(1);
    await dev.waitForTimeout(500);
    const marked = await table.screenshot();
    assert.notDeepEqual(marked, before, 'the point should be drawn on the table');

    await phone.getByRole('radio', { name: 'Route' }).click();
    assert.equal(await phone.getByRole('button', { name: 'Send line' }).isDisabled(), true, 'a line needs two points');
    await tap(0.2, 0.3);
    await tap(0.4, 0.7);
    await tap(0.6, 0.3);
    await phone.getByRole('button', { name: 'Undo' }).click();
    await tap(0.7, 0.4);
    await phone.getByRole('button', { name: 'Send line' }).click();
    await phone.getByText('Sent to the table.').waitFor();
    await marks(2);

    await phone.getByRole('radio', { name: 'Area' }).click();
    await tap(0.75, 0.6);
    await tap(0.95, 0.6);
    await tap(0.85, 0.9);
    await studio.shot(phone, 'phone');
    await phone.getByRole('button', { name: 'Send area' }).click();
    await marks(3);
    // The pen draws with one stroke and sends when the finger lifts; the phone takes its own mark back (#335).
    await phone.getByRole('radio', { name: 'Pen' }).click();
    {
      await pad.scrollIntoViewIfNeeded();
      const box = await pad.boundingBox();
      await phone.mouse.move(box.x + 0.2 * box.width, box.y + 0.2 * box.height);
      await phone.mouse.down();
      for (const [u, v] of [[0.3, 0.3], [0.4, 0.25], [0.5, 0.35]]) await phone.mouse.move(box.x + u * box.width, box.y + v * box.height, { steps: 5 });
      await phone.mouse.up();
    }
    await marks(4);
    await phone.getByRole('button', { name: 'Take back my last mark' }).click();
    await marks(3);
    await dev.waitForTimeout(500);
    assert.notDeepEqual(await table.screenshot(), marked, 'the line and the area should be drawn too');
    await studio.shot(dev, 'dev-sketch');

    // The controller clears the sketch, from the sketch's More settings.
    await tv.locator('.layer-open', { hasText: 'Mark places' }).locator('summary', { hasText: 'More settings' }).click();
    await tv.getByRole('button', { name: 'Clear the sketch' }).click();
    // With no marks left, the marks card leaves the canvas (#752).
    await tv.locator('[data-panel$="/marks"]').waitFor({ state: 'detached' });
  });

  test('a second phone types the code and gets the next slot; a reload keeps the first phone\'s own', async ({ studio }) => {
    const { tv } = await controller(studio);
    const { phone } = await phoneJoined(studio);
    await namePhone(phone, 'Ada');
    await phone.getByRole('button', { name: 'Done' }).click();
    await phone.locator('.phone-badge', { hasText: 'Ada' }).waitFor();
    const typist = await studio.open('/phone', { width: 390, height: 800 });
    await typist.getByLabel('Session code').fill(studio.code);
    await typist.getByRole('button', { name: 'Join' }).click();
    await typist.locator('.phone-badge').waitFor();
    await tv.getByText('2 phones').waitFor();
    // A reload brings the first phone back to its own slot instead of a third one.
    await phone.reload();
    await phone.locator('.phone-badge', { hasText: 'Ada' }).waitFor();
    await tv.getByText('2 phones').waitFor();
    assert.equal(await tv.locator('.join-person').count(), 2);
    await studio.shot(tv, 'tv');
  });

  test('the operator pauses the phones and lets one go from the Developer window (#335)', async ({ studio }) => {
    const dev = await studio.open('/dev', { width: 1500, height: 800 });
    const { phone } = await phoneJoined(studio);
    await namePhone(phone, 'Ada');
    await phone.getByRole('button', { name: 'Done' }).click();
    const phones = dev.locator('.phones-panel');
    await phones.locator('li', { hasText: 'Ada' }).waitFor();
    await phones.locator('input.switch').check();
    await phone.locator('.phones-paused:not([hidden])').waitFor();
    await phones.locator('input.switch').uncheck();
    await phone.locator('.phones-paused[hidden]').waitFor({ state: 'attached' });
    await phones.locator('li', { hasText: 'Ada' }).getByRole('button', { name: 'Let Ada go' }).click();
    await phone.getByText('Thanks for joining').waitFor();
  });
});
