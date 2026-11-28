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

`recordings/<YYYY-MM-DD>-<6 hex>/` holds four files.

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

### Names (#530)

A recording knows a phone by its seat: slot, animal, mood and colour. The name a visitor
typed is left out of `start.json`, the checkpoints and the logged `participant.profile`
requests, unless the organiser ticks "Keep the names people type" when starting
(`recording.start { keep_names: true }`, kept as `keep_names` in `recording.json`). No address,
device or browser details are logged.

### Asking phones first (#530)

With `consent` on (the default; the Record form's "Ask phones before recording them"), each
phone sees a notice before anything else, also when recording starts mid-session: that the
session is recorded, what is kept, the organiser's own `notice` if any, and **Join** or **Just
watch** (`recording.consent`). Until a phone answers, its changes are refused and nothing from
it is in the log; its `join` line is written when it picks Join. Just watch gives up its seat
and the phone only looks around, as at a full table (#462). The phone remembers its answer for
that recording, so a reload does not ask again. The wording is a placeholder until it has been
agreed (it may need a GDPR review); the strings are in `packages/runtime/src/join.ts` and
`i18n.ts`.

### `checkpoints.jsonl`: the state now and then (#524)

One line per checkpoint: `{ t, after, state }`. `after` is how many lines of `log.jsonl` came
before it, and `state` is `{ session, scene, layers, participants }`, as in the start snapshot
less the site. A checkpoint is written with the first request after each minute
(`CHECKPOINT_EVERY`) and at each chapter mark, while the hub's lock is held, so it always falls
between two log lines.

What a checkpoint does not hold is what lives only inside a layer, such as a stormwater
simulation that has run for ten minutes. A layer like that starts again from the restored
params when seeking. Phone sketches, votes, words, field walk spots and published values come
through requests, so they are in the log, and a checkpoint keeps what the host holds of them.

## The library on Home (#525)

Home lists the recordings under **Recorded sessions**, apart from the tables: name, date,
length, phones (`phones` in `recording.json`, the seats that joined), facilitator, table and
tags. Find searches the name, tags and facilitator; sort by date. On a card: **Edit details**
(`mrs_host::edit_recording`: name, facilitator, purpose, tags, notes), **Show in folder**, and
**Delete**, which moves the whole folder to the Trash or Recycle Bin after asking. A table's
card says how many recordings it has, and that link shows only those. The app's commands are
`recordings_list`, `recording_update`, `recording_delete` and `recording_reveal`.

## Playing a log again

`mrs_host::replay(hub, log, until)` sends the logged requests to a hub started from the
snapshot's `site.json`, up to `until` milliseconds. A test records a controller and two
phones, then rebuilds the final layers and scene from the snapshot and the log alone.

`mrs_host::seek(hub, folder, until)` jumps to any time, forwards or backwards (#524). It puts
back the nearest checkpoint at or before `until` with `Hub::restore` (the start snapshot when
there is none) and replays only the log lines after it, so at most about a minute of events.
A line an older or newer app cannot make sense of fails and changes nothing, and the next
checkpoint puts the state right again. A test seeks to each checkpoint, back to the start and
to the end, and compares the state with replaying every event from the start.

A recording stops by itself after 8 hours, or when its log cannot be written, and the
surfaces are sent `recording.stopped { why }`.
