---
bump: none
issues: 538
audience: developers
---
### The SDK's session types are checked against what the host sends

`docs/contracts/protocol.schema.json` is the JSON Schema of the state every view is welcomed with, written by the host from its own types. A test walks `SessionState` in the SDK's `types.ts` beside it and names every field one side has and the other doesn't, so a field renamed in Rust alone now fails CI by name instead of failing in a window. `PROTOCOL` and `LAYER_API` are checked to be the same in both languages.

![A renamed field named by the test](docs/screenshots/538-protocol-schema.png)
