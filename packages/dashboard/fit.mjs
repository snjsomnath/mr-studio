// The dashboard never scrolls and never hides what a panel holds (#681). This opens the
// gallery's fit view in a real browser and fails when any core widget, at any size it takes,
// spills out of its panel: with its example props and with the worst props the rules allow,
// on a 1080p TV and on a 720p screen.
//   pnpm --filter @mrstudio/dashboard fit            Chromium
//   pnpm --filter @mrstudio/dashboard fit webkit     the engine of the Mac app
//   pnpm --filter @mrstudio/dashboard fit msedge     the engine of the Windows app (CI on Windows)
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { fileURLToPath } from 'node:url';

const which = process.argv[2] ?? 'chromium';
const engine = which === 'webkit' ? webkit : chromium;
const root = fileURLToPath(new URL('./gallery/', import.meta.url));
const server = await createServer({ root, configFile: fileURLToPath(new URL('./gallery/vite.config.ts', import.meta.url)), server: { port: 0 }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await engine.launch(which === 'msedge' ? { channel: 'msedge' } : {});
const screens = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
];
let failed = 0;
try {
  for (const viewport of screens) {
    for (const props of ['example', 'worst']) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${url}?view=fit&case=${props}&still`);
      await page.waitForFunction(() => window.__fit, null, { timeout: 60_000 });
      const fit = await page.evaluate(() => window.__fit);
      const name = `${which} ${viewport.width}x${viewport.height} ${props}`;
      const problems = [...fit.overflow.map((o) => `${o.key}: ${o.what} reaches ${o.px}px past the panel's edge`), ...fit.refused.map((i) => `${i.path}: refused, ${i.message}`), ...errors.map((e) => `page error: ${e}`)];
      console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}: ${fit.cases} panels${problems.length ? `, ${problems.length} problems` : ''}`);
      for (const p of problems) console.log(`       ${p}`);
      failed += problems.length;
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
