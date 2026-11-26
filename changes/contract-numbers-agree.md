---
bump: none
issues: 538
---
### The host's and the SDK's contract numbers are checked against each other

`LAYER_API` and `PROTOCOL` are written once in Rust and once in TypeScript (and `LAYER_API` again in the MCP server). The docs check now fails, naming the files, when they differ.
