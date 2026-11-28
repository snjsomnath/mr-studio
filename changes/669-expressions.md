---
bump: minor
issues: 669
---
### Formulas without code

Panels and custom layers can now work out values with safe formulas written as data, so no code is needed. A TV panel can show "use per m²" from two live values. A custom layer can add a worked-out column to its buildings, then colour and filter by it. For example, it can show only homes of at least the number of floors on the controller's slider. A mistake shows as an empty value and a message, never as a broken table. The MCP server checks them and knows every operator.

![Homes filtered by a worked-out "storeys" column at two slider values, and TV panels worked out by formulas](docs/screenshots/669-expressions.png)
