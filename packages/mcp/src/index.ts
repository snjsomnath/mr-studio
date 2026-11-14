#!/usr/bin/env node
// mrstudio-mcp: the MR Studio MCP server over stdio.
//
//   mrstudio-mcp [--project <folder>] [--core <mr-studio checkout>]
//
// --project  folder that relative site paths are resolved against (default: the working folder)
// --core     read layers and docs from a core checkout instead of the built-in snapshot

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer, SERVER_VERSION } from './server.ts';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

async function main() {
  if (process.argv.includes('--version')) {
    console.log(SERVER_VERSION);
    return;
  }
  if (process.argv.includes('--help')) {
    console.log('mrstudio-mcp [--project <folder>] [--core <mr-studio checkout>]\nRuns the MR Studio MCP server on stdio. See docs/MCP.md.');
    return;
  }
  const { server, catalog } = createServer({ project: arg('project'), core: arg('core') });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(`mrstudio-mcp ${SERVER_VERSION}: core ${catalog.version} (${catalog.source}${catalog.root ? ` at ${catalog.root}` : ''}), ${catalog.layers.length} layers`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
