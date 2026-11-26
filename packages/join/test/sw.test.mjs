// The join page's service worker (#543): which requests go to the table over the link, which
// stay with the web, and what is done to the answer. Every phone at a venue loads this file,
// and nothing else tested it. Run with `node --test` (in `pnpm test`).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://join.example';

// An open message port keeps Node running: every one the worker opens is closed at the end.
const channels = [];
class Channel extends MessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
}
after(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
});

/**
 * The worker as a browser would run it at `/mr/sw.js`, with one join page window open (unless
 * `windows` says otherwise) that answers what it is asked from `table`.
 */
function worker({ table = () => null, windows = [`${ORIGIN}/mr/?t=abc`], clients = {} } = {}) {
  const listeners = {};
  const asked = [];
  const webFetches = [];
  const self = {
    registration: { scope: `${ORIGIN}/mr/` },
    location: new URL(`${ORIGIN}/mr/sw.js`),
    addEventListener: (name, fn) => (listeners[name] = fn),
    skipWaiting: () => {},
    clients: {
      claim: () => {},
      get: async (id) => clients[id] ?? null,
      matchAll: async () =>
        windows.map((url) => ({
          url,
          postMessage(message, [port]) {
            asked.push(message);
            const answer = table(message);
            if (answer) port.postMessage(answer);
          },
        })),
    },
  };
  const context = vm.createContext({
    self, URL, Response, Headers, TextDecoder, MessageChannel: Channel, Set, JSON, Promise,
    setTimeout: () => 0, // the 40 s wait is not waited for here
    fetch: async (request) => (webFetches.push(request.url), new Response('from the web')),
  });
  vm.runInContext(source, context);
  /** What the worker does with a request: `undefined` when it leaves it to the browser. */
  const fetch = (url, { method = 'GET', headers = {}, clientId } = {}) => {
    let answer;
    listeners.fetch({ request: new Request(url, { method, headers }), clientId, respondWith: (r) => (answer = r) });
    return answer;
  };
  return { fetch, asked, webFetches };
}

const answer = (body, type = 'text/plain', status = 200, more = []) => ({
  status,
  headers: [['content-type', type], ...more],
  body: new TextEncoder().encode(body),
});

test("the join page's own files and other origins are left to the browser", () => {
  const sw = worker();
  assert.equal(sw.fetch(`${ORIGIN}/mr/`), undefined);
  assert.equal(sw.fetch(`${ORIGIN}/mr/assets/loader.js`), undefined);
  assert.equal(sw.fetch('https://tiles.example/1/2/3.png'), undefined);
  assert.deepEqual(sw.asked, []);
});

test('a request under t/<link>/ is asked of the table by that link, path and query kept', async () => {
  const sw = worker({ table: () => answer('{"ok":true}', 'application/json', 200, [['Set-Cookie', 'a=b'], ['Content-Length', '999'], ['ETag', '"1"']]) });
  const got = await sw.fetch(`${ORIGIN}/mr/t/k3x9/site/data.json?v=2`, { headers: { accept: 'application/json', cookie: 'secret=1' } });
  assert.equal(sw.asked.length, 1);
  const asked = sw.asked[0];
  assert.equal(asked.type, 'mrs-fetch');
  assert.equal(asked.link, 'k3x9');
  assert.equal(asked.method, 'GET');
  assert.equal(asked.path, '/site/data.json?v=2');
  assert.deepEqual(JSON.parse(JSON.stringify(asked.headers)), [['accept', 'application/json']], 'only the few headers the table needs travel');
  assert.equal(got.status, 200);
  assert.equal(await got.text(), '{"ok":true}');
  assert.equal(got.headers.get('etag'), '"1"');
  assert.equal(got.headers.get('set-cookie'), null, 'the table cannot set cookies on the join page');
  assert.equal(got.headers.get('cache-control'), 'no-store');
});

test("the phone page's HTML gets the link's script, straight after <head>", async () => {
  const sw = worker({ table: () => answer('<!doctype html><html><head lang="en"><title>T</title></head></html>', 'text/html; charset=utf-8') });
  const html = await (await sw.fetch(`${ORIGIN}/mr/t/k3x9/phone`)).text();
  assert.match(html, /<head lang="en"><script>window\.__MRS_BASE__="\/mr\/t\/k3x9\/";/);
  assert.match(html, /location\.replace\("\/mr\/"\)/, 'opened outside the join page, it goes back to the join page');
  assert.equal(sw.asked[0].path, '/phone');
});

test('phones only read: anything but GET and HEAD is refused without asking the table', async () => {
  const sw = worker({ table: () => answer('x') });
  const got = await sw.fetch(`${ORIGIN}/mr/t/k3x9/api/site`, { method: 'POST' });
  assert.equal(got.status, 405);
  assert.deepEqual(sw.asked, []);
  const head = await sw.fetch(`${ORIGIN}/mr/t/k3x9/api/site`, { method: 'HEAD' });
  assert.equal(sw.asked[0].method, 'HEAD');
  assert.equal(await head.text(), '');
});

test('what the phone page asks for outside t/ (its /assets, /site, /api) is the table\'s too', async () => {
  const clients = {
    frame: { url: `${ORIGIN}/mr/t/k3x9/phone`, type: 'window' },
    worker: { url: `${ORIGIN}/assets/data-worker.js`, type: 'worker' },
    other: { url: `${ORIGIN}/elsewhere/page.html`, type: 'window' },
  };
  const sw = worker({ clients, table: () => answer('table') });
  const fromFrame = await sw.fetch(`${ORIGIN}/assets/index.js`, { clientId: 'frame' });
  assert.equal(await fromFrame.text(), 'table');
  assert.equal(sw.asked[0].link, 'k3x9');
  assert.equal(sw.asked[0].path, '/assets/index.js');

  // The phone page's worker is not under t/, but what it loads is the table's: any link answers.
  await sw.fetch(`${ORIGIN}/site/data/trees.geojson`, { clientId: 'worker' });
  assert.equal(sw.asked[1].link, null);
  assert.equal(sw.asked[1].path, '/site/data/trees.geojson');

  // Another page on the same origin is none of the worker's business.
  const fromOther = await sw.fetch(`${ORIGIN}/elsewhere/a.png`, { clientId: 'other' });
  assert.equal(await fromOther.text(), 'from the web');
  assert.equal(sw.asked.length, 2);
  assert.deepEqual(sw.webFetches, [`${ORIGIN}/elsewhere/a.png`]);
});

test('no join page open, or a table that does not answer, is a 504 and not a hang', async () => {
  const none = worker({ windows: [] });
  assert.equal((await none.fetch(`${ORIGIN}/mr/t/k3x9/phone`)).status, 504);
  // Only frames of the phone page are open: they hold no link.
  const framesOnly = worker({ windows: [`${ORIGIN}/mr/t/k3x9/phone`] });
  assert.equal((await framesOnly.fetch(`${ORIGIN}/mr/t/k3x9/phone`)).status, 504);
  assert.deepEqual(framesOnly.asked, []);
});

test('an answer with no body (304) keeps none', async () => {
  const sw = worker({ table: () => answer('', 'text/plain', 304) });
  const got = await sw.fetch(`${ORIGIN}/mr/t/k3x9/site/data.json`, { headers: { 'if-none-match': '"1"' } });
  assert.equal(got.status, 304);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.asked[0].headers)), [['if-none-match', '"1"']]);
});
