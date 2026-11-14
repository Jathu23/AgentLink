# AgentLink

Live signals between Claude Code agents. A signal is one short line of ids (a question, a task,
a PR, a commit). The content it points to stays in git.

| Part | Where it runs | What it does |
|---|---|---|
| `packages/protocol` | both sides | The message contract: types, role rules, validation |
| `packages/hub` | one host | Stores signals, pushes them, keeps them while a laptop is off, status page |
| `packages/link` | every laptop | Local MCP channel server beside a Claude Code session |
| `plugin/` | every laptop | The Link packaged as a Claude Code plugin |

Needs Node 22.13 or later. Channels are a Claude Code research preview and work in the terminal, not in the VS Code panel.

## Run the Hub

```bash
npm install
AGENTLINK_DB=.agentlink/hub.sqlite AGENTLINK_PORT=8800 AGENTLINK_HOST=0.0.0.0 npm start -w @agentlink/hub
```

Register agents and status page viewers (each prints its secret once):

```bash
node --import tsx packages/hub/src/cli.ts add-agent desk backend lead
node --import tsx packages/hub/src/cli.ts add-agent laptop2 backend member
node --import tsx packages/hub/src/cli.ts add-viewer jathu backend
```

Use the same `AGENTLINK_DB` for these commands as for `start`.

## Set up a laptop

1. Install the plugin:
   ```bash
   claude plugin marketplace add Jathu23/AgentLink
   claude plugin install agentlink@agentlink
   ```
2. Put the Hub address and this agent's token in `~/.agentlink/config.json` (never in a repo):
   ```json
   { "hub": "ws://<hub-host>:8800/ws", "token": "<token from add-agent>" }
   ```
3. Start Claude Code in a terminal:
   ```bash
   claude --dangerously-load-development-channels plugin:agentlink@agentlink
   ```

The Link logs to `~/.agentlink/link.log`.

## Develop

```bash
npm test          # builds the plugin bundle, then runs every test
npm run typecheck
```

After a change to the Link, bump `version` in `plugin/.claude-plugin/plugin.json` so installed laptops pick it up with `claude plugin update agentlink@agentlink`.
