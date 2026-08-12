#!/usr/bin/env node
'use strict';
// Point this machine's Claude Code status line at the repo-owned pusher
// (scripts/wt-push-status.sh), so POST /api/claude-status receives the FULL
// statusline payload instead of the four numbers the old inline block forwarded.
//
// Sibling of install-hooks.js: the repo owns the machine-local Claude config that
// implements its contracts, because a per-machine copy of a wire format drifts.
// See scripts/wt-push-status.sh for the history of that drift (#71, #69).
//
//   node scripts/install-statusline.js          # patch
//   node scripts/install-statusline.js --check   # report only, change nothing
//
// It patches ONLY the push block and leaves the user's own rendering — memory
// segment, folder|branch, effort — untouched. Rendering is preference; pushing is
// this repo's contract. Run it on every machine after upgrading the server.
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
// Two spellings of one path, and they are not interchangeable: Node checks the file
// with the NATIVE path, while the line we write into a bash script must be the POSIX
// one Git Bash resolves (C:\dev\… -> /c/dev/…).
const PUSHER_NATIVE = path.resolve(__dirname, 'wt-push-status.sh');
const PUSHER = PUSHER_NATIVE
  .replace(/\\/g, '/')
  .replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());

const MARKER = 'wt-push-status.sh';
const BLOCK_START = '# --- Push metrics to the local web-terminal server';
const NEW_BLOCK = `# --- Push metrics to the local web-terminal server (companion app / sidebar) ---
# Managed by web-terminal: scripts/install-statusline.js. The payload is forwarded
# VERBATIM and parsed server-side (lib/metrics-claude.js) — do not extract fields here.
if [ -f "${PUSHER}" ]; then
    echo "$INPUT" | bash "${PUSHER}" "$SID" &
fi
`;

function fail(msg) {
  console.error('install-statusline: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(SCRIPT)) {
  fail(`no status-line script at ${SCRIPT}.\n` +
    `  Nothing was changed. Create it (and set settings.json statusLine to run it),\n` +
    `  then re-run. See scripts/wt-push-status.sh for the one line it needs.`);
}
if (!fs.existsSync(PUSHER_NATIVE)) fail(`pusher missing at ${PUSHER_NATIVE} — is the repo checked out fully?`);

const src = fs.readFileSync(SCRIPT, 'utf8');

if (src.includes(MARKER)) {
  console.log('Already installed — status line forwards the raw payload. No change.');
  process.exit(0);
}

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
let out;
if (start === -1) {
  fail(`could not find the existing push block in ${SCRIPT}.\n` +
    `  Nothing was changed — the file was NOT guessed at. Add this line yourself,\n` +
    `  anywhere after the script reads stdin into $INPUT:\n` +
    `    echo "$INPUT" | bash "${PUSHER}" "$SID" &`);
} else {
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

  if (CHECK) {
    console.log(`Would patch ${SCRIPT} (push block -> ${PUSHER}).`);
    console.log(`Server accepts the raw payload.`);
    process.exit(0);
  }

  const backup = SCRIPT + '.bak';
  fs.copyFileSync(SCRIPT, backup);
  fs.writeFileSync(SCRIPT, out);
  console.log(`Patched ${SCRIPT}`);
  console.log(`  backup: ${backup}`);
  console.log(`  pusher: ${PUSHER}`);
  console.log('The next status-line render forwards the full payload (window size + 5h reset time).');
})();
