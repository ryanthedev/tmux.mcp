#!/bin/bash
# Auto-inbox hook for tmux.mcp coordination
# Checks for new messages addressed to this agent or broadcast to "all"
# Runs on UserPromptSubmit — injects messages into context passively

AGENT_NAME="${TMUX_MCP_AGENT_NAME:-}"
if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

LAST_SEQ_FILE="/tmp/tmux_mcp_inbox_${AGENT_NAME}"
LAST_SEQ=0
if [ -f "$LAST_SEQ_FILE" ]; then
  LAST_SEQ=$(cat "$LAST_SEQ_FILE")
fi

BUFFERS=$(tmux list-buffers -F '#{buffer_name}' 2>/dev/null | grep '^mcp_msg_' | sort -t_ -k3 -n)
if [ -z "$BUFFERS" ]; then
  exit 0
fi

NEW_MESSAGES=""
MAX_SEQ=$LAST_SEQ

while IFS= read -r buf; do
  SEQ=$(echo "$buf" | sed 's/mcp_msg_//')
  if [ "$SEQ" -le "$LAST_SEQ" ]; then
    continue
  fi

  CONTENT=$(tmux show-buffer -b "$buf" 2>/dev/null)
  if [ -z "$CONTENT" ]; then
    continue
  fi

  # parse: timestamp|from|to|message
  TO=$(echo "$CONTENT" | cut -d'|' -f3)

  # only show messages to me or broadcast
  PANE_ID=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}' 2>/dev/null)
  if [ "$TO" != "$AGENT_NAME" ] && [ "$TO" != "all" ] && [ "$TO" != "$PANE_ID" ]; then
    continue
  fi

  FROM=$(echo "$CONTENT" | cut -d'|' -f2)
  # skip messages from myself
  if [ "$FROM" = "$AGENT_NAME" ]; then
    if [ "$SEQ" -gt "$MAX_SEQ" ]; then
      MAX_SEQ=$SEQ
    fi
    continue
  fi

  TS=$(echo "$CONTENT" | cut -d'|' -f1)
  MSG=$(echo "$CONTENT" | cut -d'|' -f4-)
  NOW=$(date +%s)
  AGO=$(( NOW - (TS / 1000) ))

  NEW_MESSAGES="${NEW_MESSAGES}[${FROM} ${AGO}s ago]: ${MSG}
"

  if [ "$SEQ" -gt "$MAX_SEQ" ]; then
    MAX_SEQ=$SEQ
  fi
done <<< "$BUFFERS"

echo "$MAX_SEQ" > "$LAST_SEQ_FILE"

if [ -n "$NEW_MESSAGES" ]; then
  echo "--- incoming messages ---"
  echo "$NEW_MESSAGES"
  echo "--- end messages (use tmux post to reply) ---"
fi
