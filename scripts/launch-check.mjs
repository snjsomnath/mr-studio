// Starts the built desktop app on the sample table and waits for it to come up (#514): the
// host answers, the table it opened is the sample, and a window of the app reports that it is
// drawing. Everything else in CI drives `mrstudio dev` in a browser; this is the one check
// that the program people install starts at all.
//
//   node scripts/launch-check.mjs <path to the built mr-studio program>
//
// It fails, with the app's own output, when the app exits or has not come up in 3 minutes.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const program = process.argv[2];
if (!program) {
  console.error('usage: node scripts/launch-check.mjs <path to the built mr-studio program>');
  process.exit(2);
}
/** The app's usual port (PORT in apps/studio/src-tauri/src/main.rs). */
const base = 'http://127.0.0.1:4170';
const WAIT_MS = 180_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The app writes beside the table (its history, its cache), so it gets a copy.
const site = join(mkdtempSync(join(tmpdir(), 'mrs-launch-')), 'sample');
cpSync(join(root, 'sites/sample'), site, { recursive: true });

const app = spawn(program, [site], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MRS_LOG: 'info' } });
let log = '';
app.stdout.on('data', (d) => (log += d));
app.stderr.on('data', (d) => (log += d));
let exited = null;
app.on('exit', (code, signal) => (exited = `exit code ${code ?? signal}`));
app.on('error', (e) => (exited = `could not be started: ${e.message}`));

const finish = (problem) => {
  app.kill();
  rmSync(dirname(site), { recursive: true, force: true });
  if (problem) {
    console.error(`The app did not come up: ${problem}\n--- what it wrote ---\n${log.slice(-6000)}`);
    process.exit(1);
  }
  process.exit(0);
};

const started = Date.now();
let seen = 'the host never answered';
while (Date.now() - started < WAIT_MS) {
  if (exited) finish(`it stopped (${exited}) after ${Math.round((Date.now() - started) / 1000)} s; ${seen}`);
  await sleep(1000);
  try {
    const report = await (await fetch(`${base}/api/diagnostics?format=json`, { signal: AbortSignal.timeout(5000) })).json();
    const name = report?.table?.name;
    const windows = report?.windows ?? [];
    seen = `the host answered for '${name}' with ${windows.length} window(s) alive`;
    if (name === 'Sample district' && windows.length > 0) {
      console.log(`MR Studio ${report.version} came up in ${Math.round((Date.now() - started) / 1000)} s on ${report.os}: ${seen} (${windows.map((w) => w.role ?? w.window).join(', ')}).`);
      finish();
    }
  } catch {
    // Not up yet.
  }
}
finish(`not in ${WAIT_MS / 1000} s; ${seen}`);
