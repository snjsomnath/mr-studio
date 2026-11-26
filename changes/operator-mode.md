---
bump: minor
issues: 394
---
### Operator mode for the exhibition computer

The exhibition computer can run a table with a small **operator window** in place of the editor (#394), so visitors at the controller never reach the editor or the desktop. The editor itself is unchanged.

- **Start in operator mode** in Settings, Phones and startup: MR Studio opens presenting the last table. **Operator mode** on the Present tab and **Open operator mode** on Home turn it on now.
- The operator window presents and stops the table, shows which screen is which, opens the screens again, and says whether each screen is running and how many phones are connected.
- Esc on a screen does nothing, and Ctrl+Shift+E brings the operator window back.
- **Leave operator mode…** and **Quit MR Studio…** ask for a 4 to 8 digit PIN. After five wrong ones it waits 30 seconds.
- A forgotten PIN is never a lock-out. **Forgot the PIN?** and starting with **Shift** held ask for this computer's password, and `mrstudio operator off` turns it off from a terminal.

![The operator window, its switch in Settings and the Present tab button](docs/screenshots/394-operator-mode.png)
