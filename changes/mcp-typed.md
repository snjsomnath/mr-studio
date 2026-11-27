---
bump: none
issues: 543
audience: developers
---
### The MCP server reads sites and layers through their types

`packages/mcp/src/site-types.ts` is written from `docs/contracts/site.schema.json` (`pnpm --filter @mrstudio/mcp site-types`; the tests fail when it is out of date), and the server reads `site.json` through it and `layer.json` through the SDK's `LayerManifest`. Loose `any` types in the server went from 135 to 6, all in one commented wrapper around the MCP SDK, and the lint now refuses new ones there. A key misspelled in what the server writes into a table folder is now a type error instead of a site the app refuses. On the way, the server now accepts `null` where the app does (a table's `front`, a sequence's `mode`, a custom layer's `icon`), and the SDK's `LayerManifest` has the `about` block the layers already carry.

![A misspelled key caught by the type check](docs/screenshots/543-mcp-typed.png)
