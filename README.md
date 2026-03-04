# TokenLens MCP Server

MCP server that exposes [TokenLens](https://tokenlens.dev) pricing data as tools for AI agents (Claude Code, Cursor, Windsurf, Claude Desktop, etc.).

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

**Cursor · Windsurf · Claude Desktop** — add to config JSON:

- Cursor: `~/.cursor/mcp.json`
- Windsurf: `~/.codeium/windsurf/mcp_config.json`
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tokenlens": {
      "command": "node",
      "args": ["/path/to/tokenlens-mcp/dist/index.js"]
    }
  }
}
```

### 3. Verify

Restart your editor, then ask your agent:
```
Use the tokenlens recommend_plan tool. I code 3h/day on claude-sonnet.
```

## Data

Pricing data lives in `data/` and is updated in the main [tokenlens](https://github.com/flikQ/tokenlens) repo. Pull the latest to stay current.

## License

MIT
