---
bump: patch
issues: 443
---
### The Mac install script runs again

`bash scripts/install-latest-mac.sh` stopped with "VERSION…: unbound variable" on the bash that ships with macOS. It now downloads and installs the release as before.
