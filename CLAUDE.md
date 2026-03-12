# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-file MCP server (`server.js`, ~1100 lines) for tmux control and cross-session agent coordination. One tool called `tmux` with 26 actions dispatched via an `action` enum parameter. All responses are plain text, paginated at 10 lines.

## Development

```bash
npm install                    # only dependency: @modelcontextprotocol/sdk
node server.js                 # runs via stdio (MCP transport), not HTTP
```

No tests, no linter, no build step. The server is added to Claude's MCP config and communicates over stdin/stdout.

To test locally, configure in `~/.claude.json`:
```json
{ "mcpServers": { "tmux": { "command": "node", "args": ["/path/to/server.js"] } } }
```

## Architecture

Everything routes through one MCP tool → `dispatch()` switch statement → individual action functions. Help text lives server-side in `HELP_ACTIONS` object, returned only when an action is called with missing params (keeps schema overhead at ~50 tokens).

### State storage

| What | Where | Survives restart? |
|------|-------|-------------------|
| Agent registry | `tmux set-environment -g MCP_AGENT_{pane}` | Yes (tmux) |
| Messages | `tmux set-buffer -b mcp_msg_{seq}` | Yes (tmux) |
| Tasks | `tmux set-environment -g MCP_TASK_{name}` | Yes (tmux) |
| Command tracking | In-memory `commands` Map | No |
| Watch deltas | In-memory `lastRead` Map | No |
| Worker hooks | `/tmp/claude-mux-{name}/.claude/settings.json` | Cleaned on despawn |
| Inbox sequence | `/tmp/claude_mux_inbox_{name}` | Cleaned on despawn |

### Key design patterns

- **`send` vs `type`**: `send` splits on spaces (for key sequences like `Escape :q! Enter`). `type` uses tmux `-l` flag for literal text with spaces. Both exist because `send` destroys prose.
- **`exec`/`result`**: Wraps commands in `TMUX_MCP_START_{id}` / `TMUX_MCP_DONE_{id}_{exitcode}` markers. Non-blocking. Auto-detects shell (zsh/bash/fish) for exit code variable.
- **`sendwait`/`typewait`**: Poll every 500ms. Detect completion via prompt regex or 2s quiesce. 30s timeout ceiling.
- **Self-awareness**: Reads `$TMUX_PANE` on startup, reports `you are here:` in listings so the model avoids reading its own pane.
- **Worker spawning**: `spawn`/`spawn-persist`/`teammate` all create a new tmux window, register the agent, inject a coordination preamble, and set up inbox hooks. `spawn` auto-closes; `teammate` stays interactive.

### Hooks

`hooks/inbox-check.sh` is injected as a `UserPromptSubmit` hook into every spawned worker. It reads `TMUX_MCP_AGENT_NAME` env var, scans `mcp_msg_*` buffers, filters by recipient, and outputs new messages into the worker's context. Workers never explicitly call `inbox`.

## Known limitations

- Task claiming (`claim`) is not atomic — two agents can race and both succeed
- Message sequence numbers derived from `list-buffers` count; high volume could produce collisions
- Worker hooks overwrite `.claude/settings.json` in the work directory
- No message cleanup — buffers accumulate until tmux exits
- `claude -p` workers can't receive follow-up input; only `teammate` mode supports ongoing conversation
