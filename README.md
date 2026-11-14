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

## Run the Hub on Cloudflare (free plan)

The same Hub rules run in a Durable Object (`cloudflare/src/worker.ts`).

```bash
npx wrangler login
npm run hub:deploy                                   # prints the https://...workers.dev address
npx wrangler secret put ADMIN_KEY --config cloudflare/wrangler.jsonc   # a long random string, keep it private
```

Register agents and viewers with the admin script (set `AGENTLINK_URL` to the workers.dev address and `AGENTLINK_ADMIN_KEY` to the secret):

```bash
node cloudflare/admin.mjs add-agent desk backend lead
node cloudflare/admin.mjs add-viewer jathu backend
node cloudflare/admin.mjs remove-agent laptop2      # then add-agent again for a new token
```

`node --import tsx cloudflare/smoke.mts` checks a running Hub end to end with its own test agents.

## Set up a laptop

Needs Node 22.13 or later and the Claude Code terminal command (`claude`). Double-click `kit/agentlink-setup.bat`, or run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Jathu23/AgentLink/main/kit/setup.ps1 | iex
```

It installs the plugin, asks for your token, checks it with the Hub, saves it in `~/.agentlink/config.json` (never in a repo) and puts an **AgentLink** shortcut on the Desktop. Run it again to update.

| Session | Sends | Receives |
|---|---|---|
| Any Claude Code session, the VS Code panel included | `signal` tool | `inbox` tool, when asked |
| The Desktop shortcut (terminal session with the channel flag) | `signal` tool | pushed as they arrive, wakes the session |

The Link logs to `~/.agentlink/link.log`.

## Develop

```bash
npm test          # builds the plugin bundle, then runs every test
npm run typecheck
```

After a change to the Link, bump `version` in `plugin/.claude-plugin/plugin.json`; laptops pick it up when they run the setup again.
