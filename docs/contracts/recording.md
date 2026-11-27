# Recorded sessions

A workshop at the table can be recorded and reviewed afterwards (#520). This page is the
format of a recording. The requests that start and stop one are in [session.md](session.md).

## Where recordings are kept

In the app's own data folder, never in the table's folder: `recordings/` in
`~/Library/Application Support/app.mrstudio.studio/` on a Mac, `%APPDATA%\app.mrstudio.studio\`
on Windows and `~/.local/share/app.mrstudio.studio/` on Linux. `MRS_RECORDINGS_DIR` sets
another folder. A recording is not a table: it is never listed under Tables and cannot be
edited.

## A recording's folder

`recordings/<YYYY-MM-DD>-<6 hex>/` holds three files.

### `recording.json`: the catalogue

| Key | |
| --- | --- |
| `format` | 1 |
| `id` | the folder's name |
| `name`, `date`, `facilitator`, `purpose` | from the form when recording started |
| `notes` | context notes at the start, the wrap-up notes after |
| `tags` | words, from the wrap-up |
| `chapters` | `[{ t, title? }]`, `t` in milliseconds since the start |
| `started` | Unix milliseconds |
| `length` | milliseconds; 0 while it runs |
| `events` | lines in the log |
| `finished` | false while recording. A recording still unfinished when the app starts again was cut short by a crash or a closed app |
| `wrapped` | true once the wrap-up is saved |
| `table` | `{ id, name }` of the table recorded |
| `app_version`, `layers` | the app's version, and each layer package's version by id, so a newer app can warn when it plays an older recording |

### `start.json`: the start snapshot

`{ format, site, state }`: `site` is `site.json` exactly as it was when recording started, and
`state` is the session state every surface was sent then (`protocol`, `session`, `site`,
`scene`, `layers`, `participants`, as in `welcome`). The snapshot and the start of the log are
taken under the hub's lock, so no request falls between them.

### `log.jsonl`: the timed events

One JSON object per line, appended as it happens, so a crash loses at most the line being
written. Every line has `t`, milliseconds since the start, and `k`, what it is:

| `k` | Other keys | |
| --- | --- | --- |
| `request` | `role`, `surface`, `slot`, `m`, `p` | A request a surface sent, in the order the hub handled it: `role` (`tv`, `dev`, `table`, `phone`, `guide`), its `surface` number, the phone's `slot` (null for others), the method `m` and its params `p`. Layers turned on and off, settings, steps, play heads (`layer.clock`), controller presses, phone sketches and votes (`tool.input`), words, field walk spots and what layers publish (`layer.publish`) are all requests, so a new layer is recorded with no code of its own. Requests that only read are left out |
| `join`, `leave` | `role`, `surface`, `slot` | A phone joined or left |
| `chapter` | `title` | A chapter mark |
| `stop` | | The end |

Requests that failed are in the log too: played again they fail the same way and change
nothing.

## Playing a log again

`mrs_host::replay(hub, log, until)` sends the logged requests to a hub started from the
snapshot's `site.json`, up to `until` milliseconds. A test records a controller and two
phones, then rebuilds the final layers and scene from the snapshot and the log alone.

A recording stops by itself after 8 hours, or when its log cannot be written, and the
surfaces are sent `recording.stopped { why }`.
