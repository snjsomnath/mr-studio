# Tables as earlier versions saved them

Each file here is a `site.json` exactly as an earlier MR Studio wrote it, for the sample
table's data. `tests/earlier.rs` opens every one with the current host (#514), so a change
that would stop an existing table from opening fails by name.

- `format-1.json`, `format-2.json`: the site formats before the current one.
- `release-<version>.json`: the sample table as that release shipped it.

Never edit a file here to make a test pass: a table on someone's computer cannot be edited
that way. Add the step to `mrs_site::migrate` instead. When a release changes what site.json
may hold, add that release's sample as a new file.
