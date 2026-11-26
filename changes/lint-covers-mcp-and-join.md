---
bump: none
issues: 543
---
### The lint covers the MCP server and the phone's join page

The promise checks (#264) skipped `packages/mcp` and `packages/join`. They run there now; the one finding, a send over the phone link whose failure nobody looked at, says why it is left alone.

The join page's service worker, which every phone at a venue loads, has its first tests: which requests go to the table over the link, which stay with the web, that phones can only read, and that the table cannot set cookies on the join page.
