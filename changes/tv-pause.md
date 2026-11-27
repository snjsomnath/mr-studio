---
bump: patch
issues: 655
---
### Pause on the TV works when another window covers it

On Windows a covered window stops drawing, and the controller's settings waited for the next drawn frame, so Pause (and other controls) on the TV never reached the table. They are now sent within 50 ms whether the window draws or not, and MR Studio asks Windows not to pause its windows when covered.

![Pause on the TV reaches the table](docs/screenshots/655-tv-pause.png)
