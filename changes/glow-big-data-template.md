---
bump: minor
issues: 476, 263, 427, 86
---
### An ambient glow around the model

The projector's blank space around the model can glow softly in the model's own colours, like the lights behind some televisions. Turn it on under Design › Table size and place, beside the ribbons: choose how strong it is, and whether each edge glows in the colours along it or the whole margin takes the model's one dominant colour. Colours ease over about a second, the ribbons stay on top, and a layer can turn the glow off or give it a colour of its own while it is on.

![The glow around Sunlight and Wind](docs/screenshots/476-ambient-glow.png)

![The setting in Table size and place](docs/screenshots/476-glow-setting.png)

### Big data files no longer freeze the table

A large map file is now read in the background, and every layer that needs the same file shares one read. A layer with tens of thousands of shapes draws them a few at a time, so the table keeps moving. On a 50 MB file of 64,000 buildings, the table no longer stops for 0.7 s while the file is read and 1.9 s while it is drawn. The Mac's WebKit check is back to blocking a pull request when it fails, and a team's own table repository can start from the new site template in `templates/site`.

![The longest pause on the table, before and after](docs/screenshots/263-worker-pauses.png)
