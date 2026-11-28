---
bump: minor
issues: 672
---
### Panels that change colour by rule

A panel can now take a colour from the theme by rule: green while the load is under 80 %, amber above it, red over 100 %. One rule written as an expression covers all of it, and only the theme's colours are allowed. A toned panel gets a tint and a stripe, and its number or gauge takes the colour. A panel can also be held back while a rule is false, such as "Exporting now" only while the roofs export. It keeps its place, so nothing else on the screen moves.

![Three feeder gauges in green, amber and red, a self-sufficiency figure in green, and an empty cell where a held-back panel waits](docs/screenshots/672-panel-tones.png)
