// Writes apps/studio/ui/app-commands.d.ts from the commands apps/studio/src-tauri/build.rs names
// (#544), so calling an app command that does not exist from the app's own pages is a type error.
// Also checks that main.rs registers the same commands as build.rs permits.
// `node scripts/app-commands.mjs --check` fails when either is out of step; `pnpm typecheck` runs it.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps', 'studio');
const out = join(app, 'ui', 'app-commands.d.ts');

const build = readFileSync(join(app, 'src-tauri', 'build.rs'), 'utf8');
const listed = /commands\(&\[([\s\S]*?)\]\)/.exec(build);
if (!listed) throw new Error('build.rs: no AppManifest::new().commands(&[...]) list');
const commands = [...listed[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);

const main = readFileSync(join(app, 'src-tauri', 'src', 'main.rs'), 'utf8');
const handler = /generate_handler!\[([\s\S]*?)\]/.exec(main);
if (!handler) throw new Error('main.rs: no generate_handler![...]');
const registered = handler[1].split(',').map((s) => s.trim().split('::').pop()).filter(Boolean);
const missing = commands.filter((c) => !registered.includes(c));
const unlisted = registered.filter((c) => !commands.includes(c));
if (missing.length || unlisted.length) {
  console.error(`build.rs and main.rs disagree. Permitted but not registered: ${missing.join(', ') || 'none'}. Registered but not permitted: ${unlisted.join(', ') || 'none'}.`);
  process.exit(1);
}

const text = `// Written by scripts/app-commands.mjs from apps/studio/src-tauri/build.rs (#544). Do not edit.
// The app's own pages call these through window.__TAURI__.core.invoke.

/** A command the app answers, as build.rs permits and main.rs registers it. */
type AppCommand =
${commands.map((c) => `  | '${c}'`).join('\n')};

interface Window {
  __TAURI__: {
    core: {
      invoke<T = any>(command: AppCommand, args?: Record<string, unknown>): Promise<T>;
    };
    event: {
      listen<T = any>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
    };
  };
}
`;

if (process.argv.includes('--check')) {
  let saved = '';
  try {
    saved = readFileSync(out, 'utf8');
  } catch {}
  if (saved !== text) {
    console.error('apps/studio/ui/app-commands.d.ts is out of date: run `node scripts/app-commands.mjs`');
    process.exit(1);
  }
} else writeFileSync(out, text);
