# __NAME__

A layer of this site with its own code. MR Studio loads it from `dist/index.js`.

- `layer.json`: name, controls, tools and controller panels (docs/contracts/layer.md)
- `src/index.ts`: what it draws on the table (`table`) and in its custom panels (`panel`)
- `locales/sv.json`: its words in Swedish

Build it with `mrstudio layer build --site <site>` (needs Node 20 or newer on the computer you
develop on), and commit `dist/` so the table's computer needs no Node. While developing, run
`npm run watch` here and reload the table to pick up a new build.
