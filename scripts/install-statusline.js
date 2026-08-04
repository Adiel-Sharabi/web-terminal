#!/usr/bin/env node
'use strict';
// Point this machine's Claude Code status line at the repo-owned pusher
// (scripts/wt-push-status.sh), so POST /api/claude-status receives the FULL
// statusline payload instead of the four numbers the old inline block forwarded.
//
// Sibling of fix-hooks.js: the repo owns the machine-local Claude config that
// implements its contracts, because a per-machine copy of a wire format drifts.
// See scripts/wt-push-status.sh for the history of that drift (#71, #69).
//
//   node scripts/install-statusline.js          # patch
//   node scripts/install-statusline.js --check   # report only, change nothing
//
// It patches ONLY the push block and leaves the user's own rendering — memory
// segment, folder|branch, effort — untouched. Rendering is preference; pushing is
// this repo's contract. Run it on every machine after upgrading the server.
//
// TWO THINGS HAVE TO BE TRUE, and this script now checks both — because a machine
// where only one held is SILENT rather than broken-looking, which is how one sat
// unnoticed until someone compared it to another box:
//
//   1. ~/.claude/claude-status.sh forwards the payload (the push block below).
//   2. ~/.claude/settings.json has a `statusLine` entry that RUNS that script.
//
// (2) used to be nobody's job. Claude Code never invokes a status line it was not
// told about, so a perfectly good script sitting at the documented path pushes
// exactly nothing, and the failure surfaces only as an absence: no line in the
// terminal, no ctx/token badge in the sidebar or the companion's chat view. That
// is indistinguishable from "the feature isn't built", so it was assumed to be.
//
// A machine with NO status line at all is likewise seeded rather than refused.
// Refusing was defensible while this only ever patched a block — the file it
// wanted was the user's, and guessing at it would have been the drift this repo
// keeps paying for. But refusing left the operator to hand-write a script whose
// only documented requirement is the one line we already generate, and the
// predictable happened. The seed is a STARTING POINT, not an owned artifact:
// everything outside the two markers is the user's to rewrite, and later runs
// still touch only the block between them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const PORT = process.env.WT_PORT || '7681';

// The compatibility here runs ONE WAY. This server reads both the raw payload and the
// legacy flat push, so an old pusher against a new server is fine. The reverse is not:
// an old server reads a raw payload as four ABSENT numbers and stores a blank report
// over a good one, so every ctx badge on the box goes empty until it is upgraded.
// Hence the gate — install the server first, then run this.
// Asked of /api/claude-status itself, NOT /api/version: the version route is behind
// auth (this script has no credentials), while the status route is localhost-only and
// unauthenticated — the same trust boundary the status line already pushes across. A
// probe POST with no session_id stores nothing and answers `accepts: 'raw'`; a server
// too old to know the field answers without it.
function serverSupportsRawPayload() {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ probe: 'install-statusline' }));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/claude-status', method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ reachable: true, ok: j && j.accepts === 'raw' });
        } catch { resolve({ reachable: true, ok: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, ok: false }); });
    req.on('error', () => resolve({ reachable: false, ok: false }));
    req.end(payload);
  });
}
const SCRIPT = path.join(os.homedir(), '.claude', 'claude-status.sh');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
// Two spellings of one path, and they are not interchangeable: Node checks the file
// with the NATIVE path, while the line we write into a bash script must be the POSIX
// one Git Bash resolves (C:\dev\… -> /c/dev/…).
const toPosix = (p) => p
  .replace(/\\/g, '/')
  .replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const PUSHER_NATIVE = path.resolve(__dirname, 'wt-push-status.sh');
const PUSHER = toPosix(PUSHER_NATIVE);
const SCRIPT_POSIX = toPosix(SCRIPT);

const MARKER = 'wt-push-status.sh';
const BLOCK_START = '# --- Push metrics to the local web-terminal server';
const NEW_BLOCK = `# --- Push metrics to the local web-terminal server (companion app / sidebar) ---
# Managed by web-terminal: scripts/install-statusline.js. The payload is forwarded
# VERBATIM and parsed server-side (lib/metrics-claude.js) — do not extract fields here.
if [ -f "${PUSHER}" ]; then
    echo "$INPUT" | bash "${PUSHER}" "$SID" &
fi
`;

