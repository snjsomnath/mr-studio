---
bump: minor
issues: 262
---
### A frame meter shows what each layer costs

Press Ctrl+Shift+P on the table or controller, or choose Help › Show frame meter in the editor, to see frames per second, the worst frame of the last 10 seconds and how many milliseconds each layer takes per frame. When the table falls below 54 frames a second, the editor's status bar says so and its tooltip names the costliest layer and what to try. Diagnostics list each window's worst frame and costliest layers.

![The frame meter on the table](docs/screenshots/262-meter.png)
