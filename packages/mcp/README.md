# MR Studio for AI apps

`@mrstudio/mcp` is the [MCP](https://modelcontextprotocol.io) server of [MR Studio](https://github.com/snjsomnath/mr-studio), the app for projection-mapped city tables. Connect it to Claude, Cursor, VS Code, Codex or any other MCP client and build a table by describing it: the place, the layers at rest and on buttons, a slideshow tour, the TV dashboard. Every change is checked against the version of MR Studio it was built with, and ideas that need something new become a drafted request to the MR Studio team, sent only when you say so.

```sh
npx -y @mrstudio/mcp          # stdio; needs Node.js 20+
```

| App | Setup |
| --- | --- |
| Claude Desktop | Download [mr-studio.mcpb](https://github.com/snjsomnath/mr-studio/releases/latest/download/mr-studio.mcpb) and double-click it |
| Claude Code | `claude mcp add mrstudio -- npx -y @mrstudio/mcp` |
| Cursor | [Add to Cursor](https://cursor.com/en/install-mcp?name=mrstudio&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtcnN0dWRpby9tY3AiXX0=) |
| VS Code | `code --add-mcp '{"name":"mrstudio","type":"stdio","command":"npx","args":["-y","@mrstudio/mcp"]}'` |
| ChatGPT Codex (app, CLI, IDE) | `codex mcp add mrstudio -- npx -y @mrstudio/mcp` |
| Gemini CLI | `gemini mcp add mrstudio npx -y @mrstudio/mcp` |
| Others | command `npx`, arguments `["-y", "@mrstudio/mcp"]` |

Started from the home folder (as desktop apps do), it works in MR Studio's tables folder, `Documents/MR Studio/sites`; elsewhere, in the current folder. `--project <folder>` chooses another.

Step-by-step setup with pictures for each app, the tools, and a sample conversation: [docs/MCP.md](https://github.com/snjsomnath/mr-studio/blob/main/docs/MCP.md).

The version of this package is the MR Studio version it describes. Use the one that matches your app: `npx -y @mrstudio/mcp@<version>`, for example `@0.8.0`.
