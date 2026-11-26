---
bump: none
issues: 543
---
### The lint covers the MCP server and the phone's join page

The promise checks (#264) skipped `packages/mcp` and `packages/join`. They run there now; the one finding, a send over the phone link whose failure nobody looked at, says why it is left alone.
