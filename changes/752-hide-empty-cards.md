---
bump: minor
issues: 752
---
### Empty cards stay off the screen

A panel can now say `"hideWhenEmpty": true`. While its main value is missing, empty, zero or an empty list, it is left out, and the other panels close the gap. Sketch's "Marks on the table" uses it, so the controller no longer shows a big "0" before anyone has drawn.

![Before, an empty Marks card with 0; after, the card is left out](docs/screenshots/752-hide-empty-cards.png)
