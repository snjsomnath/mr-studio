// Writes <dir>/latest.json, the file an installed app reads to update itself.
//   node scripts/update-feed.mjs <dir with the release files> <owner/repo> <tag>
// Each platform entry is the download link of a release file and the signature made for
// it at build time. Without signatures (no updater key) no feed is written, and installed
// apps then point people to the download page.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, repository, tag] = process.argv.slice(2);
if (!dir || !repository || !tag) throw new Error('usage: update-feed.mjs <dir> <owner/repo> <tag>');

const files = readdirSync(dir);
const entry = (suffix) => {
  const file = files.find((name) => name.endsWith(suffix));
  if (!file || !existsSync(join(dir, `${file}.sig`))) return null;
  return {
    signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
    url: `https://github.com/${repository}/releases/download/${tag}/${file}`,
  };
};

const windows = entry('-setup.exe');
const mac = entry('.app.tar.gz');
const platforms = {};
if (windows) platforms['windows-x86_64'] = windows;
// One universal build serves both kinds of Mac.
if (mac) platforms['darwin-aarch64'] = platforms['darwin-x86_64'] = mac;

if (Object.keys(platforms).length === 0) {
  console.log('::warning::No signed update files, so no latest.json. Installed apps will offer the download page.');
} else {
  const feed = {
    version: tag.replace(/^v/, ''),
    notes: `https://github.com/${repository}/releases/tag/${tag}`,
    pub_date: new Date().toISOString(),
    platforms,
  };
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`latest.json for ${Object.keys(platforms).join(', ')}`);
}
