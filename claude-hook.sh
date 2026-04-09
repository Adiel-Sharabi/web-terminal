#!/bin/bash
# Claude Code hook for web-terminal session status.
# Only fires when running inside a web-terminal PTY (WT_SESSION_ID is set).
# Regular CLI sessions skip this entirely.
[ -z "$WT_SESSION_ID" ] && exit 0

PORT="${WT_SESSION_PORT:-7681}"
EVENT="$CLAUDE_HOOK_EVENT"
[ -z "$EVENT" ] && exit 0

# Fire and forget — don't slow down Claude
curl -sf "http://127.0.0.1:${PORT}/api/session/${WT_SESSION_ID}/hook" \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"${EVENT}\"}" \
  -o /dev/null 2>/dev/null &
exit 0
