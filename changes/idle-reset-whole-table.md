---
bump: patch
issues: 604
---
### The table no longer resets while people are using it

The table goes back to its welcome after 3 minutes only when nobody has done anything on any screen (#604). Before, each controller page counted only its own touches, so a demo driven from the editor, a phone, the guide's phone or the table reset itself every few minutes, and a second controller screen that nobody touched reset it even while the main one was in use. The host now keeps one timer for the whole table, and every screen tells it when someone touches it. "Back home after" in Welcome and languages still sets the time, and 0 still means never.

![Sunlight still open on the controller after 35 s of mouse use on the table, with the idle time at 15 s](docs/screenshots/604-still-open.png)

![Back home after, in Welcome and languages, now says what counts](docs/screenshots/604-setting.png)
