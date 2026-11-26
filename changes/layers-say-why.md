---
bump: patch
issues: 510
---
### A broken layer says why, every time

Some ways a team's own layer can fail left no trace: the table just showed nothing (#510). Now each of them shows as trouble in the editor, on the controller and in Copy diagnostics, with the reason:

- its code does not load ("its code could not be loaded: SyntaxError …"),
- it throws on every frame (it is stopped and tried again, instead of half-drawing sixty times a second),
- it never finishes starting ("it has not finished starting after 20 s").

Two fixes underneath: one layer's mistake in handling an update no longer keeps that update from the other layers, and a request the table never answers now fails after 30 seconds instead of waiting for ever.

![Three layers with a red dot in the editor; the selected one says it kept failing while it ran](docs/screenshots/510-layers-say-why.png)
