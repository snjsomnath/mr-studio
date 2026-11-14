// Bundles the server into one file, dist/mrstudio-mcp.mjs, with a snapshot of the core's
// layers, docs and building blocks taken from this checkout. The file runs on Node 20+ on
// Windows, macOS and Linux with nothing else installed.

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const root = resolve(pkg, '..', '..');

// The catalog loader is TypeScript; Node 22.18+ runs it directly.
const { loadLive } = await import(pathToFileURL(join(pkg, 'src', 'core.ts')).href);
const catalog = loadLive(root);
const snapshot = { ...catalog, root: null, source: 'snapshot' };

mkdirSync(join(pkg, 'dist'), { recursive: true });
await build({
  entryPoints: [join(pkg, 'src', 'index.ts')],
  outfile: join(pkg, 'dist', 'mrstudio-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { __MRSTUDIO_CATALOG__: JSON.stringify(JSON.stringify(snapshot)) },
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(`built dist/mrstudio-mcp.mjs: core ${catalog.version}, ${catalog.layers.length} layers, ${Object.keys(catalog.docs).length} docs, ${catalog.blocks.filter((b) => b.status === 'built').length}/${catalog.blocks.length} blocks built`);
