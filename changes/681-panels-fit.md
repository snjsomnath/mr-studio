---
bump: minor
issues: 681
---
### Panels never spill or scroll

Everything a panel on the controller or TV holds now stays inside its box. The dashboard measures its panels on screen and reports any that spill: the editor's status bar says which panel doesn't fit, and the Developer window outlines it and lists it under Problems. Every widget is tested at every size with the longest text the rules allow, in Chromium, WebKit and Edge. That test found the donut's key cut off at the edge, and long numbers and units in the stat, gauge and series running out of their panels. All of these are fixed. The Developer window's widget gallery has a new **Longest text** switch for testing a team's own widgets.

![A donut whose key was cut off, now fitting, and the stat, gauge and series with the longest text](docs/screenshots/681-panels-fit.png)
