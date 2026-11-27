---
bump: patch
issues: 524
audience: developers
---
### A recording keeps checkpoints, so playback can jump to any time

While a session is recorded, the host now writes the session state about once a minute and at each chapter mark into `checkpoints.jsonl` (#524). `mrs_host::seek` jumps to any time in a recording, forwards or backwards. It puts back the nearest checkpoint and replays only the events after it, so it never replays more than about a minute of events. A test checks that the state after seeking to each checkpoint, to the start and to the end matches the state from replaying every event from the start. This is the base for the playback room (#526). The format is in `docs/contracts/recording.md`.

![The seek test and two checkpoint lines](docs/screenshots/524-checkpoints.png)
