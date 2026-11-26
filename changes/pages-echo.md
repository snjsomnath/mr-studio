---
bump: patch
issues: 572, 590
---
### Controller pages keep a title while it is typed

Quick changes in the Controller pages dialog, such as moving a panel and then typing its title, no longer lose the title (#572). A late reply to one of the dialog's own saves used to take it back a step and redraw it under the typing.

![The Controller pages dialog with the panel title kept](docs/screenshots/572-pages-title.png)

The end-to-end test's tap on the wind dial now always lands on the dial's top (#590).
