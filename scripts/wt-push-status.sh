#!/bin/bash
# Forward Claude Code's status-line payload to the local web-terminal server.
#
# WHY THIS LIVES IN THE REPO
# --------------------------
# `POST /api/claude-status` is this repo's contract, and lib/metrics-claude.js is the
# SSOT for what a status payload MEANS. The producer used to be a hand-written block
# inside the user's own ~/.claude/claude-status.sh — a second, per-machine place that
# had to know the wire format. It drifted exactly as you'd expect: it parsed out four
# numbers and dropped `context_window.context_window_size` and
# `rate_limits.five_hour.resets_at` on the floor, which cost us #71 (the companion
# guessed a 200k window and pinned 1M sessions at ~100%) and left #69's Claude
# auto-resume stubbed to null.
#
# So the pusher moves here and forwards the payload VERBATIM. The server does the
# parsing; this script never again needs to know which fields matter. Rendering stays
# in the user's own status-line script — that is their preference, not our contract.
#
# INSTALL — add ONE line to ~/.claude/claude-status.sh, after it reads stdin into
# $INPUT (pass $SID if the script already parsed it, to save a node spawn):
#
#     echo "$INPUT" | bash /c/dev/web-terminal/scripts/wt-push-status.sh "$SID" &
#
# `node scripts/install-statusline.js` does this for you, idempotently.
#
# Contract: reads the payload on stdin, never writes to stdout (the caller's stdout IS
# the status line — a stray echo would corrupt it), and always exits 0. A status line
# must never be slowed or broken by this.

set -u

PORT="${WT_PORT:-7681}"
URL="http://127.0.0.1:${PORT}/api/claude-status"

INPUT=$(cat)
[ -n "$INPUT" ] || exit 0

# The session id keys the throttle stamp. The caller usually has it already; parsing it
# here is the fallback so the script works standalone on a fresh machine.
SID="${1:-}"
if [ -z "$SID" ]; then
  SID=$(printf '%s' "$INPUT" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try { const j=JSON.parse(d); process.stdout.write(typeof j.session_id==='string'?j.session_id:''); }
  catch(e) { process.stdout.write(''); }
});
" 2>/dev/null)
fi
[ -n "$SID" ] || exit 0

# $SID becomes part of a filesystem path below, so constrain it to the shape a session
# id actually has. Claude Code supplies a UUID and this runs locally, but a value that
# reached a path unchecked could escape TMPDIR — cheap to refuse, and it costs nothing
# when the id is what it should be.
case "$SID" in
  *[!A-Za-z0-9._-]*) exit 0 ;;
esac

# Throttle to ~5s per session. Claude Code re-renders the status line far more often
# than the numbers change, and every render would otherwise be an HTTP round trip.
STAMP="${TMPDIR:-/tmp}/wt-cs-$SID"
NOW=$(date +%s)
LAST=0
[ -f "$STAMP" ] && LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
case "$LAST" in (*[!0-9]*|'') LAST=0 ;; esac
[ $((NOW - LAST)) -ge 5 ] || exit 0
echo "$NOW" > "$STAMP" 2>/dev/null

# --data-binary, not -d: -d strips newlines, and the payload is JSON we forward
# unmodified. Capped at 1s and fully silenced — the status line comes first.
printf '%s' "$INPUT" | curl -s -m 1 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  --data-binary @- >/dev/null 2>&1

exit 0
