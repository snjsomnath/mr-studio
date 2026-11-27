---
bump: patch
---
### Open a table file works again

Home's **Open a table file** said "Command import_table not allowed by ACL" and opened nothing. Double-clicking a `.mrstable`, **Duplicate** on a table card, **Update now** for a table waiting for the show to stop, and the editor's **Export starter pack** were refused the same way. The app had these commands but never gave the windows permission to use them. A test now checks that every command the app has is permitted, so a new one can't be missed again.
