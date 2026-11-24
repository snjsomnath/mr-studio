// The join page's service worker (#275). The phone page from the table runs in a frame at
// `<root>t/<link>/…`; every request that frame makes (its page, its code under /assets, the
// site's data under /site) is handed to the join page that holds the link to the table, which
// fetches it from the table over WebRTC. The join page's own files are served as usual.
//
// Into the phone page's HTML goes one small script: where the page lives (so it reads its
// surface from the path) and the link's WebSocket in place of the browser's.

const ROOT = new URL('./', self.registration.scope).pathname;
const LINKED = `${ROOT}t/`;
const WAIT_MS = 40_000;
const NO_BODY = new Set([101, 204, 205, 304]);
const DROP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/** `<link>` from a `<root>t/<link>/…` path, or null. */
function linkOf(pathname) {
  if (!pathname.startsWith(LINKED)) return null;
  return pathname.slice(LINKED.length).split('/')[0] || null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const own = linkOf(url.pathname);
  if (own) {
    const rest = url.pathname.slice(LINKED.length + own.length) || '/';
    event.respondWith(forward(event.request, own, rest + url.search));
    return;
  }
  // The join page's own files.
  if (url.pathname.startsWith(ROOT)) return;
  // Anything else on this origin, asked by the phone page (its /assets, /site, /api): the table's.
  event.respondWith(
    (async () => {
      const client = event.clientId ? await self.clients.get(event.clientId) : null;
      const from = client ? linkOf(new URL(client.url).pathname) : null;
      // The phone page's workers are not under t/, but what they load is the table's too.
      if (!from && client && client.type !== 'worker') return fetch(event.request);
      return forward(event.request, from, url.pathname + url.search);
    })(),
  );
});

async function forward(request, link, path) {
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Phones only read from the table.', { status: 405 });
  const headers = [];
  for (const name of ['accept', 'accept-language', 'if-none-match', 'if-modified-since']) {
    const value = request.headers.get(name);
    if (value) headers.push([name, value]);
  }
  const answer = await ask({ type: 'mrs-fetch', link, method, path, headers });
  if (!answer) return new Response('The table did not answer.', { status: 504 });
  const out = new Headers();
  for (const [name, value] of answer.headers) if (!DROP.has(name.toLowerCase())) out.append(name, value);
  out.set('cache-control', 'no-store');
  if (NO_BODY.has(answer.status) || method === 'HEAD') return new Response(null, { status: answer.status, headers: out });
  let body = answer.body;
  const type = out.get('content-type') || '';
  if (link && type.includes('text/html')) body = inject(new TextDecoder().decode(body), link);
  return new Response(body, { status: answer.status, headers: out });
}

/** Asks every join page window; the one holding `link` (or, for none, any) answers. */
async function ask(message) {
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => !linkOf(new URL(c.url).pathname));
  if (!windows.length) return null;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    setTimeout(() => finish(null), WAIT_MS);
    for (const win of windows) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => finish(event.data);
      win.postMessage(message, [channel.port2]);
    }
  });
}

function inject(html, link) {
  const base = JSON.stringify(`${LINKED}${link}/`);
  const home = JSON.stringify(ROOT);
  const script =
    `<script>window.__MRS_BASE__=${base};` +
    `try{if(window.parent===window||!window.parent.__mrsLink)throw 0;window.WebSocket=window.parent.__mrsLink.WebSocket}` +
    `catch(e){location.replace(${home})}</script>`;
  const at = html.search(/<head[^>]*>/i);
  if (at < 0) return script + html;
  const end = html.indexOf('>', at) + 1;
  return html.slice(0, end) + script + html.slice(end);
}
