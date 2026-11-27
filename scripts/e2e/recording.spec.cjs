// Recorded sessions (#520): the operator records from the Developer window, the controller
// shows a red dot, and the recording is kept with its notes, tags and chapters.
const fs = require('node:fs');
const path = require('node:path');
const { test, assert, controller, until } = require('./studio.cjs');

test.describe('recorded sessions', () => {
  test('the operator records a session, marks two chapters, stops and saves the wrap-up (#521, #522)', async ({ studio }) => {
    const dev = await studio.open('/dev', { width: 1500, height: 900 });
    const { tv, press } = await controller(studio);
    const panel = dev.locator('.record-panel');
    const dot = tv.locator('.recording-dot');
    await dot.waitFor({ state: 'attached' });
    assert.equal(await dot.isHidden(), true, 'no dot before recording');

    await panel.getByRole('button', { name: 'Record this session…' }).click();
    assert.match(await panel.getByLabel('Name').inputValue(), /\d{4}-\d{2}-\d{2}$/, 'the name starts as the table and today');
    await panel.getByLabel('Facilitator').fill('Sanjay');
    await panel.getByLabel('Purpose').fill('Where the new benches go');
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
});
