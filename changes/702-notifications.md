---
bump: minor
issues: 702
---
### A notification when a long job finishes

When you export a table, pack it to share, or bring data in from OpenStreetMap and switch to another app while it runs, the computer now shows a notification when it is done (a toast on Windows, Notification Centre on macOS). Clicking it brings MR Studio back with the editor in front. There is none while MR Studio is in front, where the editor already says so, and none while presenting, so a show is never interrupted. Map tiles and updates are not covered: the app does not download tiles ahead of time, and an update is downloaded by the browser or installs itself and restarts.

![Two notifications from MR Studio](docs/screenshots/702-notifications.jpg)