// The seed. Deliberately assembled around the SAME NEW_BLOCK the patcher writes, so
// there is one definition of the push block rather than two that must agree — a
// seeded file is byte-identical, in that region, to a patched one, and re-running
// this script on it takes the "already installed" path.
//
// The renderer is one node spawn for the whole payload. This runs on EVERY status
// line render, and Claude re-renders far more often than the numbers change, so a
// spawn per field would be felt. Fields are tab-separated because a model display
// name ("Opus 4.8") contains spaces.
const SEED = `#!/bin/bash
# Claude Code status line.
#
# SEEDED by web-terminal (scripts/install-statusline.js) on a machine that had no
# status line at all. Everything OUTSIDE the marked push block is YOURS — rewrite
# the rendering however you like. Later runs of the installer only ever replace the
# block between "# --- Push metrics" and the next "# --- " header.
#
# Claude Code pipes this script its status payload on stdin and prints whatever we
# write to stdout as the status line.
set -u

INPUT=$(cat)

FIELDS=$(printf '%s' "$INPUT" | node -e "
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  let j={};
  try { j=JSON.parse(d)||{}; } catch(e) {}
  const cw=j.context_window||{}, rl=j.rate_limits||{}, m=j.model||{}, ef=j.effort||{};
  const pct=v=>(typeof v==='number'&&isFinite(v))?String(Math.round(v)):'';
  process.stdout.write([
    typeof j.session_id==='string'?j.session_id:'',
    m.display_name||m.id||'',
    ef.level||'',
    pct(cw.used_percentage),
    pct((rl.five_hour||{}).used_percentage),
    pct((rl.seven_day||{}).used_percentage)
  ].join('\\t'));
});
" 2>/dev/null)

# Pre-set so 'set -u' is safe when the payload was unparseable and FIELDS is empty.
SID=""
MODEL=""
EFFORT=""
CTX=""
FIVE=""
SEVEN=""
IFS=$'\\t' read -r SID MODEL EFFORT CTX FIVE SEVEN <<< "$FIELDS"

${NEW_BLOCK}
# --- Render (yours to change) -------------------------------------------------
DIR=$(basename "$PWD")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

OUT="$DIR"
[ -n "$BRANCH" ] && OUT="$OUT|$BRANCH"
[ -n "$MODEL" ] && OUT="$OUT · $MODEL"
[ -n "$EFFORT" ] && OUT="$OUT · $EFFORT"
[ -n "$CTX" ] && OUT="$OUT · ctx \${CTX}%"
[ -n "$FIVE" ] && OUT="$OUT · 5h \${FIVE}%"
[ -n "$SEVEN" ] && OUT="$OUT · 7d \${SEVEN}%"

printf '%s' "$OUT"
`;

function fail(msg) {
  console.error('install-statusline: ' + msg);
  process.exit(1);
}

// (2) of the two conditions. Reported and repaired independently of the script,
// because either half can be missing on its own and a half-installed machine looks
// exactly like an uninstalled one.
//
// An EXISTING statusLine is never rewritten: pointing it somewhere else would throw
// away a rendering the user chose, and the push block is installed into whatever
// script that entry already runs. We only ever fill an absence.
function ensureStatusLineSetting(apply) {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') raw = '{}';
    else return { ok: false, msg: `could not read ${SETTINGS}: ${e.message}` };
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch (e) {
    // Never rewrite a settings file we could not parse — that is the user's whole
    // Claude Code configuration, and a JSON error here means we do not understand it.
    return { ok: false, msg: `${SETTINGS} is not valid JSON (${e.message}); left untouched.` };
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { ok: false, msg: `${SETTINGS} is not a JSON object; left untouched.` };
  }

  const existing = s.statusLine;
  if (existing && typeof existing === 'object' && typeof existing.command === 'string' && existing.command.trim()) {
    return { ok: true, changed: false, msg: `settings.json already runs a status line (${existing.command}) — left alone.` };
  }

  const command = `bash ${SCRIPT_POSIX}`;
  if (!apply) return { ok: true, changed: true, msg: `would add settings.json statusLine -> ${command}` };

  try {
    if (raw !== '{}') fs.copyFileSync(SETTINGS, SETTINGS + '.bak');
    s.statusLine = { type: 'command', command, padding: 0 };
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  } catch (e) {
    return { ok: false, msg: `could not write ${SETTINGS}: ${e.message}` };
  }
  return { ok: true, changed: true, msg: `Added settings.json statusLine -> ${command}` };
}

