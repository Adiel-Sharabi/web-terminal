#!/usr/bin/env node
'use strict';
// Point this machine's Codex TUI at the in-band status channel web-terminal reads.
//
// Sibling of install-statusline.js and fix-hooks.js: the repo owns the machine-local
// agent config that implements its contracts, because a per-machine copy of a wire
// format drifts. Here the contract is "a Codex session reports its status as OSC 9 in
// its own PTY output" — see lib/osc9-notify.js for why hooks cannot do this job and
// what was measured off a real 0.144.0 PTY.
//
//   node scripts/install-codex-notify.js           # patch
//   node scripts/install-codex-notify.js --check    # report only, change nothing
//
// Writes exactly three keys:
//   [tui]
//   notifications = true
//   notification_method = "osc9"
//   notification_condition = "always"
//
// `notification_condition` is the one people get wrong: it defaults to "unfocused",
// and a PTY has no focus state, so without "always" NOTHING is ever emitted and the
// feature looks broken rather than unconfigured.
//
// Anything else in config.toml is left alone. A COLD restart is required afterwards
// for running sessions — the worker owns this path, so a server-only reload leaves the
// old behaviour in place.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK = process.argv.includes('--check');
const CONFIG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');

const WANT = [
  ['notifications', 'true'],
  ['notification_method', '"osc9"'],
  ['notification_condition', '"always"'],
];

// A bare `[tui]` header — NOT `[tui.something]`, which is a different table and must
// not be written into (its keys belong to the subtable, so `notifications` there would
// be silently ignored, the same class of trap as Codex's camelCase hook keys).
const BARE_TUI = /^\s*\[tui\]\s*$/;
const NEXT_SECTION = /^\s*\[/;

function keyRe(k) { return new RegExp(`^\\s*${k}\\s*=`); }

function patch(src) {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => BARE_TUI.test(l));

  if (start === -1) {
    // TOML 1.0 explicitly permits defining a super-table after its sub-tables, so
    // appending [tui] is valid even though [tui.model_availability_nux] already exists.
    const block = ['', '# web-terminal: in-band session status (scripts/install-codex-notify.js)',
      '[tui]', ...WANT.map(([k, v]) => `${k} = ${v}`), ''];
    const trimmed = src.replace(/\s*$/, '');
    return { text: (trimmed ? trimmed + '\n' : '') + block.join('\n'), added: WANT.map(([k]) => k), changed: [] };
  }

  // Section exists: find its extent, then set each key in place or append to it.
  let end = start + 1;
  while (end < lines.length && !NEXT_SECTION.test(lines[end])) end++;

  const added = [], changed = [];
  for (const [k, v] of WANT) {
    const at = lines.slice(start + 1, end).findIndex((l) => keyRe(k).test(l));
    if (at === -1) {
      lines.splice(end, 0, `${k} = ${v}`);
      end++;
      added.push(k);
    } else {
      const i = start + 1 + at;
      if (lines[i].trim() !== `${k} = ${v}`) { lines[i] = `${k} = ${v}`; changed.push(k); }
    }
  }
  return { text: lines.join('\n'), added, changed };
}

function main() {
  if (!fs.existsSync(CONFIG)) {
    console.error(`No Codex config at ${CONFIG} — is codex installed for this user?`);
    process.exit(1);
  }
  const src = fs.readFileSync(CONFIG, 'utf8');
  const { text, added, changed } = patch(src);

  if (text === src) {
    console.log(`config.toml already correct (${CONFIG})`);
    return;
  }
  const summary = [added.length ? `add ${added.join(', ')}` : '', changed.length ? `update ${changed.join(', ')}` : '']
    .filter(Boolean).join('; ');

  if (CHECK) {
    console.log(`WOULD ${summary}`);
    console.log('--- resulting [tui] block ---');
    console.log(text.split(/\r?\n/).filter((l, i, a) => {
      const s = a.findIndex((x) => BARE_TUI.test(x));
      return s !== -1 && i >= s && i < s + 5;
    }).join('\n'));
    return;
  }

  // Back up before touching a file this repo does not own.
  const backup = `${CONFIG}.bak-wt-${Date.now()}`;
  fs.copyFileSync(CONFIG, backup);
  fs.writeFileSync(CONFIG, text, 'utf8');
  console.log(`patched ${CONFIG} (${summary})`);
  console.log(`backup: ${backup}`);
  console.log('NOTE: running Codex sessions need a restart to pick this up.');
}

if (require.main === module) main();
module.exports = { patch };
