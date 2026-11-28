# Licensing in the app

MR Studio is source-available under the Business Source License 1.1 ([LICENSE](../LICENSE)). This
page is about the app's own licensing support (#725). **All of it is built and switched off.**
Nothing shows, nothing is checked and nothing is blocked until it is turned on.

## The switches

All three live in `crates/mrs-licence/src/lib.rs`. A test fails if one is turned on without
this page and the release notes being updated with it.

| Switch | Off (today) | On |
| --- | --- | --- |
| `SHOWN` | Nothing about licences shows in the app. | Settings › Licence, Home's first-run question, editor and Home reminders, the warning before sharing restricted data, the licence stamp in exports. |
| `ENFORCED` | Every check only logs what it would have refused (`licence (not enforced): would refuse: …`). | A check may refuse: a layer type, a feature, more tables than the licence covers, editing on a table-only computer. A table that is presenting is never stopped. |
| `SIGNING_REQUIRED` | Honour system: an unsigned licence file is read as it is. | Only files signed with a key in `keys/trusted.json` are accepted. |

`MRS_LICENSING=preview` in the environment shows everything on one computer without
changing a switch, for trying it out and for screenshots.

## Principles

- **Offline.** Nothing here talks to a network. Museums and the managed studio PC work as they are.
- **Never in the show.** Reminders appear in the editor and on Home only, never on the table, the TV or phones. An ended licence leaves 30 days of grace before anything could apply.
- **Honour system, for now** (Sanjay, 2026-11-28). The source is public, so any check can be built out of a copy. What protects the licence is the BSL itself, since using a patched build in production is a breach, along with the trademark and licence IDs that make a copy traceable. Signing is ready for when it is wanted.
- **Nothing personal.** The install code is random. Licence facts in diagnostics and exports are the licence ID, its kind and that code.

## What a licence says

Commercial licences are priced by **tables** and **editor seats** (Sanjay, 2026-11-28). The buyer
is usually a designer who sets the table up for an exhibitor:

```json
{
  "mrslicence": 1,
  "licence": {
    "id": "NW-2026-0007",
    "licensee": "Kaminsky Arkitektur",
    "client": "Universeum",
    "tier": "table",
    "issued": "2026-11-28",
    "expires": "2027-11-30",
    "tables": 1,
    "editors": 2,
    "installs": [{ "code": "MRS-4K2Q-9XWD-…", "role": "table", "label": "Studio PC" }],
    "issuer": "Nodal Works AB"
  }
}
```

- `tier`: `education`, `research`, `personal`, `evaluation`, `table` or `partner`.
- `tables`: how many **different places** may have tables. A table is its place, meaning its centre to about 100 m and the size of its ground, so duplicates, copies and imported files of a table all count as one (`mrs_licence::table_key`). Leave it out for any number.
- `editors`: editor seats. A computer listed as a `table` may still edit the table it presents.
- `installs`: optional. Without it the counts are on trust. With it, a licence covers only the computers it names. Each computer's install code is in Settings › Licence and `mrstudio licence status`.
- `layers` and `features`: optional allow lists (layer package ids, and `recording`, `phones`, `dashboards`, `operator_mode`, `code_layers`, `mcp`). Leave them out to allow everything.

The app keeps its files in `licence/` in its settings folder: `install.json`, `usage.json` (the
first-run answer) and `licence.mrslicence`.

## Making a licence

```sh
mrstudio licence issue --to "Kaminsky Arkitektur" --client Universeum --tier table \
  --tables 1 --editors 2 --expires 2027-11-30 \
  --table "MRS-4K2Q-9XWD-…=Studio PC" --out Universeum.mrslicence
mrstudio licence verify Universeum.mrslicence
```

The customer double-clicks the file, or adds it in Settings › Licence.

### Later: signed licences

1. `mrstudio licence keygen --out <a safe folder>` makes `licensor.key` (keep it private and backed up, and never commit it) and `licensor.pub.json`.
2. Add `licensor.pub.json`'s record to `crates/mrs-licence/keys/trusted.json`.
3. Issue with `--key <folder>/licensor.key`.
4. Turn `SIGNING_REQUIRED` on once every licence in use is signed.

Development builds also trust the key named by `MRS_LICENCE_TEST_KEY`. Release builds never read it.

## Without a licence file

Home asks once how MR Studio will be used: teaching, research, personal (all free under the BSL
grant) or for an organisation, which starts a 90-day evaluation. The answer can be changed in
Settings › Licence.

## Data licences

The terms of a table's data are in `site.json` `data_licences` and in each GeoJSON file's own
`source` ([site.md](contracts/site.md)). Attribution lines reach the controller's Credits page.
Export and Share by email warn before a table with restricted data leaves the computer (while
licensing is shown; until then this is only logged).

## Open-source notices

`node scripts/third-party-notices.mjs` writes `target/third-party-notices.json`: every crate and npm
package the app ships, with its licence text. `pnpm app:build` runs it first, and the app shows it
in Settings › Licence › Open-source licences.
