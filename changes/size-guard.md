---
bump: none
issues: 737, 738
audience: developers
---
### A size guard, and screenshots kept off main

CI now fails a pull request that adds a code file over 1,500 lines, grows one past that, or adds a picture over 1 MB (or more than 5 MB of pictures) to `docs/screenshots`. Files already over the limit only get a warning. Every run lists lines of code per package in its summary. Only release-note pictures go on main now; other screenshots for issues and pull requests go on the new `screenshots` branch (CONTRIBUTING.md). The pictures already in `docs/screenshots` stay, so no link breaks.
