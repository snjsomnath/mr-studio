// Pictures for the New layer gallery (#59): each core layer drawn on a running table, saved as a
// small WebP in packages/runtime/public/previews/<layer>.webp.
//
//   pnpm build && cargo build -p mrs-cli
//   cp -r sites/sample /tmp/preview-site
//   target/debug/mrstudio dev --site /tmp/preview-site --web packages/runtime/dist &
//   node scripts/layer-previews.cjs [http://localhost:4170] [layer ...]
//
// Run it on a copy of a site: it adds each layer to the scene, opens it, takes the picture and
// removes it again. A layer that draws nothing without settings gets them from SETTINGS.
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const base = /^https?:/.test(args[0] ?? '') ? args.shift() : 'http://localhost:4170';
const out = path.join(__dirname, '..', 'packages', 'runtime', 'public', 'previews');

/** Settings that make a layer draw something on the sample site. */
const SETTINGS = {
  mapdata: { dataset: 'buildings' },
  plan: { dataset: 'masterplan', opening: 'none' },
};
/** Layers that show another layer inside them (#453) get the plan drawing in theirs. */
const INSIDE = {
  swipe: { use: 'plan', params: { dataset: 'masterplan', opening: 'none' } },
};
/** Files from the sample data kit (samples/kit) brought in first, for layers that show a drawing. */
const KIT = [{ target: 'data:masterplan', file: 'masterplan.svg' }];
/** Seconds a layer runs before its picture is taken: long enough for motion to fill the table. */
const SETTLE = { mobility: 8, wind: 8, stormwater: 14, transit: 8, cars: 8, 'street-life': 8, coolpaths: 6 };
/**
 * Layers that have no picture of their own: they need media, a service or the internet the sample
 * has not got, or they show only where a hand is (the magnifier) or once someone draws (sketch).
 */
const SKIP = new Set(['basemap', 'isovist', 'blocks-demo', 'media', 'wms', 'walkthrough', 'sketch', 'fieldwalk', 'lens']);

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    let next = 1;
    const waiting = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.t === 'welcome') {
        resolve({
          request(m, p) {
            const id = next++;
            socket.send(JSON.stringify({ t: 'req', id, m, p }));
            return new Promise((ok, fail) => waiting.set(id, { ok, fail }));
          },
          close: () => socket.close(),
          welcome: message,
        });
      } else if (message.t === 'res') {
        const wait = waiting.get(message.id);
        waiting.delete(message.id);
        if (!message.ok) wait?.fail(new Error(message.e));
        else wait?.ok(message.r);
      }
    };
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', protocol: 1, role: 'dev' }));
    socket.onerror = () => reject(new Error(`cannot reach ${base}`));
  });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const host = await connect();
  const layers = await fetch(`${base}/api/info`).then((r) => r.json()).catch(() => null);
  const catalogue = (host.welcome.manifests ?? layers?.manifests ?? []).filter((m) => !m.custom);
  const wanted = args.length ? args : catalogue.map((m) => m.id).filter((id) => !SKIP.has(id));
  const kit = path.join(__dirname, '..', 'samples', 'kit');
  for (const { target, file } of KIT) {
    const known = host.welcome.state?.site?.data?.[target.slice(5)];
    if (known) continue;
    const response = await fetch(`${base}/api/data/import?target=${encodeURIComponent(target)}`, {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file) },
      body: fs.readFileSync(path.join(kit, file)),
    });
    if (response.status !== 200) console.warn(`${file}: not brought in (${response.status})`);
  }
  const browser = await chromium.launch();
  const table = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await table.goto(`${base}/table?intro=0`);
  await table.waitForTimeout(3000);
  // Every layer at rest goes off first, so each picture shows its own layer on the bare map.
  const scene = host.welcome.state?.scene ?? [];
  const before = host.welcome.state?.layers ?? {};
  for (const id of scene) if (before[id]?.active) await host.request('layer.activate', { layer: id, active: false }).catch(() => {});
  for (const id of wanted) {
    const manifest = catalogue.find((m) => m.id === id);
    const ambient = manifest && (manifest.category === 'ambient' || manifest.category === 'base');
    let added;
    try {
      added = await host.request('scene.add', { use: id });
      const layer = added?.id ?? id;
      if (SETTINGS[id]) await host.request('layer.set', { layer, params: SETTINGS[id] }).catch(() => {});
      if (INSIDE[id]) {
        const child = await host.request('scene.add', { use: INSIDE[id].use, parent: layer });
        await host.request('layer.set', { layer: child?.id, params: INSIDE[id].params }).catch(() => {});
      }
      if (ambient) await host.request('scene.set', { layer, active: true });
      else await host.request('layer.activate', { layer, active: true });
      await table.waitForTimeout((SETTLE[id] ?? 4) * 1000);
      const png = await table.screenshot({ type: 'png' });
      // Chromium writes the WebP: 480 wide, cropped to 16:9 around the middle of the table.
      const webp = await table.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 270;
        const scale = Math.max(480 / image.width, 270 / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        canvas.getContext('2d').drawImage(image, (480 - w) / 2, (270 - h) / 2, w, h);
        return canvas.toDataURL('image/webp', 0.78).split(',')[1];
      }, png.toString('base64'));
      fs.writeFileSync(path.join(out, `${id}.webp`), Buffer.from(webp, 'base64'));
      console.log(`${id}.webp`);
      await host.request('scene.remove', { layer });
    } catch (error) {
      console.warn(`${id}: ${error.message}`);
      if (added?.id) await host.request('scene.remove', { layer: added.id }).catch(() => {});
    }
  }
  for (const id of scene) if (before[id]?.active) await host.request('layer.activate', { layer: id, active: true }).catch(() => {});
  await browser.close();
  host.close();
})();
