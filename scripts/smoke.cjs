// Engine smoke (#261): the table, the controller and the editor in one browser engine, with
// every core layer turned on and off and the display colour pass on, as the desktop app would
// show them. It fails on any error a page throws, and on a frame that takes over 5 s, which is
// how an engine-only hang shows (PR 220: SVG filters froze WebKit on the Mac).
//
//   pnpm build && cargo build -p mrs-cli && node scripts/smoke.cjs [chromium|webkit|msedge] [screenshot-dir]
//
// CI runs it with WebKit on macOS (the Mac app's WKWebView) and with Edge on Windows (WebView2's
// engine); scripts/e2e.cjs covers the rest in Chromium. When an engine trap is found, add a check
// for it under "Known engine traps".
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const playwright = require('playwright');

const root = path.resolve(__dirname, '..');
const engine = process.argv[2] || 'chromium';
const shots = process.argv[3];
const port = 4198;
const base = `http://127.0.0.1:${port}`;
/**
 * A frame slower than this fails the run. CI runners draw without a graphics card, where turning
 * a layer off or on can take 2 to 3 s; the WebKit freeze this guards against held for good.
 */
const LONGEST_FRAME_MS = 5000;
/** Long enough for a layer to load its data and draw a few seconds. */
const LAYER_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A strong colour pass, so every part of the shell's colour.js is on. */
const COLOUR = { saturation: 1.2, contrast: 1.1, brightness: 0.95, gamma: 1.3, temperature: 0.3, tint: 0.1 };

/** Measures the longest gap between frames, from when `__mrsFrames.reset()` is called. */
const FRAME_METER = `(() => {
  let last = 0, longest = 0;
  const tick = (now) => {
    if (last && document.visibilityState === 'visible') longest = Math.max(longest, now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__mrsFrames = { reset: () => { longest = 0; last = 0; }, longest: () => longest };
})();`;

/** A surface without a browser, to turn layers on and off. */
function join(role) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const pending = new Map();
    let next = 1;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', protocol: 1, role }));
    socket.onerror = () => reject(new Error('could not reach the host'));
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.t === 'welcome') {
        resolve({
          state: message.state,
          request: (m, p) =>
            new Promise((done, fail) => {
              const id = next++;
              pending.set(id, { done, fail });
              socket.send(JSON.stringify({ t: 'req', id, m, p }));
            }),
          close: () => socket.close(),
        });
      } else if (message.t === 'res') {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) waiting?.done(message.r);
        else waiting?.fail(new Error(message.e));
      }
    };
  });
}

