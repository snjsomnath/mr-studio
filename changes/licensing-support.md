---
bump: minor
issues: 725, 726, 727, 728, 729, 730, 731, 732
audience: developers
---

### Licensing support, built and switched off

MR Studio can now carry a licence: who it is licensed to (a designer, and the exhibitor the table
is for), how many tables and editor seats it covers, and until when. A table is counted by its
place, so copies of a table are one table. It all works offline, never touches a table that is
presenting, and runs on the honour system for now: a licence is a plain file made with
`mrstudio licence issue`. Signed licences are ready for later.

**None of it shows yet.** Settings › Licence, the first-run question, the editor reminders and
the warning before sharing restricted data stay hidden until licensing is turned on. Checks only
log what they would have refused. `MRS_LICENSING=preview` shows it all on one computer.

Also new: `data_licences` in site.json says where a table's data came from and on what terms,
and its credit lines reach the controller's Credits page. Release builds now ship the
open-source licences of every library inside. See docs/licensing.md.

![The Licence page in Settings, previewed](docs/screenshots/725-licence-page.png)
