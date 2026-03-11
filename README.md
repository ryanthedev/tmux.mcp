# tmux.mcp

A single-tool MCP server that gives AI assistants full control of tmux. One tool, 18 actions, plain text responses.

Most tmux MCP servers expose 10-15 separate tools. Each tool definition eats context tokens whether you use it or not. This server packs everything into one tool with an `action` parameter. The schema costs ~50 tokens. The server teaches itself to the model through self-describing responses: call an action with missing params and it tells you what it needs.

## Install

```bash
git clone https://github.com/ryanthedev/tmux.mcp.git
cd tmux.mcp
npm install
```

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "node",
      "args": ["/path/to/tmux.mcp/server.js"]
    }
  }
}
```

Requires tmux and Node.js 18+.

## How it works

Call with no arguments to see all actions:

```
tmux()
→ you are here: main:0.1 (session: main)

  tmux actions:
    list, session, read, watch, send, type,
    sendwait, typewait, exec, result,
    new-session, kill-session, new-window, kill-window,
    split, kill-pane, rename, layout
```

Call an action without required params for its help:

```
tmux(action: "exec")
→ exec: run command with marker-based tracking
    params: target (session:win.pane), text (command to run)
    returns a commandId — use 'result' to check status/output/exit code
    example: action:exec target:main:0.0 text:npm test
```

The model learns the tool by using it. No upfront documentation cost.

## Actions

### Observe

| Action | What it does |
|--------|-------------|
| `list` | All sessions. Named ones show windows; numbered ones get a one-line summary. |
| `session` | One session in detail, with a preview of each pane's last visible line. |
| `read` | Capture pane output. Set `lines` for history depth (default 100). |
| `watch` | Delta since last read. Only new lines come back. |
| `layout` | Every pane across all sessions with dimensions and running process. |

### Act

| Action | What it does |
|--------|-------------|
| `send` | Space-separated key tokens: `Escape :q! Enter`, `C-c`, `Down Down Enter`. |
| `type` | Literal text, spaces preserved. No Enter appended. |
| `sendwait` | Send keys, then poll until a shell prompt appears or output stops changing. Returns the delta. |
| `typewait` | Type literal text + Enter, then wait. One call for "run this command and show me what happened." |
| `exec` | Wraps a command in start/done markers, returns a `commandId`. Non-blocking. |
| `result` | Check a tracked command's status, exit code, and output by `commandId`. |

### Manage

| Action | What it does |
|--------|-------------|
| `new-session` | Create a session. |
| `kill-session` | Kill a session. |
| `new-window` | Create a window in a session, optionally named. |
| `kill-window` | Kill a window. |
| `split` | Split a pane. `text: "horizontal"` or `"vertical"` (default). |
| `kill-pane` | Kill a pane. |
| `rename` | Rename a window. |

## Design choices

**One tool, not thirteen.** Tool definitions live in the system prompt and cost tokens on every message. Thirteen tools with typed schemas run 1000+ tokens of constant overhead. One tool with an action enum: ~50. The help text lives server-side, returned only when requested.

**Plain text, not JSON.** Every response is plain text. JSON keys, braces, and quotes add tokens without adding meaning for the model. A `list` call returns something like:

```
main/
  :0 editor (2p) *
  :1 server (1p)

12 unnamed sessions (23-34)
```

Not a nested object with `sessions[].windows[].name`.

**Self-awareness.** The server reads `$TMUX_PANE` on startup and reports `you are here: main:0.1` in every listing. So the model knows which pane is itself, won't read its own output, and can scope "this session" without guessing.

**Pagination.** Responses longer than 10 lines get paginated. The model sees the first page and a hint: `page 1/8 (79 lines) — pass page:2 for more`. Override with `pageSize` per request. This keeps context tight when listing 30+ sessions.

**`type` vs `send`.** `send` splits on spaces and treats each token as a tmux key name. Good for `Escape :q! Enter`, but it destroys prose. `type` uses tmux's `-l` flag to send literal text with spaces intact. Two actions because the model kept mangling sentences through `send`.

**`exec`/`result` for long commands.** `sendwait` blocks for up to 30 seconds, which works for quick commands. `exec` drops start/done markers around the command, returns immediately with a `commandId`, and `result` checks on it later. The markers capture the exact output and exit code. Auto-detects zsh, bash, or fish for the exit code variable. Commands expire after 10 minutes.

**Completion detection.** `sendwait` and `typewait` poll every 500ms. Two signals: a shell prompt (`❯`, `$`, `#`, `%`) means the command finished; output unchanged for 2 seconds means it settled. Prompt detection catches the common case fast. Quiesce handles TUIs. 30-second timeout as a ceiling.

## Parameters

| Param | Type | Used by |
|-------|------|---------|
| `action` | string (enum) | All calls |
| `target` | string | Most actions. Format: `session:window.pane` |
| `text` | string | send, type, exec, rename, new-session, new-window, split |
| `lines` | number | read, watch, sendwait, typewait (history depth, default 100) |
| `page` | number | Any action (pagination, default 1) |
| `pageSize` | number | Any action (override default of 10) |
| `commandId` | string | result |

## License

MIT
