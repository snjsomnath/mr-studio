// Recorded sessions (#520): the operator records from the Developer window, the controller
// shows a red dot, and the recording is kept with its notes, tags and chapters.
const fs = require('node:fs');
const path = require('node:path');
const { test, assert, controller, phoneJoined, until } = require('./studio.cjs');

test.describe('recorded sessions', () => {
  test('the operator records a session, marks two chapters, stops and saves the wrap-up (#521, #522)', async ({ studio }) => {
    const dev = await studio.open('/dev', { width: 1500, height: 900 });
    const { tv, press } = await controller(studio);
    const panel = dev.locator('.record-panel');
    const dot = tv.locator('.recording-dot');
    await dot.waitFor({ state: 'attached' });
    assert.equal(await dot.isHidden(), true, 'no dot before recording');

    await panel.getByRole('button', { name: 'Record this session…' }).click();
    assert.match(await panel.getByLabel('Name', { exact: true }).inputValue(), /\d{4}-\d{2}-\d{2}$/, 'the name starts as the table and today');
    await panel.getByLabel('Facilitator').fill('Sanjay');
    await panel.getByLabel('Purpose').fill('Where the new benches go');
    const keepNames = panel.getByLabel('Keep the names people type on their phones');
    assert.equal(await keepNames.isChecked(), false, 'names are left out unless kept (#530)');
    await studio.shot(dev.locator('.record-panel'), 'recording/522-form');
    await panel.getByRole('button', { name: 'Start recording' }).click();
    await panel.locator('.record-on').waitFor();
    await dot.waitFor();
    await studio.shot(tv, 'recording/522-controller-dot');

    await press('Sunlight', true);
    await panel.getByPlaceholder('Chapter title (optional)').fill('Morning sun');
    await panel.getByRole('button', { name: 'Mark a chapter' }).click();
    await panel.locator('.record-chapters li', { hasText: 'Morning sun' }).waitFor();
    await press('Sunlight', false);
    await panel.getByRole('button', { name: 'Mark a chapter' }).click();
    await panel.locator('.record-chapters li').nth(1).waitFor();
    await studio.shot(dev.locator('.record-panel'), 'recording/522-recording');

    await panel.getByRole('button', { name: 'Stop recording' }).click();
    await panel.getByLabel('Notes').fill('Two groups, both chose the square.');
    await panel.getByLabel('Tags').fill('workshop, benches');
    await panel.locator('.record-chapters li').nth(1).locator('input').fill('Evening');
    await dot.waitFor({ state: 'hidden' });
    await studio.shot(dev.locator('.record-panel'), 'recording/522-wrapup');
    await panel.getByRole('button', { name: 'Save the recording' }).click();
    await panel.locator('.record-saved').waitFor();

    // Kept in the recordings folder, never in the table's.
    const kept = () => fs.readdirSync(studio.recordings).filter((d) => fs.existsSync(path.join(studio.recordings, d, 'recording.json')));
    const wrapped = (d) => JSON.parse(fs.readFileSync(path.join(studio.recordings, d, 'recording.json'), 'utf8')).wrapped;
    await until(() => kept().length === 1 && wrapped(kept()[0]), 'the recording saved');
    const listed = kept()[0];
    const folder = path.join(studio.recordings, listed);
    const saved = JSON.parse(fs.readFileSync(path.join(folder, 'recording.json'), 'utf8'));
    assert.equal(saved.facilitator, 'Sanjay');
    assert.deepEqual(saved.tags, ['workshop', 'benches']);
    assert.deepEqual(saved.chapters.map((c) => c.title), ['Morning sun', 'Evening']);
    const log = fs.readFileSync(path.join(folder, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(log.some((e) => e.k === 'request' && e.m === 'layer.activate' && e.role === 'tv'), 'the controller presses are in the log');
    assert.equal(log.at(-1).k, 'stop');
    assert.ok(fs.existsSync(path.join(folder, 'start.json')));
  });

  test('a phone sees the recording notice first, and Just watch keeps nothing from it (#530)', async ({ studio }) => {
    const { phone: joins } = await phoneJoined(studio);
    const { phone: watches } = await phoneJoined(studio);
    const remote = await studio.join('dev');
    const started = await remote.request('recording.start', { notice: 'Workshop for the new square, Lindholmen' });
    const notice = joins.locator('.recording-notice');
    await notice.getByText('This session is being recorded').waitFor();
    await notice.getByText('Workshop for the new square, Lindholmen').waitFor();
    await studio.shot(joins, 'recording/530-phone-notice');
    await notice.getByRole('button', { name: 'Join' }).click();
    await notice.waitFor({ state: 'hidden' });
    // A reload of the same phone is not asked again.
    await joins.reload();
    await joins.locator('.phone-badge').waitFor();
    await joins.waitForTimeout(500);
    assert.equal(await joins.locator('.recording-notice').isHidden(), true, 'answered once per recording');

    await watches.locator('.recording-notice').getByRole('button', { name: 'Just watch' }).click();
    await watches.getByText('You are watching. Nothing from this phone is recorded.').waitFor();
    await studio.shot(watches, 'recording/530-phone-watching');
    await until(async () => (await remote.request('recording.status')).recording !== null, 'still recording');
    await remote.request('recording.stop');
    const log = fs
      .readFileSync(path.join(studio.recordings, started.recording.id, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const phones = log.filter((e) => e.role === 'phone');
    assert.equal(phones[0].k, 'join', 'a phone is in the log from its Join');
    assert.equal(new Set(phones.map((e) => e.slot)).size, 1, `only the phone that joined is in the log: ${JSON.stringify(phones)}`);
    remote.close();
  });

  test('a recording plays back read only, with its events, chapters and notes (#526, #527)', async ({ studio }) => {
    const { press } = await controller(studio);
    const remote = await studio.join('dev');
    const started = await remote.request('recording.start', { name: 'Benches workshop', consent: false });
    await press('Sunlight', true);
    await new Promise((r) => setTimeout(r, 600));
    await remote.request('recording.chapter', { title: 'Wind' });
    await press('Sunlight', false);
    await press('Wind', true);
    await new Promise((r) => setTimeout(r, 1500));
    await remote.request('recording.stop');
    remote.close();

    const base = await studio.play(path.join(studio.recordings, started.recording.id));
    const room = await studio.open(`${base}/playback`, { width: 1600, height: 900 });
    await room.getByText('Recorded session, read only').first().waitFor();
    await room.getByText('Benches workshop').first().waitFor();
    const events = room.locator('.pb-events');
    await events.getByText('Controller opened sunlight').waitFor();
    await events.getByText('Chapter: Wind').waitFor();
    const tv = room.frameLocator('.pb-tv iframe');
    await tv.locator('.recording-dot.is-playback').waitFor();
    const pressed = (name) => tv.locator('.layer-button[aria-pressed="true"]', { hasText: name });

    // A click on an event moves the table and the controller there.
    await events.getByText('Controller opened sunlight').click();
    await pressed('Sunlight').waitFor();
    await events.getByText('Controller closed sunlight').click();
    await pressed('Sunlight').waitFor({ state: 'detached' });
    await room.getByRole('button', { name: 'Chapter ▶' }).click();
    await pressed('Wind').waitFor();
    // Backwards too, from a checkpoint: the chapter was marked while the sun was on.
    await room.getByRole('button', { name: '◀ Chapter' }).click();
    await pressed('Wind').waitFor({ state: 'detached' });
    await pressed('Sunlight').waitFor();

    // The organiser's notes stay with the recording, beside its log.
    await room.locator('.pb-chapter', { hasText: 'Wind' }).click();
    await room.getByPlaceholder('A note at this moment').fill('They chose the square here');
    await room.getByRole('button', { name: 'Add a note here' }).click();
    await room.locator('.pb-notes .pb-item', { hasText: 'They chose the square here' }).waitFor();
    await room.locator('.pb-note-mark').waitFor();
    const notes = JSON.parse(fs.readFileSync(path.join(studio.recordings, started.recording.id, 'notes.json'), 'utf8'));
    assert.equal(notes[0].text, 'They chose the square here');
    await studio.shot(room, 'recording/526-playback-room');

    // Filters: only the controller's layer presses.
    await room.getByLabel('Chapters').uncheck();
    assert.equal(await events.getByText('Chapter: Wind').count(), 0);
    const [file] = await Promise.all([room.waitForEvent('download'), room.getByRole('button', { name: 'Save as CSV' }).click()]);
    const csv = fs.readFileSync(await file.path(), 'utf8');
    assert.match(csv, /note,"Organiser","They chose the square here"/);
    assert.match(csv, /layers,"Controller","Controller opened sunlight"/);
    await studio.shot(room.locator('.pb-side'), 'recording/527-events-notes');

    // Nothing in a recording can be changed from its pages.
    // Play on the table (#528), in the app: the screens are the app's, the timeline stays here.
    const app = await studio.open(`${base}/playback`, { width: 1600, height: 900 }, {
      init: () => {
        window.calls = [];
        window.__TAURI__ = { core: { invoke: async (command) => window.calls.push(command) } };
      },
    });
    const onTable = app.getByRole('button', { name: 'Play on the table' });
    await onTable.click();
    await app.getByRole('button', { name: 'Stop playing on the table' }).waitFor();
    assert.deepEqual(await app.evaluate(() => window.calls), ['present']);
    await studio.shot(app.locator('.pb-timeline'), 'recording/528-play-on-table');
    // A replay shows phones no way to join.
    assert.equal(await room.frameLocator('.pb-tv iframe').locator('section.join').count(), 0);

    const viewer = await studio.join('tv', Number(new URL(base).port));
    await assert.rejects(viewer.request('layer.activate', { layer: 'wind', active: true }), /read only/);
    viewer.close();
  });
});
