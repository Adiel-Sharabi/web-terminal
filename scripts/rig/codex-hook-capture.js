// #78 Step 0 — the hook COMMAND run by every event in probe-codex-hook-payloads.js's
// isolated hooks.json. Reads the hook's stdin VERBATIM and writes it to
// <CAP_DIR>/<EVENT>-<seq>.json, so the probe measures the real payload bytes
// instead of a paraphrase.
//
// Argv: codex-hook-capture.js <EVENT_NAME> <CAP_DIR>
//
// Invoked via a per-event .bat wrapper (see probe-codex-hook-payloads.js), NOT
// directly as `"<node>" "<this file>" ...` in hooks.json's command string.
// Measured: codex's hook command IS a literal string handed to the shell, and
// on Windows it does NOT reliably respect quoting around a path that itself
// contains spaces (`C:\Program Files\nodejs\node.exe`) -- with that path quoted
// inline, EVERY hook silently failed to invoke (no marker file, no error
// anywhere in codex's own --json stream). Wrapping in a .bat whose OWN path has
// no spaces, and letting the .bat do the quoting internally, fixed it
// immediately. Keep this file itself off any path containing a space, in case
// a future hooks.json generator forgets the .bat indirection.
'use strict';
const fs = require('fs');
const path = require('path');

const EVENT = process.argv[2] || 'UNKNOWN';
const CAP_DIR = process.argv[3];

if (!CAP_DIR) {
  process.stderr.write('codex-hook-capture.js: missing CAP_DIR argv\n');
  process.exit(1);
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));

// Some hook invocations (none measured yet, but not provably impossible) might
// not pipe stdin at all. Do not hang the whole codex turn on a probe script.
const noStdinTimer = setTimeout(() => finish(null), 5000);
noStdinTimer.unref();

let done = false;
function finish(raw) {
  if (done) return;
  done = true;
  clearTimeout(noStdinTimer);
  try {
    fs.mkdirSync(CAP_DIR, { recursive: true });
    const seq = 1 + fs.readdirSync(CAP_DIR).filter((f) => f.startsWith(EVENT + '-')).length;
    const file = path.join(CAP_DIR, EVENT + '-' + String(seq).padStart(3, '0') + '.json');
    fs.writeFileSync(file, raw === null ? '' : raw);
    fs.appendFileSync(
      path.join(CAP_DIR, 'ALL-EVENTS.log'),
      new Date().toISOString() + ' ' + EVENT + ' seq=' + seq
        + (raw === null ? ' NO-STDIN-TIMEOUT' : ' bytes=' + raw.length) + '\n',
    );
  } catch (e) {
    // Never let a capture-side bug make codex think the hook itself failed --
    // that would pollute the very measurement this script exists to take.
    try { fs.appendFileSync(path.join(CAP_DIR, 'CAPTURE-ERRORS.log'), EVENT + ': ' + e.message + '\n'); } catch (e2) { /* ignore */ }
  }
  // Contract (per issue #78): stdout is injected as context, exit 0 always.
  process.stdout.write('{"continue":true}');
  process.exit(0);
}
