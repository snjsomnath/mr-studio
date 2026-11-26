# Present, and run a table on its own

*Put the table on the displays, and keep it running for days.*

1. Press **Present** in the title bar. The map opens fullscreen on the projector and the controller on its screen. **Stop presenting** ends it.
2. While presenting, Ctrl+Shift+E brings the editor back.
3. For an exhibition: under **File, Settings…**, **Phones and startup**, let the app start with the computer and open the last table by itself, and choose a nightly restart time. If the engine or a window stops, MR Studio starts it again and writes what happened in the operator log.
4. **Operator mode** keeps visitors away from the editor on the exhibition computer. Turn on **Start in operator mode** in the same place, or press **Operator mode** on the Present tab (or **Open operator mode** on Home). The table is presented, and a small operator window stands in for the editor: **Present** and **Stop presenting**, **Show which screen is which**, **Open the screens again**, and whether each screen is running and how many phones are connected. Esc on a screen does nothing, and Ctrl+Shift+E brings the operator window, not the editor. Set a PIN there: **Leave operator mode…** and **Quit MR Studio…** ask for it.
   - **Forgot the PIN?** asks for this computer's password (on a Mac, the logged-in account's; on Windows, the Windows account's), then sets a new PIN.
   - Starting MR Studio with **Shift** held also asks for the computer's password, then opens the editor.
   - `mrstudio operator off` in a terminal turns operator mode off and forgets the PIN; start the app again afterwards.
5. For a demo or a test that must leave the table as it is, press **Open read-only** on its card on Home. MR Studio opens a copy, the title bar says **Read-only**, and nothing changed in the editor, on the controller or on phones reaches the table. **File, Save As…** keeps the changes as a new table.
6. **Sources and keys** (on Home) holds the keys for live data and maps (Västtrafik, Lantmäteriet, Mapbox, CARTO). They stay on this computer, in its keychain.

![The app starting a table by itself](docs/screenshots/79-startup.png)

![Operator mode: the operator window, its switch in Settings and the Present tab button](docs/screenshots/394-operator-mode.png)
