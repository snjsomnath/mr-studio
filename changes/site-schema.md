---
bump: patch
issues: 537
audience: developers
---
### One set of rules for site.json, shared by the app and the MCP server

`docs/contracts/site.schema.json` is the JSON Schema of site.json, written by the app from its own types, with the limits it checks (button name, description and credit lengths, glow strength, palette names and colours). The MCP server checks sites against it in place of its own copy of the keys, so it now says exactly which key is wrong and what type it should be. A shared set of example sites (`crates/mrs-site/tests/fixtures/verdicts.json`) runs in both test suites; it found three rules the MCP server didn't have (credit length, glow strength, palette colours) and two it was softer on (the table's aspect is an error above 2%, as in the app, and a ground too large for the app is an error).

![The MCP server pointing at the exact key](docs/screenshots/537-site-schema.png)
