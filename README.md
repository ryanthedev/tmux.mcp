# claude-mux.mcp

MCP server for tmux. One tool, 27 actions, plain text. Gives Claude Code terminal control and multi-agent coordination through tmux sessions.

Other tmux MCP servers expose 10-15 separate tools. Each definition sits in the system prompt and costs tokens on every message. This server packs everything into a single `tmux` tool with an `action` parameter. Schema cost: ~50 tokens. Call an action with missing params and it tells you what it needs.

## Install

```bash
git clone https://github.com/ryanthedev/claude-mux.mcp.git
cd claude-mux.mcp
npm install
```

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "tmux": {
      "command": "node",
      "args": ["/path/to/claude-mux.mcp/server.js"]
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
    list, session, read, tail, watch, send, type, ...
```

Call an action without required params for its help:

```
tmux(action: "exec")
→ exec: run command with marker-based tracking
    params: target (session:win.pane), text (command to run)
    returns a commandId — use 'result' to check status/output/exit code
```

The model learns the tool by using it. No upfront documentation cost.

## Actions

### Observe

| Action | What it does |
|--------|-------------|
| `list` | All sessions. Named ones show windows; numbered ones get a one-line summary. |
| `session` | One session in detail, previewing each pane's last visible line. |
| `read` | Capture pane output. `lines` sets history depth (default 100). |
| `tail` | Last N lines, no pagination. Quick look at what just happened. |
| `watch` | Delta since last read. Only new lines come back. |
| `layout` | Every pane across all sessions with dimensions and running process. |

### Act

| Action | What it does |
|--------|-------------|
| `send` | Space-separated key tokens: `Escape :q! Enter`, `C-c`, `Down Down Enter`. |
| `type` | Literal text, spaces preserved. No Enter appended. |
| `sendwait` | Send keys, poll until prompt appears or output settles. Returns the delta. |
| `typewait` | Type literal text + Enter, then wait. One call for "run this and show me what happened." |
| `exec` | Wrap a command in start/done markers, return a `commandId`. Non-blocking. |
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

### Coordinate

Cross-session agent messaging and task ownership. All state lives in tmux global environment and named buffers.

| Action | What it does |
|--------|-------------|
| `register` | Identify yourself by name. Stored globally so other agents can find you. |
| `unregister` | Remove your registration. |
| `who` | List all registered agents across all sessions. |
| `post` | Message an agent by name, or `"all"` for broadcast. |
| `inbox` | Check for new messages. |
| `claim` | Take a task. Atomic file lock prevents two agents from claiming the same one. |
| `complete` | Mark a task done, release the lock. |
| `tasks` | List all tasks with owner and status. |

### Workers

Spawn Claude Code instances as coordinating agents. Each worker gets a name, a team roster, and auto-injected inbox hooks so messages arrive without polling.

| Action | What it does |
|--------|-------------|
| `spawn` | One-shot `claude -p`. Auto-closes when done, captures output to a tmux buffer. |
| `spawn-persist` | Same, but the window stays open for inspection. |
| `teammate` | Interactive `claude` session. Stays alive for ongoing coordination. |
| `despawn` | Kill a worker, clean up registration and temp files. |
| `worker-result` | Read a completed worker's captured output. |

## Design choices

**One tool, not twenty-seven.** Tool definitions cost tokens on every message. Twenty-seven separate tools with typed schemas: 2000+ tokens of constant overhead. One tool with an action enum: ~50. Help text lives server-side, returned only when requested.

**Plain text, not JSON.** A `list` call returns:

```
main/
  :0 editor (2p) *
  :1 server (1p)

12 unnamed sessions (23-34)
```

Not a nested object with `sessions[].windows[].name`. JSON braces and quotes add tokens without helping the model parse.

**Self-awareness.** The server reads `$TMUX_PANE` on startup and reports `you are here: main:0.1` in every listing. The model knows which pane is itself, won't read its own output, and can scope "this session" without guessing.

**Pagination.** Responses longer than 50 lines get paginated, newest first. Page 1 is the most recent output. `pageSize` overrides the default per request.

**`type` vs `send`.** `send` splits on spaces and treats each token as a tmux key name. Good for `Escape :q! Enter`, but it destroys prose. `type` sends literal text with spaces intact. Two actions because the model kept mangling sentences through `send`.

**`exec`/`result` for long commands.** `sendwait` blocks for up to 30 seconds. `exec` drops start/done markers around the command, returns a `commandId` immediately, and `result` checks on it later. Markers capture exact output and exit code. Auto-detects zsh, bash, or fish. Commands expire after 10 minutes.

**Completion detection.** `sendwait` and `typewait` poll every 500ms. A shell prompt (`❯`, `$`, `#`, `%`) means the command finished. Output unchanged for 2 seconds means it settled. 30-second timeout as a ceiling.

**Atomic task claiming.** `claim` uses `O_EXCL` file creation so two agents racing for the same task can't both win. `complete` releases the lock.

## Parameters

| Param | Type | Used by |
|-------|------|---------|
| `action` | string (enum) | All calls |
| `target` | string | Most actions. Format: `session:window.pane` |
| `text` | string | send, type, exec, rename, new-session, new-window, split, post, claim, complete, spawn, teammate |
| `lines` | number | read, tail, watch, sendwait, typewait (history depth) |
| `page` | number | Any action (pagination, default 1 = newest) |
| `pageSize` | number | Any action (override default of 50) |
| `commandId` | string | result |
| `name` | string | spawn, spawn-persist, teammate (agent name) |

## License

MIT
