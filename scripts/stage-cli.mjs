// Builds the mrstudio command line and puts it beside the app in the installer (#320), so the
// MCP server can bring data in with the editor's own code even when the app is closed. It ends up
// in MR Studio.app/Contents/MacOS on a Mac and in the install folder on Windows.
//
//   node scripts/stage-cli.mjs                         this computer's target
//   node scripts/stage-cli.mjs universal-apple-darwin  both Mac targets, joined with lipo
//
// It writes apps/studio/src-tauri/tauri.cli.conf.json; pass it to the build with
// `--config src-tauri/tauri.cli.conf.json`. A plain `cargo build` of the app does not need it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tauri = join(root, 'apps', 'studio', 'src-tauri');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1].trim();
const target = process.argv[2] || host;
const exe = target.includes('windows') ? '.exe' : '';

const build = (triple) => {
  run('cargo', ['build', '--release', '-p', 'mrs-cli', ...(triple === host ? [] : ['--target', triple])]);
  return join(root, 'target', ...(triple === host ? [] : [triple]), 'release', `mrstudio${exe}`);
};

mkdirSync(join(tauri, 'binaries'), { recursive: true });
const out = join(tauri, 'binaries', `mrstudio-${target}${exe}`);
if (target === 'universal-apple-darwin') {
  const parts = ['aarch64-apple-darwin', 'x86_64-apple-darwin'].map(build);
  run('lipo', ['-create', '-output', out, ...parts]);
} else {
  copyFileSync(build(target), out);
}
writeFileSync(join(tauri, 'tauri.cli.conf.json'), `${JSON.stringify({ bundle: { externalBin: ['binaries/mrstudio'] } }, null, 2)}\n`);
console.log(`staged ${out} and wrote apps/studio/src-tauri/tauri.cli.conf.json`);
