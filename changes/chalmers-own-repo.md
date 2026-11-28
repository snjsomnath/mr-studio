---
bump: none
issues: 740
audience: developers
---
### The Chalmers campus table has its own repository

`sites/chalmers`, with the ECOM layer and its data, moved to the private table repository `snjsomnath/mr-studio-site-chalmers`, made from the site template. The core repository now ships only `sites/sample`. The campus ground, buildings and trees that the import tests read are kept in `crates/mrs-site/tests/fixtures`. The campus bake test runs when `MRS_SITE_CHALMERS` points at a checkout of the table. Run the table in development with `pnpm dev -- --site ../mr-studio-site-chalmers`.