function launch() {
  if (engine === 'webkit') return playwright.webkit.launch();
  // Edge is Chromium with WebView2's build of it; on Windows runners it is installed already.
  if (engine === 'msedge') return playwright.chromium.launch({ channel: 'msedge' });
  return playwright.chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

(async () => {
  // The test adds layers to site.json, so it runs on a copy of the sample site.
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-smoke-'));
  fs.cpSync(path.join(root, 'sites/sample'), site, { recursive: true });
  const exe = path.join(root, 'target/debug', process.platform === 'win32' ? 'mrstudio.exe' : 'mrstudio');
  const host = spawn(exe, ['dev', '--site', site, '--web', 'packages/runtime/dist', '--port', String(port), '--backend', 'cpu', '--public-url', base], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MRS_JOIN_PAGE: 'off' },
  });
  let log = '';
  host.stdout.on('data', (d) => (log += d));
  host.stderr.on('data', (d) => (log += d));
  const problems = [];
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const browser = await launch();
  console.log(`smoke in ${engine} ${browser.version()}`);
  try {
    for (let i = 0; !/host listening/.test(log); i++) {
      if (i > 300 || host.exitCode !== null) throw new Error(`host did not start:\n${log}`);
      await sleep(100);
    }
    const dev = await join('dev');
    // Every core layer, the ones the sample does not have added off.
    const have = new Set(Object.values(dev.state.layers).map((l) => l.layer));
    for (const dir of fs.readdirSync(path.join(root, 'packages/layers'))) {
      const manifest = path.join(root, 'packages/layers', dir, 'layer.json');
      if (!fs.existsSync(manifest)) continue;
      const { id, category } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (have.has(id) || category === 'base') continue;
      await dev.request('scene.add', { use: id, active: false }).catch((e) => console.warn(`  could not add ${id}: ${e.message}`));
    }

    const open = async (url, viewport) => {
      const page = await browser.newPage({ viewport });
      // Map tiles come from the internet, which a test may not reach.
      await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org|arcgisonline|api\.mapbox\.com/, (route) => route.fulfill({ status: 204 }));
      await page.addInitScript(FRAME_METER);
      page.on('pageerror', (e) => problems.push(`${url}: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && console.warn(`  ${url} console: ${m.text().slice(0, 200)}`));
      await page.goto(base + url);
      return page;
    };
    const table = await open('/table', { width: 1500, height: 800 });
    // The desktop app's colour pass, exactly as the shell injects it on a surface.
    await table.addInitScript({ path: path.join(root, 'apps/studio/src-tauri/src/colour.js') });
    await table.reload();
    await table.evaluate((s) => window.__mrsColour(s), COLOUR);
    const tv = await open('/tv', { width: 1920, height: 1080 });
    const editor = await open('/edit', { width: 1440, height: 900 });
    await sleep(4000);

    const pages = { table, tv, editor };
    const frames = async (what) => {
      for (const [name, page] of Object.entries(pages)) {
        const longest = await page.evaluate(() => window.__mrsFrames.longest());
        if (longest > LONGEST_FRAME_MS) problems.push(`${name}: a frame took ${Math.round(longest)} ms ${what}`);
        else if (longest > 1000) console.log(`  ${name}: slowest frame ${Math.round(longest)} ms ${what}`);
        await page.evaluate(() => window.__mrsFrames.reset());
      }
    };
    await frames('while loading');

    const now = await join('dev');
    const layers = Object.entries(now.state.layers).filter(([, l]) => !l.parent);
    for (const [id, state] of layers) {
      const was = state.active;
      await dev.request('layer.activate', { layer: id, active: !was });
      await sleep(LAYER_MS);
      await frames(`with '${id}' ${was ? 'off' : 'on'}`);
      if (shots && !was) await table.screenshot({ path: path.join(shots, `${engine}-${id}.png`) });
      await dev.request('layer.activate', { layer: id, active: was });
      await sleep(500);
    }
    now.close();

    // The Display tab, as an author opens it to correct the colour.
    await editor.getByRole('tab', { name: 'Display' }).click().catch(() => editor.locator('.ed-tab', { hasText: 'Display' }).first().click());
    await sleep(LAYER_MS);
    await frames('on the Display tab');

    // Known engine traps, each found the hard way.
    // 1. SVG filters over the animated map: WebKit drew them in software and froze (PR 220, #181).
    //    A small one (the sun's soft glow in Sunlight's hero) is fine; one over half the screen is not.
    for (const [name, page] of Object.entries(pages)) {
      const large = await page.evaluate(() => {
        const half = (window.innerWidth * window.innerHeight) / 2;
        const area = (e) => {
          const r = e.getBoundingClientRect();
          return r.width * r.height;
        };
        const svgs = [...document.querySelectorAll('svg')].filter((svg) => svg.querySelector('filter') && area(svg) > half);
        const styled = [...document.querySelectorAll('*')].filter((e) => /url\(/.test(getComputedStyle(e).filter) && area(e) > half);
        return svgs.length + styled.length;
      });
      if (large > 0) problems.push(`${name}: ${large} SVG filter(s) over more than half the screen; WebKit draws them in software (#181)`);
    }

    if (shots) {
      await tv.screenshot({ path: path.join(shots, `${engine}-controller.png`) });
      await editor.screenshot({ path: path.join(shots, `${engine}-editor.png`) });
    }
    dev.close();
  } finally {
    await browser.close();
    host.kill();
  }
  if (problems.length > 0) {
    console.error(`smoke failed in ${engine}:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`smoke passed in ${engine}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
