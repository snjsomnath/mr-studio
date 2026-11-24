---
bump: minor
issues: 370
---
### Install the mrstudio command for terminals

The `mrstudio` command has come inside the app for a while, but a terminal could not find it. **Displays and settings** now has a **Command line** tab with **Install command line tool** (also in the MR Studio menu on a Mac, and the editor's File menu on Windows). On a Mac it links `/usr/local/bin/mrstudio` to the copy inside the app, asking for the password once, and the link follows the app through updates. On Windows it adds the MR Studio folder to your own PATH, with no administrator needed. **Remove** takes it away again. The tab says why you would want it: checking a table, bringing data in, building a layer of your own or packing a table from a terminal, a script or an AI assistant. `scripts/install-latest-mac.sh` makes the link too.

![The Command line tab on a Mac, before installing](docs/screenshots/370-command-line-mac.png)
