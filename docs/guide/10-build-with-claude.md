# Build a table by talking to Claude

*Describe the table you want in your own words. Claude (or another AI app) makes it with the MR Studio tools, and you watch it appear in the editor.*

## Connect Claude Desktop

The easiest way. Nothing else to install.

1. Download **mr-studio.mcpb** from the latest MR Studio release on GitHub (github.com/snjsomnath/mr-studio, Releases).
2. Double-click the file. Claude Desktop opens and shows **MR Studio** with its tools. If nothing opens, go to **Settings**, **Extensions**, **Advanced settings**, **Install Extension…** and pick the file.
3. Click **Install**. Leave **Tables folder** as it is (Documents, MR Studio, sites), so the tables Claude makes show up in MR Studio. Pick another folder only if you keep your tables elsewhere.
4. Start a new conversation. The tools button under the message box lists **MR Studio**.

## Connect Claude Code

1. Install **Node.js** 20 or newer from nodejs.org.
2. In a terminal, go to the folder your tables are in: `cd ~/Documents/"MR Studio"/sites`
3. Add the server once: `claude mcp add mrstudio -- npx -y @mrstudio/mcp`
4. Check it: `claude mcp list` should say **Connected**.
5. Run `claude` in the same folder and start talking.

![Adding MR Studio to Claude Code, and the check that it is connected](docs/screenshots/324-claude-code.png)

## Connect ChatGPT Codex

Codex, in the Codex app, the `codex` command or the Codex extension for VS Code, can use MR Studio. Add it once and all three have it.

1. Install **Node.js** 20 or newer from nodejs.org.
2. In the Codex app, open **Settings**, **MCP servers**, **Add server**. Name it `mrstudio`, with command `npx` and arguments `-y @mrstudio/mcp --project` followed by your tables folder (Documents, MR Studio, sites). Or in a terminal: `codex mcp add mrstudio -- npx -y @mrstudio/mcp`
3. Start a new task. Typing `/mcp` lists the MR Studio tools.
4. If Codex asks to write to your tables folder, allow it.

## Other AI apps

Cursor, VS Code with GitHub Copilot, Windsurf, Gemini CLI, Zed and LM Studio work too. Each needs **Node.js** 20 or newer and the same command, `npx -y @mrstudio/mcp`; the page **docs/MCP.md** in the repository has the steps for each, including one-click links. The ChatGPT chat app cannot use it yet, because it only connects to servers on the internet, not on your computer; use Codex instead.

## Make a table

1. Say what the table is for: who stands around it, and what they should understand or decide. Claude asks for the place, then makes the table.
2. Put your own files (buildings, a spreadsheet of points with `lat` and `lon` columns, pictures) in the table's `data` folder, or bring them in with **Add data** in the editor, and tell Claude their names.
3. Ask for what you want to see: "a sun study at nine in the morning", "make the spots glow, bigger for a higher score", "a short slideshow for the opening talk", "Swedish first".
4. Open the table in MR Studio. Changes Claude makes show up while the editor is open, and **Undo** takes them back.
5. When Claude says something needs a new module, read the draft in the table's `requests` folder. Nothing is sent unless you say yes.

## A short example

> **You**: A workshop table on where to put new benches in Lindholmen. I have a spreadsheet of 40 suggested spots, with a type and a score.
>
> **Claude**: Who stands around the table, and what should they decide?
>
> **You**: Residents and two planners. They should agree on the ten best spots.
>
> **Claude**: I've made the table, 1000 × 600 m around Lindholmen. Put `spots.csv` in its `data` folder and bring in buildings and streets with Add data, OpenStreetMap.
>
> **You**: Done. Make the spots glow, coloured by type, bigger for a higher score, and add a morning sun study.
>
> **Claude**: Added "Suggested spots" and "Morning sun" as buttons in a Workshop group, with trees, traffic and lit windows at rest.
>
> **You**: And a four-slide tour for the opening, in Swedish first.
>
> **Claude**: The tour has an old photo, morning and afternoon sun, then the spots, each with a note for your phone. The table starts in Swedish. Everything checks out; open it in MR Studio.

The full conversation, and the table it writes, are in `docs/MCP.md` in the repository.
