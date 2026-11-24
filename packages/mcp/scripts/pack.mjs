// Packs what is published for each release, from dist/mrstudio-mcp.mjs (run build first):
//   dist/mr-studio.mcpb   the Claude Desktop extension (double-click to install)
//   dist/server.json      the MCP Registry entry, at this version
// The npm package itself is this folder (package.json "files").

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
const dist = join(pkg, 'dist');

const stage = join(dist, 'mcpb');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
const manifest = JSON.parse(readFileSync(join(pkg, 'mcpb', 'manifest.json'), 'utf8'));
manifest.version = version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
copyFileSync(join(pkg, 'mcpb', 'icon.png'), join(stage, 'icon.png'));
copyFileSync(join(dist, 'mrstudio-mcp.mjs'), join(stage, 'server', 'mrstudio-mcp.mjs'));
const cli = join(pkg, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
execFileSync(process.execPath, [cli, 'pack', stage, join(dist, 'mr-studio.mcpb')], { stdio: ['ignore', 'inherit', 'inherit'] });

const entry = JSON.parse(readFileSync(join(pkg, 'server.json'), 'utf8'));
entry.version = version;
for (const p of entry.packages) p.version = version;
writeFileSync(join(dist, 'server.json'), JSON.stringify(entry, null, 2) + '\n');
console.log(`packed dist/mr-studio.mcpb and dist/server.json at ${version}`);
