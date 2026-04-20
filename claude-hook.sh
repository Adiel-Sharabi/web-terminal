#!/bin/bash
# Claude Code hook for web-terminal session status.
# Only fires when running inside a web-terminal PTY (WT_SESSION_ID is set).
# Regular CLI sessions skip this entirely.
[ -z "$WT_SESSION_ID" ] && exit 0

PORT="${WT_SESSION_PORT:-7681}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# H1: read per-process hook token; without it, exit silently.
HOOK_TOKEN_FILE="${SCRIPT_DIR}/.hook-token"
[ -r "$HOOK_TOKEN_FILE" ] || exit 0
HOOK_TOKEN=$(tr -d '[:space:]' < "$HOOK_TOKEN_FILE")
[ -z "$HOOK_TOKEN" ] && exit 0

# Event name comes via stdin JSON from Claude Code
INPUT=$(cat)
EVENT=$(echo "$INPUT" | sed -n 's/.*"hook_event_name" *: *"\([^"]*\)".*/\1/p' | head -1)
[ -z "$EVENT" ] && exit 0

# Fire and forget — don't slow down Claude
curl -sf "http://127.0.0.1:${PORT}/api/session/${WT_SESSION_ID}/hook" \
  -H "Content-Type: application/json" \
  -H "X-WT-Hook-Token: ${HOOK_TOKEN}" \
  -d "{\"event\":\"${EVENT}\"}" \
  -o /dev/null 2>/dev/null &
exit 0
