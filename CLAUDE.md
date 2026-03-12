# tmux.mcp

Single-file MCP server for tmux control and cross-session agent coordination. ~1100 lines of JS, one tool with 26 actions.

## Architecture

Everything runs through one MCP tool called `tmux` with an `action` parameter. This keeps schema overhead at ~50 tokens regardless of how many actions exist. Help text lives server-side and is returned only when requested (call an action with missing params).

All responses are plain text, not JSON. Paginated at 10 lines by default.

### File layout

```
server.js              the entire MCP server
hooks/inbox-check.sh   auto-inbox hook injected into spawned workers
package.json           just @modelcontextprotocol/sdk dependency
```

### State storage

Nothing touches the filesystem for coordination state. Everything lives in tmux itself:

| What | Where | Scope |
|------|-------|-------|
| Agent registry | `tmux set-environment -g MCP_AGENT_{pane}` | Global (all sessions) |
| Messages | `tmux set-buffer -b mcp_msg_{seq}` | Global |
| Tasks | `tmux set-environment -g MCP_TASK_{name}` | Global |
| Command tracking | In-memory `commands` Map | Per MCP server process |
| Watch deltas | In-memory `lastRead` Map | Per MCP server process |
| Worker hooks | `/tmp/tmux-mcp-{name}/.claude/settings.json` | Per worker |
| Inbox sequence | `/tmp/tmux_mcp_inbox_{name}` | Per worker |

In-memory state (commands, lastRead) is lost on MCP server restart. Tmux-backed state survives MCP restarts but is lost when tmux server exits.

## Action groups

### Observe (read-only)
- `list` - all sessions, unnamed ones summarized
- `session` - one session with pane previews (peeks last line of each pane)
- `read` - capture pane output
- `watch` - delta since last read
- `layout` - all panes with sizes and running process

### Input
- `send` - space-separated key tokens (`Escape :q! Enter`). Does NOT auto-append Enter.
- `type` - literal text with spaces preserved (`-l` flag). No Enter.
- `sendwait` - send keys + poll for completion (prompt detection or 2s quiesce)
- `typewait` - type literal text + Enter + poll for completion

`send` vs `type` exists because `send` splits on spaces (needed for key sequences) but destroys prose. `type` uses tmux's literal flag.

### Command tracking
- `exec` - wraps command in start/done markers, returns `commandId`. Non-blocking.
- `result` - checks command status, exit code, output by `commandId`. Commands expire after 10 min.

Markers: `TMUX_MCP_START_{id}` and `TMUX_MCP_DONE_{id}_{exitcode}`. Auto-detects shell (zsh/bash/fish) for exit code variable.

### CRUD
- `new-session`, `kill-session`, `new-window`, `kill-window`, `split`, `kill-pane`, `rename`

### Coordination
- `register` - identify yourself by name. Stored in tmux global env.
- `unregister` - remove registration
- `who` - list all registered agents across all sessions
- `post` - message an agent by name or `all` for broadcast. Uses tmux named buffers.
- `inbox` - check new messages. Tracks last-seen sequence per agent.
- `claim` - take a task. Check-then-set (not atomic, known limitation).
- `complete` - mark task done
- `tasks` - list all tasks with owner/status

### Workers
- `spawn` - one-shot `claude -p`. Auto-closes window, captures output to buffer, unregisters.
- `spawn-persist` - same but window stays open for inspection.
- `teammate` - interactive `claude` session. Stays alive for ongoing coordination.
- `despawn` - kill worker, clean up registration + temp files + hooks.
- `worker-result` - read completed worker's captured output from tmux buffer.

All spawn variants accept `name` parameter. Auto-inject a coordination preamble telling the worker its name, current team roster, and the messaging protocol. Workers don't need to be told how to coordinate; they learn from the preamble.

## Hooks

`hooks/inbox-check.sh` gets injected as a `UserPromptSubmit` hook into every spawned worker. On each turn:

1. Reads `TMUX_MCP_AGENT_NAME` env var to know who it is
2. Lists all `mcp_msg_*` tmux buffers
3. Filters to messages addressed to this agent or "all"
4. Skips already-seen messages (sequence tracked in `/tmp/tmux_mcp_inbox_{name}`)
5. Outputs new messages so they appear in the worker's context automatically

Workers never need to call `inbox` explicitly. Messages arrive passively.

## Self-awareness

The server reads `$TMUX_PANE` on startup to resolve its own `session:window.pane` target. Reported as `you are here:` in `list`, `session`, `layout`, and help output. This lets the model scope requests to "this session" and avoid reading its own pane.

## Known limitations

- **Task claiming is not atomic.** Two agents racing to claim the same task could both succeed. Would need file locking or a compare-and-swap on tmux env vars.
- **Message ordering.** Buffer sequence numbers are derived from `list-buffers` at post time. High message volume could theoretically produce sequence collisions.
- **Worker hooks assume project-level settings.** If the worker's target directory already has `.claude/settings.json`, the spawner overwrites it. Teammates spawned with a repo path as target will create `.claude/` in that repo.
- **No message cleanup.** Buffers accumulate. Old messages stay in tmux until the server exits. Could add a `cleanup` action or TTL-based pruning.
- **`claude -p` workers can't receive follow-up input.** Only `teammate` (interactive) mode supports ongoing conversation via `type`.
- **Pagination hint says "pass page:2"** but the model sometimes ignores it and makes assumptions about truncated content.

## Design decisions worth knowing

**Why one tool?** Tool definitions live in the system prompt and cost tokens on every message. 26 separate tools would be 2000+ tokens of constant overhead. One tool with an enum: ~80. The tradeoff is less structured parameter validation per action.

**Why plain text?** JSON keys, braces, and quotes consume tokens without helping the model parse. Plain text responses are ~80% smaller for the same information.

**Why tmux as the coordination backend?** Global environment vars and named buffers are shared across all sessions with no file I/O. tmux is already running. No extra infrastructure.

**Why inject hooks instead of relying on explicit inbox checks?** `claude -p` workers run a single agentic loop. They won't proactively check inbox unless the preamble tells them to, and even then it's unreliable. The hook makes it passive and guaranteed.
