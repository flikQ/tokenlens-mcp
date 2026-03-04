# TokenLens MCP Server

MCP server that exposes [TokenLens](https://tokenlens.flikq.dev) pricing data as tools for AI agents (Claude Code, Cursor, Windsurf, Claude Desktop, etc.).

## Tools

| Tool | Description |
|------|-------------|
| `compare_plans` | Rank all plans by effective cost/1M tokens for a given model |
| `run_scenario` | Calculate API vs subscription cost for a usage pattern |
| `break_even` | Find the daily hours where API cost equals a subscription price |
| `recommend_plan` | Single best-value plan for your usage profile |

## Setup

### 1. Install

```bash
git clone https://github.com/flikQ/tokenlens-mcp.git
cd tokenlens-mcp
npm install   # or: bun install
npm run build # or: bun run build
```

### 2. Connect to your editor

**Claude Code** (one command):
```bash
claude mcp add tokenlens -- node /path/to/tokenlens-mcp/dist/index.js
```

To always use live pricing data from tokenlens.flikq.dev:
```bash
claude mcp add tokenlens -- env TOKENLENS_DATA_URL=https://tokenlens.flikq.dev/api/data node /path/to/tokenlens-mcp/dist/index.js
```

**Cursor · Windsurf · Claude Desktop** — add to config JSON:

- Cursor: `~/.cursor/mcp.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tokenlens": {
      "command": "node",
      "args": ["/path/to/tokenlens-mcp/dist/index.js"],
      "env": {
        "TOKENLENS_DATA_URL": "https://tokenlens.flikq.dev/api/data"
      }
    }
  }
}
```

### 3. Verify

Restart your editor, then ask your agent:
```
Use the tokenlens recommend_plan tool. I code 3h/day on claude-sonnet.
```

## Data source

By default the server reads bundled `data/*.json` files from the repo. To always use the latest live pricing data, set:

```
TOKENLENS_DATA_URL=https://tokenlens.flikq.dev/api/data
```

The server fetches all data at startup and caches it in memory. If the URL is unreachable it automatically falls back to the bundled local files.

You can also point at a custom data directory:
```
TOKENLENS_DATA_DIR=/path/to/custom/data
```

## License

MIT
