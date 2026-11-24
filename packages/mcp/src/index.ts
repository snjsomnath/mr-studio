#!/usr/bin/env node
// mrstudio-mcp: the MR Studio MCP server over stdio.
//
//   mrstudio-mcp [--project <folder>] [--core <mr-studio checkout>]
//
// --project  folder that relative site paths are resolved against (default: the working folder,
//            or the app's tables folder when a desktop client starts the server in home or /)
// --core     read layers and docs from a core checkout instead of the built-in snapshot

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, SERVER_VERSION } from './server.ts';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

// The folder MR Studio keeps tables in (apps/studio: Documents/MR Studio/sites).
export function appTablesFolder(home = homedir()): string {
  return join(home, 'Documents', 'MR Studio', 'sites');
}

// Desktop clients (Claude Desktop, Cursor, VS Code, LM Studio) start servers in the home
// folder or at the root of the disk. There, relative paths would land somewhere nobody
// looks, so the server works in the app's tables folder instead.
function defaultProject(): string {
  const cwd = resolve(process.cwd());
  const home = resolve(homedir());
  // A Claude Desktop extension starts in its own install folder.
  const own = dirname(resolve(process.argv[1] ?? '.'));
  const notAProject = cwd === home || cwd === dirname(cwd) || cwd === own || cwd === dirname(own);
  if (!notAProject) return cwd;
  const folder = appTablesFolder(home);
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    return cwd;
  }
  return folder;
}

function expandHome(p: string | undefined): string | undefined {
  // An unfilled client variable such as "${user_config.project}" counts as not given.
  if (!p || p.includes('${')) return undefined;
  return /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p;
}

async function main() {
  if (process.argv.includes('--version')) {
    console.log(SERVER_VERSION);
    return;
  }
  if (process.argv.includes('--help')) {
    console.log(`mrstudio-mcp [--project <folder>] [--core <mr-studio checkout>]
Runs the MR Studio MCP server on stdio.
Without --project it works in the current folder, or in ${appTablesFolder()} when started from the home folder.
Setup for each AI app: https://github.com/snjsomnath/mr-studio/blob/main/docs/MCP.md`);
    return;
  }
  const { server, catalog } = createServer({ project: expandHome(arg('project') || process.env.MRSTUDIO_PROJECT) || defaultProject(), core: arg('core') });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(`mrstudio-mcp ${SERVER_VERSION}: core ${catalog.version} (${catalog.source}${catalog.root ? ` at ${catalog.root}` : ''}), ${catalog.layers.length} layers`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
