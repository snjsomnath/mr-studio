// Bundles src/index.ts into dist/index.js, the file MR Studio loads (#277).
// `@mrstudio/sdk` is not bundled: it is read from the app that loads the layer, so the layer
// always runs against that app's SDK. `node build.mjs --watch` rebuilds on every change.
import { build, context } from 'esbuild';

const sdk = {
  name: 'mrstudio-sdk',
  setup(b) {
    b.onResolve({ filter: /^@mrstudio\/sdk$/ }, () => ({ path: 'sdk', namespace: 'mrstudio' }));
    b.onLoad({ filter: /.*/, namespace: 'mrstudio' }, () => ({
      contents: "if (!globalThis.MRStudio) throw new Error('load this layer in MR Studio'); module.exports = globalThis.MRStudio.sdk;",
      loader: 'js',
    }));
  },
};

const options = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/index.js',
  sourcemap: 'inline',
  plugins: [sdk],
  logLevel: 'info',
};

if (process.argv.includes('--watch')) await (await context(options)).watch();
else await build(options);
