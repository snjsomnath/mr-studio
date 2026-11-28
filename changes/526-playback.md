---
bump: minor
issues: 526
---
### Play a recorded session back

Press a recording on Home and it plays back (#526). A copy of the table as it was runs read only, so nothing in the table or the recording can change, and phones cannot join. The playback room shows the table and the controller side by side over a timeline: play and pause, speeds from half to eight times, the chapter before and after, chapter marks and a tick for each event. Space plays and pauses, the arrow keys move five seconds. Jumping backwards starts from the nearest checkpoint, so it is quick even in a long session. The controller says "Recorded session, read only". From the command line, `mrstudio play <recording folder> --site <table>` does the same.

![The playback room](docs/screenshots/526-playback-room.png)
