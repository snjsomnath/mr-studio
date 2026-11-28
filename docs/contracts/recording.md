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

### `feeds.jsonl` and `feeds/`: what the outside answered (#523)

While a session records, every answer the host passes on from outside is kept: public
transport (`/api/transit/...`), WMS map pictures (`/api/wms`), a source's tiles and proxied
requests (`/api/sources/{id}/tile/...`, `/api/sources/{id}/proxy`) and a table's own services
(`/api/services/{id}/call...`), for GET requests. `feeds.jsonl` has one line per answer,
`{ t, url, status, type, file }` (`url` with its query), and `feeds/` holds each different
answer once. At most 512 MB per recording; past that, nothing new is kept.

A host playing the recording answers those addresses from there: the last answer kept at or
before the playback time, else the first one after. An address the recording has no answer for
gets 404, so playback never reaches outside. Not yet: a seeded `ctx.random` for ambient layers,
the recording's own time for `ctx.clock`, and picture checkpoints.

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
`recordings_list`, `recording_update`, `recording_delete`, `recording_reveal` and `recording_open`.

## The playback room (#526, #527)

Pressing a recording on Home plays it back. `recording_open` finds the table it was recorded
on (by `table.id`, the table's own folder before the copy that ships with the app), copies it
into the app's cache with `mrs_host::playback_table` (site.json as it was, from `start.json`;
no history, cache or scene), and runs that copy with `SessionOptions.playback` set to the
recording's folder, on this computer only, with no programs. The editor window opens on
`/playback`. From the command line: `mrstudio play <recording folder> --site <table>`.

A host playing a recording:

- starts at the start snapshot, and moves only by `playback.seek`;
- refuses every request that would change something, from any page, with "this is a recorded
  session, read only"; phones cannot join, and the table page keeps drawing;
- says so in `session.playback` (`{ id, name, date, length }`), and the controller shows
  "Recorded session, read only" instead of the red dot.

The room shows the table and the controller (drawn at 1920 × 1080 and shrunk) side by side, the
events in words, and the organiser's notes, over a timeline with play and pause, 0.5× to 8×,
the previous and next chapter, chapter marks, event ticks and note marks. Space plays and
pauses, ← and → move 5 seconds, Shift with them moves to the event before or after. While it
plays the room sends `playback.seek` as it goes, one at a time.

| Method | Params | Who | What |
|---|---|---|---|
| `playback.info` | `{}` | tv, dev | `{ recording, length, at, events, notes }`. `events` are `{ t, kind, who, slot, text }` in words ("Controller opened sunlight", "Phone 2 drew or marked on sketch"); `kind` is layers, sketches, people, settings or chapters. The table's own requests and presence pings are left out |
| `playback.seek` | `{ t }` | tv, dev | Moves to `t` milliseconds and sends `playback.at { at }`. Backwards, or more than a checkpoint ahead, it goes through `seek` (the nearest checkpoint, then the lines after it); otherwise it applies only the lines in between |
| `playback.note` | `{ t, text }`, `{ id, text }`, `{ id, remove: true }` | tv, dev | Adds, changes or removes one organiser's note (#527). Answers `{ notes }`, sorted by time |

Notes are kept in `notes.json` beside the recording (`[{ id, t, text }]`), never in its log:
they are the reviewer's, not the session's. The event list filters by who (everyone, the
controller, one phone) and by kind; the same filter thins the ticks on the timeline. **Save
notes and events as text** and **Save as CSV** (`time, seconds, kind, who, text`) take the
review away with the notes, chapters and the events the filter shows.

### Play on the table (#528)

In the app, the room has **Play on the table**: the recording goes on the projector and the TV
chosen in the Display tab (`present`), while the timeline stays in the room; **Stop playing on
the table** takes it off (`stop_presenting`). Calibration and colour are this computer's: a
table that came inside a `.mrsession` file uses this computer's `calibration.json` for the same
table id, or none. The controller shows "Recorded session, read only" and no way to join, and
its presses change nothing. Not yet: a warning when the physical model differs from the
recorded table.

## A recording as one file: `.mrsession` (#529)

**Export…** on a recording's card on Home writes one `<name>.mrsession` file
(`mrs_site::session_file::export`): a zip with `mrsession.json` at the top (`format`, `id`,
`name`, `table_id`, `table_name`, `app`, `exported`, `media`, `left_out`), the recording's own
files beside it, and a frozen copy of its table under `table/`, so it plays on a computer that
never had the table. The same rules as a `.mrstable` keep out hidden files, history and
anything named like a secret. **Without media** leaves out videos and pictures over 4 MB and
names them in `left_out`; playback shows the table without them.

**Open a recorded session…** on Home (`recording_import`, `mrs_site::session_file::open`)
unpacks one into the recordings folder under its own id, never over a recording already there,
and never as a table: the copy stays at `<recording>/table/`, is not listed in Your tables and
is not opened in the editor. Playback uses that copy before looking for the table on this
computer; `mrstudio play <folder>` does the same. A file from a newer format is refused with
the app version that made it. The app's commands are `recording_export { id, media }` and
`recording_import { path? }`.

Not yet: a linked export (without the table copy, naming its revision), Share by email, and
double-clicking a `.mrsession` file (the file type is registered with the installer work).

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