if (!fs.existsSync(PUSHER_NATIVE)) fail(`pusher missing at ${PUSHER_NATIVE} — is the repo checked out fully?`);

const seeding = !fs.existsSync(SCRIPT);
const src = seeding ? null : fs.readFileSync(SCRIPT, 'utf8');
const alreadyPushing = !seeding && src.includes(MARKER);

let out = null;
if (seeding) {
  out = SEED;
} else if (!alreadyPushing) {
  // The script must expose the two variables the injected line uses. If it does not,
  // this is not the script we think it is: report and stop rather than write a block
  // that would silently push nothing.
  for (const v of ['INPUT', 'SID']) {
    if (!new RegExp(`^\\s*${v}=`, 'm').test(src)) {
      fail(`${SCRIPT} defines no $${v}, so the injected push would be empty.\n` +
        `  Nothing was changed. Add this line yourself, after the script reads stdin:\n` +
        `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`);
    }
  }

  const start = src.indexOf(BLOCK_START);
  if (start === -1) {
    fail(`could not find the existing push block in ${SCRIPT}.\n` +
      `  Nothing was changed — the file was NOT guessed at. Add this line yourself,\n` +
      `  anywhere after the script reads stdin into $INPUT:\n` +
      `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`);
  }
  // The block runs to the next top-level `# --- ` section header. Bounded that way
  // rather than by counting `fi`s, which nested conditionals would break.
  const rest = src.slice(start);
  const nextHeader = rest.indexOf('\n# --- ', 1);
  if (nextHeader === -1) {
    fail(`the push block in ${SCRIPT} has no following section header, so its end\n` +
      `  cannot be determined safely. Nothing was changed — patch it by hand.`);
  }
  out = src.slice(0, start) + NEW_BLOCK + rest.slice(nextHeader + 1);
}

(async () => {
  // The server gate guards only the PUSH half. It is asked for whenever we would
  // write a push block; the settings half is unaffected by server version.
  if (out !== null) {
    const gate = await serverSupportsRawPayload();
    if (!gate.ok && !FORCE) {
      if (!gate.reachable) {
        fail(`no web-terminal server answering on 127.0.0.1:${PORT}, so its version could\n` +
          `  not be confirmed. Nothing was changed. Start the server and re-run, or pass\n` +
          `  --force if you know it is already on a build with 'claude-status-raw'.`);
      }
      fail(`the server on 127.0.0.1:${PORT} lacks the\n` +
        `  'claude-status-raw' capability. Nothing was changed — installing now would blank\n` +
        `  every ctx badge on this machine, because an older server reads the raw payload as\n` +
        `  four absent numbers and stores that over the real ones.\n` +
        `  DEPLOY ORDER: update + restart the server FIRST, then re-run this.`);
    }
  }

  if (CHECK) {
    if (out === null) console.log('Push block: already installed — status line forwards the raw payload.');
    else if (seeding) console.log(`Push block: would CREATE ${SCRIPT} (no status line on this machine).`);
    else console.log(`Push block: would patch ${SCRIPT} (push block -> ${PUSHER}).`);
    const st = ensureStatusLineSetting(false);
    console.log('Status line setting: ' + st.msg);
    process.exit(st.ok ? 0 : 1);
  }

  if (out === null) {
    console.log('Push block: already installed — status line forwards the raw payload. No change.');
  } else {
    if (!seeding) {
      const backup = SCRIPT + '.bak';
      fs.copyFileSync(SCRIPT, backup);
      console.log(`Patched ${SCRIPT}`);
      console.log(`  backup: ${backup}`);
    } else {
      fs.mkdirSync(path.dirname(SCRIPT), { recursive: true });
      console.log(`Created ${SCRIPT}`);
    }
    fs.writeFileSync(SCRIPT, out);
    console.log(`  pusher: ${PUSHER}`);
  }

  const st = ensureStatusLineSetting(true);
  console.log('Status line setting: ' + st.msg);
  if (!st.ok) process.exit(1);

  console.log('The next status-line render forwards the full payload (window size + 5h reset time).');
  if (st.changed) console.log('Restart your Claude Code sessions — the statusLine setting is read at startup.');
})();
