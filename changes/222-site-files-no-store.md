---
bump: patch
issues: 222
---

### Every table shows its own buildings and trees

In the desktop app, a table could open with its streets and traffic but no buildings, trees or building lights. All tables use the same addresses for their files, and the app's window kept copies from an earlier table. A table whose files were older than those copies, such as one copied from a repository, was given the earlier table's buildings and trees, which lay somewhere else. The app now always fetches a table's files fresh, and it checks its own pages on every load, so an updated app never shows an earlier version's page.
