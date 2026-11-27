---
bump: minor
issues: 521, 522
---
### Record this session

The operator can now record a workshop at the table (#520). **Record this session…** sits under Phones in the Developer window. It asks for a name (the table's name and today's date to start with), the date, the facilitator, the purpose and context notes. While it records, the controller shows a small red dot with the time, and nothing shows on the table or the phones. **Mark a chapter** drops a chapter mark, with a title if you type one. **Stop recording** opens the wrap-up: notes, tags, and the chapters to rename or remove. Then **Save the recording**, or **Discard**, pressed twice.

Under it, the host keeps a log of the session (#521): a snapshot of the table and the session state at the start, then every request from the controller, the editor, the guide and each phone, and every phone joining or leaving, each with its time. The log is written line by line, so a crash loses at most the last moment. Recordings are kept in the app's own data folder, never in the table's folder, and a recording cut short by a crash is offered to finish next time. A recording stops by itself after 8 hours. The format is in `docs/contracts/recording.md`. A test replays a log onto a fresh table and gets the same layers and scene.

Playing a recording back, the library on Home and export come next (#523 to #530).

![The form, recording with two chapters, and the wrap-up](docs/screenshots/522-record-panel.png)

![The controller's red dot while recording](docs/screenshots/522-controller-dot.png)
