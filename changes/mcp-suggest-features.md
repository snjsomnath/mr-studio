---
bump: minor
issues: 477, 473, 374, 335
---
### An AI assistant suggests features that fit your idea

An AI assistant using the MCP server can now suggest features that would help your idea, including ones you would never search for. Tell it the idea, and `suggest_features` returns three to five features with a one-line reason each. Some reasons come from your words ("you mentioned residents"). Others come from the table itself, such as "the model leaves the top and bottom of the projection free" or "nothing moves on the map at rest yet". Each suggestion also comes with the exact step that switches it on, and the assistant offers suggestions without applying them. After making a table, bringing in data, adding a layer or changing settings, the assistant gets one quiet "you might also like", and never the same one twice. Features that are coming, such as the ambient glow, are named as coming.

Every layer's suggestion is written from its own layer.json. The docs check now fails when a table setting has no suggestion card. The server also knows that two layers can be open at once, that phones show every layer, and that a layer whose controller centre is a map or panels needs no code.

![suggest_features for a tram exhibition, from the table alone, and a hint after adding Wind](docs/screenshots/477-suggest-features.png)
