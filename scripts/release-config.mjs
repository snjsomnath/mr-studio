// Writes apps/studio/src-tauri/tauri.release.conf.json for a release build: it turns on the
// signed update files and gives the bundler the public key they are checked against.
// The key comes from MRS_UPDATER_PUBKEY; see docs/RELEASING.md.
import { writeFileSync } from 'node:fs';

const pubkey = (process.env.MRS_UPDATER_PUBKEY ?? '').trim();
if (!pubkey) throw new Error('MRS_UPDATER_PUBKEY is not set');
const config = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey, endpoints: ['https://github.com/snjsomnath/mr-studio/releases/latest/download/latest.json'] } },
};
const path = new URL('../apps/studio/src-tauri/tauri.release.conf.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log('wrote apps/studio/src-tauri/tauri.release.conf.json');
