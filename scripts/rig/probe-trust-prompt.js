#!/usr/bin/env node
'use strict';
// #190 — Claude's FOLDER-TRUST prompt, measured off a real PTY.
//
// The bug (#190): opening a session in a folder Claude does not yet trust lands on a
// numbered selector. The chat lens renders nothing for it, so the session looks idle —
// you type a prompt, send it, and the selector eats the keystrokes. #179's verifier
// REPORTS that afterwards; it cannot prevent it. The proposed fix is the shape
// `usageLimitPrompt` / `matchUsageLimitPrompt` already uses: a known sentence, matched
// structurally, answered by writing a digit.
//
// A matcher built on remembered wording is exactly what #143 shipped and paid for. So
// this probe answers, off a real PTY and nothing else:
//
//   1. The verbatim sentence(s) and the verbatim option list, with their glyphs.
//   2. COMPACT or SIDE-BY-SIDE — #19/#143: the layout decides what a digit MEANS.
//   3. What actually answers it — a digit alone, or a digit and a trailing Enter —
//      determined by DRIVING it, never by reading the screen.
//   4. Whether any DEC private mode (alt-screen `?1049h` above all) accompanies it.
//      #179 measured that NO blocking state on claude 2.1.250 emitted alt-screen;
//      this asks whether the trust prompt is the exception.
//   5. Whether `--dangerously-skip-permissions` — what the rig and this repo's own
//      sessions launch with — suppresses the prompt entirely.
//
// VERDICT SOURCES, in order of authority (the screen is never one of them: it cannot
// tell a highlighted row from a committed one, nor a typed line from a submitted one):
//   * `~/.claude.json` -> projects[<dir>].hasTrustDialogAccepted — Claude's own record
//     that the question was answered YES. Ground truth, on disk.
//   * "did a turn start" — a prompt sent afterwards produces turn markers. Proves the
//     session reached its composer, i.e. the selector is gone.
//
// Usage:
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-trust-prompt.js capture     # Q1, Q2, Q4, Q5
//   node scripts/rig/probe-trust-prompt.js drive       # Q3
//   node scripts/rig/probe-trust-prompt.js clean       # remove this probe's trust state
//
// Runs entirely against the rig (port 7999, own worker, own data dir). It cannot touch
// production. Every directory it makes lives under the scratch parent (scripts/scratch-dirs.js).

const fs = require('fs');
const os = require('os');
const path = require('path');

const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { PARENT } = require('../scratch-dirs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every probe directory lives under here, so `clean` can find them all by prefix.
//
// THE DEFAULT CANNOT MEASURE THIS PROMPT, and that is the first thing this probe found.
// Trust is INHERITED by descendants: an ancestor of the scratch parent carries
// `hasTrustDialogAccepted: true` in ~/.claude.json, so every tree scripts/scratch-dirs.js
// creates — the rig's own cwd included — is trusted before it exists and never prompts.
// So the parent is overridable, and a real measurement must point it at a directory with
// no trusted ancestor.
const PROBE_PARENT = process.env.WT_TRUST_PROBE_PARENT || path.join(PARENT, 'wt-trust-probe');
/** Where the ALREADY-TRUSTED `frame` cases run — see trustedDir(). */
const TRUSTED_PARENT = path.join(PARENT, 'wt-trust-probe-trusted');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

// Built from code points, never typed. A literal U+00A0 is invisible in a diff and is
// normalised to an ordinary space in transit; keeping this file ASCII-only means there
// is nothing non-ASCII for anything to normalise. Same rule as lib/agents.js's marker.
const CARET = String.fromCodePoint(0x276f);
const NBSP = String.fromCodePoint(0x00a0);

// A turn STARTED. None of these can be produced by a TUI echoing a typed line.
const STARTED = /esc to interrupt|✻|✽|Crunch|Thinking|tokens/i;
// Claude's composer caret — the marker lib/agents.js declares as `readiness`.
const COMPOSER = /❯/;

// ---------------------------------------------------------------- byte helpers

/** Every DEC private-mode toggle in the stream, in order, as `?<n><h|l>`. */
function decModes(s) {
  const out = [];
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m;
  while ((m = re.exec(s))) out.push(`?${m[1]}${m[2]}`);
  return out;
}

/** ECMA-48 escape strip — same rule as lib/ansi.js (params are `[0-?]`, not `[0-9;?]`). */
const ANSI_RE = /[\x1b\x9b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

/** A printable, copy-pasteable rendering of raw bytes. */
function escapeRaw(s) {
  return s
    .replace(/\x1b/g, '\\e')
    .replace(/\r/g, '\\r')
    .replace(/\x07/g, '\\a')
    .replace(/\n/g, '\\n\n');
}

/**
 * The SCREEN as the user sees it.
 *
 * THE TRAP THIS EXISTS FOR: Claude's trust dialog emits NO SPACES. It positions every
 * single word with CHA (`ESC[<col>G`) — the captured bytes are
 * `\e[2GQuick\e[8Gsafety\e[15Gcheck:\e[22GIs\e[25Gthis…`. A plain `stripAnsi` therefore
 * renders `Quicksafetycheck:Isthis…`, and any matcher that greps the stripped stream for
 * the sentence as a human reads it can never match. So CHA is honoured as padding before
 * the escapes are stripped.
 */
function screen(s) {
  return s
    .split(/\r?\n/)
    .map((line) => {
      let out = '';
      let i = 0;
      const re = /\x1b\[(\d+)G/g;
      let m;
      while ((m = re.exec(line))) {
        out += stripAnsi(line.slice(i, m.index));
        const col = parseInt(m[1], 10) - 1;          // CHA is 1-based
        if (out.length < col) out += ' '.repeat(col - out.length);
        i = m.index + m[0].length;
      }
      out += stripAnsi(line.slice(i));
      return out.replace(/\r/g, '').replace(/\s+$/, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------- trust state

function readTrust(dir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8')); } catch { return { found: false }; }
  const want = dir.replace(/\\/g, '/').toLowerCase();
  for (const [k, v] of Object.entries(j.projects || {})) {
    if (k.replace(/\\/g, '/').toLowerCase() === want) {
      return { found: true, accepted: v.hasTrustDialogAccepted === true };
    }
  }
  return { found: false };
}

/**
 * Remove every `projects` entry under the probe parent.
 *
 * NOTE the hazard: `~/.claude.json` is shared by every live Claude on this machine and
 * each of them rewrites the whole file, so this read-modify-write can lose a concurrent
 * update. A timestamped backup is written first, and the window is one file write wide.
 */
function clean() {
  const raw = fs.readFileSync(CLAUDE_JSON, 'utf8');
  const j = JSON.parse(raw);
  // BOTH parents, named explicitly. The `frame` cases run in an ALREADY-TRUSTED tree
  // (trustedDir), a different root from the untrusted one, and Claude writes a
  // `projects` entry for every directory it opens — trusted or not. The default names
  // happen to share a prefix, so a single-prefix sweep appeared to cover both; it does
  // not once WT_TRUST_PROBE_PARENT is set, which is exactly when the dialog cases run.
  const prefixes = [PROBE_PARENT, TRUSTED_PARENT].map((d) => d.replace(/\\/g, '/').toLowerCase());
  const doomed = Object.keys(j.projects || {})
    .filter((k) => prefixes.some((pfx) => k.replace(/\\/g, '/').toLowerCase().startsWith(pfx)));
  if (!doomed.length) {
    console.log('nothing to clean — no probe entries in ~/.claude.json');
  } else {
    const backup = `${CLAUDE_JSON}.trustprobe-backup-${Date.now()}`;
    fs.writeFileSync(backup, raw);
    for (const k of doomed) { console.log(`  removing projects[${k}]`); delete j.projects[k]; }
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2));
    console.log(`removed ${doomed.length} entr${doomed.length === 1 ? 'y' : 'ies'} (backup: ${backup})`);
  }
  for (const d of [PROBE_PARENT, TRUSTED_PARENT]) {
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); console.log(`removed ${d}`); }
  }
}

// ---------------------------------------------------------------- rig plumbing

/** A directory Claude has provably never seen, with something in it worth trusting. */
function freshDir(tag) {
  const dir = path.join(PROBE_PARENT, `${tag}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# trust probe\n\nGenerated by scripts/rig/probe-trust-prompt.js (#190).\n');
  if (readTrust(dir).found) throw new Error(`${dir} is already known to Claude — pick another`);
  return dir;
}

/**
 * A directory Claude ALREADY trusts, for the cases that must reach a real composer.
 *
 * It lives under the default scratch parent precisely BECAUSE that parent is inside an
 * already-trusted ancestor (finding 7) — the property that makes it useless for
 * measuring the dialog is exactly what makes it right here.
 */
function trustedDir(tag) {
  const dir = path.join(TRUSTED_PARENT, `${tag}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# frame probe\n');
  return dir;
}

async function openSession(cookie, { name, cwd, autoCommand }) {
  const { id } = await api(cookie, 'POST', '/api/sessions', { name, cwd, autoCommand, agent: 'claude' });
  const term = await openTerminal(cookie, id);
  return { id, term };
}

async function waitFor(term, re, ms, from = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(term.text().slice(from))) return Date.now() - t0;
    await sleep(200);
  }
  return null;
}

/**
 * The trust dialog is ON SCREEN.
 *
 * Matched against the COLUMN-AWARE render, not the raw stream: Claude positions every
 * word of this dialog with CHA (`ESC[<col>G`) and emits no spaces at all, so the naive
 * `stripAnsi` of the bytes reads `Yes,Itrustthisfolder`. Any real matcher has the same
 * problem — see the report.
 */
const DIALOG = /Yes, I trust this folder/;
// The REAL composer — its footer, which the trust selector does not have.
const COMPOSER_FOOTER = /auto mode on|bypass permissions on|for agents/;

async function waitForScreen(term, re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(screen(term.text()))) return Date.now() - t0;
    await sleep(250);
  }
  return null;
}

async function kill(cookie, id, term) {
  try { term.close(); } catch {}
  await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
}

// ---------------------------------------------------------------- Q1/Q2/Q4/Q5

const LAUNCHES = [
  { tag: 'plain', cmd: 'claude' },
  { tag: 'skipperms', cmd: 'claude --dangerously-skip-permissions' },
];

async function capture(cookie) {
  for (const l of LAUNCHES) {
    console.log(`\n${'='.repeat(72)}\n== CAPTURE: ${l.tag} — autoCommand ${JSON.stringify(l.cmd)}\n${'='.repeat(72)}`);
    const cwd = freshDir(l.tag);
    console.log(`cwd: ${cwd}`);
    const { id, term } = await openSession(cookie, { name: `trust-${l.tag}`, cwd, autoCommand: l.cmd });
    try {
      // Long enough for a slow boot (measured 5-6s in #147) plus the prompt's own render.
      await sleep(20000);
      const raw = term.text();
      console.log(`\n---- SCREEN (escapes stripped) ----\n${screen(raw)}`);
      console.log(`\n---- DEC private modes, in order ----\n${decModes(raw).join(' ') || '(none)'}`);
      console.log(`  alt-screen (?1049h) present: ${decModes(raw).includes('?1049h')}`);
      console.log(`\n---- trust state on disk ----\n  ${JSON.stringify(readTrust(cwd))}`);
      console.log(`\n---- composer reached without answering: ${COMPOSER.test(raw)}`);
      fs.writeFileSync(path.join(PROBE_PARENT, `raw-${l.tag}.txt`), escapeRaw(raw));
      console.log(`  raw bytes -> ${path.join(PROBE_PARENT, `raw-${l.tag}.txt`)}`);
    } finally {
      await kill(cookie, id, term);
    }
  }
}

// ---------------------------------------------------------------- Q3

// Candidate answer sequences.
//
// The capture already ruled out the shape the issue assumed: the options carry NO
// DIGITS (`❯ No, exit` / `  Yes, I trust this folder`) and the footer reads
// `Enter to confirm · Esc to cancel`. So this is neither #19's compact layout (digits)
// nor its side-by-side one (a preview box) — it is an arrow-driven list, and the
// DEFAULT ROW IS THE DESTRUCTIVE ONE. Hence `enter-only` and `prompt-then-enter`:
// #190's whole premise is that a submit lands here, and a submit ends in CR.
const DOWN = '\x1b[B';
const SEQUENCES = [
  { tag: 'down-enter', keys: [DOWN, '\r'] },
  { tag: 'digit-2', keys: ['2', '\r'] },
  { tag: 'enter-only', keys: ['\r'] },
  { tag: 'prompt-then-enter', keys: ['summarise the README in this folder', '\r'] },
];

// The shell is back — i.e. Claude exited. MINGW64 is Git Bash's own prompt line.
const SHELL = /MINGW64|\$ $/m;

async function drive(cookie) {
  const results = [];
  for (const s of SEQUENCES) {
    console.log(`\n${'='.repeat(72)}\n== DRIVE: ${s.tag} — keys ${JSON.stringify(s.keys)}\n${'='.repeat(72)}`);
    const cwd = freshDir(s.tag);
    console.log(`cwd: ${cwd}`);
    const { id, term } = await openSession(cookie, { name: `trust-${s.tag}`, cwd, autoCommand: 'claude' });
    const r = { tag: s.tag, cwd };
    try {
      // GATE ON THE DIALOG, never on a fixed sleep. The first cut of this waited 15s
      // and one run sent its keys while claude was STILL BOOTING — the arrow and the CR
      // were buffered, applied against a list that then re-rendered, and the session
      // exited. That is #147 reproduced inside the probe, and it made the measurement
      // read as "even the correct sequence exits". A probe that can do that proves
      // nothing.
      const up = await waitForScreen(term, DIALOG, 60000);
      if (up === null) throw new Error('trust dialog never rendered');
      console.log(`  dialog up after ${up}ms`);
      await sleep(1000);
      const beforeKeys = term.text().length;
      for (const k of s.keys) { term.send(k); await sleep(600); }
      await sleep(6000);

      // NOTE `❯` is the trust selector's OWN cursor glyph as well as the composer
      // caret, so this flag alone proves nothing — see the readiness finding in the
      // report. It is recorded to show exactly that collision.
      r.caret = await waitFor(term, COMPOSER, 20000, beforeKeys) !== null;
      // The REAL composer, distinguished from the selector by its footer.
      r.composer = await waitForScreen(term, COMPOSER_FOOTER, 40000) !== null;
      r.shellBack = SHELL.test(screen(term.text().slice(beforeKeys)));
      r.trust = readTrust(cwd);

      // The behavioural verdict: does a prompt sent now actually start a turn?
      const beforeSubmit = term.text().length;
      term.send('reply with exactly the single word OK and nothing else');
      await sleep(300);
      term.send('\r');
      r.turnStarted = await waitFor(term, STARTED, 30000, beforeSubmit) !== null;

      // Re-read: Claude may only persist the answer once it is past the dialog.
      r.trustAfter = readTrust(cwd);
      console.log(`  caret (❯) after keys: ${r.caret}   <- selector cursor AND composer caret`);
      console.log(`  real composer up    : ${r.composer}`);
      console.log(`  shell prompt back   : ${r.shellBack}`);
      console.log(`  trust on disk       : ${JSON.stringify(r.trust)} -> ${JSON.stringify(r.trustAfter)}`);
      console.log(`  a prompt started a turn: ${r.turnStarted}`);
      console.log(`\n---- SCREEN after the keys ----\n${screen(term.text().slice(beforeKeys)).slice(0, 2500)}`);
    } finally {
      await kill(cookie, id, term);
    }
    results.push(r);
  }

  console.log(`\n${'='.repeat(72)}\nVERDICT\n${'='.repeat(72)}`);
  for (const r of results) {
    console.log(`${r.tag.padEnd(18)} caret=${String(r.caret).padEnd(5)} composer=${String(r.composer).padEnd(5)} `
      + `shellBack=${String(r.shellBack).padEnd(5)} trusted=${String((r.trustAfter || {}).accepted).padEnd(9)} turnStarted=${r.turnStarted}`);
  }
  console.log('\nA sequence ANSWERS the prompt only if trusted=true AND turnStarted=true.');
}

// ---------------------------------------------------------------- Q3, stepwise

/**
 * One key at a time, with the screen dumped after each.
 *
 * `drive` reported a contradiction — the arrow visibly moved the cursor onto
 * `Yes, I trust this folder` and Enter STILL exited — and a lumped sequence cannot say
 * which key did what. This resolves it by snapshotting between keystrokes.
 */
async function step(cookie) {
  const keys = process.argv.slice(3);
  if (!keys.length) { console.error('usage: step <key> [key...]   (esc-down = \\e[B, cr = \\r, esc = \\e)'); process.exit(1); }
  const decoded = keys.map((k) => (k === 'down' ? '\x1b[B' : k === 'up' ? '\x1b[A' : k === 'cr' ? '\r' : k === 'esc' ? '\x1b' : k));

  const cwd = freshDir('step');
  console.log(`cwd: ${cwd}`);
  const { id, term } = await openSession(cookie, { name: 'trust-step', cwd, autoCommand: 'claude' });
  try {
    await sleep(15000);
    console.log(`\n---- BEFORE ANY KEY ----\n${screen(term.text()).split('\n').slice(-14).join('\n')}`);
    for (let i = 0; i < decoded.length; i++) {
      const mark = term.text().length;
      term.send(decoded[i]);
      await sleep(parseInt(process.env.WT_TRUST_STEP_GAP || '3000', 10));
      const delta = term.text().slice(mark);
      console.log(`\n---- AFTER KEY ${i + 1}: ${JSON.stringify(keys[i])} ----`);
      console.log(`raw: ${escapeRaw(delta).slice(0, 900)}`);
      console.log(`screen:\n${screen(delta)}`);
      console.log(`trust on disk: ${JSON.stringify(readTrust(cwd))}`);
    }
    // Behavioural verdict, after the whole sequence.
    const beforeSubmit = term.text().length;
    term.send('reply with exactly the single word OK and nothing else');
    await sleep(300);
    term.send('\r');
    const started = await waitFor(term, STARTED, 30000, beforeSubmit) !== null;
    console.log(`\n==== turn started afterwards: ${started}`);
    console.log(`==== trust on disk: ${JSON.stringify(readTrust(cwd))}`);
  } finally {
    await kill(cookie, id, term);
  }
}

// ---------------------------------------------------------------- the composer FRAME

// `lib/agents.js:190` declares `readiness: { composer: /❯/ }`, and the comment above it
// asks for exactly this measurement: the bare caret is not specific enough, because the
// TRUST DIALOG draws `❯` as its own selection cursor (this probe's finding 5). So the
// readiness latch flips while the session sits at a selector that eats prompts.
//
// What a replacement marker must survive, and why each is measured here:
//   * the trust dialog          — the case that motivated it
//   * a bare shell              — `lib/agent-ready.js` refuses to key on a shell prompt
//   * permission MODE           — the footer names the mode, so a marker taken from one
//                                 mode may not exist in another
//   * WIDTH                     — #146: Claude renders for the width it is told, and a
//                                 marker that only appears at 120 cols is a phone-only
//                                 regression
//   * CHA                       — the trust dialog emits no spaces; if the composer
//                                 footer does the same, no MULTI-WORD marker can ever
//                                 match the raw stream
//   * 16 bytes                  — `lib/agent-ready.js` CARRY_BYTES; anything longer can
//                                 be split across two PTY reads and missed forever

const CANDIDATES = [
  ['caret ❯ (today)', /❯/],
  // The composer writes `❯` then a LITERAL SPACE before the input line; the trust
  // dialog writes `❯` then CHA (`\e[4G`) to reach its option label, because that
  // dialog emits no spaces anywhere. 4 bytes, so it fits inside CARRY_BYTES.
  // Written as an ESCAPE, never a literal NBSP: a literal is invisible in a diff and
  // an editor or a lint autofix can normalise it to U+0020, silently killing the rule.
  [CARET + ' + NBSP', new RegExp(CARET + NBSP)],
  ['❯ + CHA', /❯\x1b\[/],
  ['chevrons ⏵⏵', /⏵⏵/],
  ['rule run ───', /─{3}/],
  ['"Try"', /Try/],
  ['"agents"', /agents/],
  ['"cycle"', /cycle/],
  ['"effort"', /effort/],
];

/** Raw bytes around the first occurrence of `re`, escaped for reading. */
function around(raw, re, before = 320, after = 620) {
  const m = re.exec(raw);
  if (!m) return '(never appeared)';
  return escapeRaw(raw.slice(Math.max(0, m.index - before), m.index + after));
}

const FRAME_CASES = [
  { tag: 'composer-120', trusted: true, cmd: 'claude', cols: 120 },
  { tag: 'composer-52', trusted: true, cmd: 'claude', cols: 52 },
  { tag: 'composer-default-120', trusted: true, cmd: 'claude --permission-mode default', cols: 120 },
  { tag: 'composer-plan-120', trusted: true, cmd: 'claude --permission-mode plan', cols: 120 },
  { tag: 'trust-120', trusted: false, cmd: 'claude', cols: 120 },
  { tag: 'trust-52', trusted: false, cmd: 'claude', cols: 52 },
  { tag: 'shell-120', trusted: true, cmd: null, cols: 120 },
];

async function frame(cookie) {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const rows = [];
  for (const c of FRAME_CASES) {
    if (only && c.tag !== only) continue;
    console.log(`\n${'='.repeat(72)}\n== ${c.tag} — ${JSON.stringify(c.cmd)} @ ${c.cols} cols\n${'='.repeat(72)}`);
    // A TRUSTED cwd is one under an ancestor Claude already trusts — the scratch parent
    // qualifies (finding 7), which is precisely why it cannot serve the untrusted cases.
    const cwd = c.trusted ? trustedDir(c.tag) : freshDir(c.tag);
    const { id } = await api(cookie, 'POST', '/api/sessions',
      { name: c.tag, cwd, autoCommand: c.cmd || undefined, agent: c.cmd ? 'claude' : undefined });
    const term = await openTerminal(cookie, id);
    try {
      // Width FIRST, so the frame is drawn at it rather than reflowed into it.
      term.ws.send(JSON.stringify({ resize: { cols: c.cols, rows: 30 } }));
      await sleep(500);
      const want = c.cmd ? (c.trusted ? COMPOSER_FOOTER : DIALOG) : /\$/;
      const up = await waitForScreen(term, want, 60000);
      console.log(`  ${c.cmd ? (c.trusted ? 'composer' : 'dialog') : 'shell'} up after ${up}ms`);
      await sleep(2500);
      const raw = term.text();

      console.log(`\n---- RAW around the first ❯ ----\n${around(raw, /❯/)}`);
      console.log(`\n---- SCREEN (last 12 lines) ----\n${screen(raw).split('\n').slice(-12).join('\n')}`);
      const row = { tag: c.tag };
      for (const [name, re] of CANDIDATES) row[name] = re.test(raw);
      rows.push(row);
      // What FOLLOWS the caret, per occurrence — the discriminator lives here.
      console.log(`\n---- code points after each ❯ ----`);
      const re = /❯/g;
      let m; let n = 0;
      while ((m = re.exec(raw)) && n < 8) {
        const tail = [...raw.slice(m.index + 1, m.index + 7)]
          .map((ch) => (ch === '\x1b' ? 'ESC' : ch === ' ' ? 'SP' : ch === '\r' ? 'CR' : ch === '\n' ? 'LF' : `${ch}(U+${ch.codePointAt(0).toString(16)})`));
        console.log(`  #${++n} @${m.index}: ${tail.join(' ')}`);
      }
      console.log(`\n---- candidate tokens present in the RAW stream ----`);
      for (const [name, re] of CANDIDATES) console.log(`  ${re.test(raw) ? 'YES' : ' no'}  ${name}`);
    } finally {
      await kill(cookie, id, term);
    }
  }

  console.log(`\n${'='.repeat(72)}\nCANDIDATE MATRIX (raw stream)\n${'='.repeat(72)}`);
  const names = CANDIDATES.map(([n]) => n);
  console.log(`${'case'.padEnd(22)}${names.map((n) => n.padEnd(18)).join('')}`);
  for (const r of rows) console.log(`${r.tag.padEnd(22)}${names.map((n) => (r[n] ? 'YES' : 'no').padEnd(18)).join('')}`);
  console.log('\nA usable marker is YES on every composer-* row and no on trust-* and shell-*.');
}

// ---------------------------------------------------------------- the RESTORED composer

// Does `claude --resume <id>` print the same composer marker as a cold `claude`?
//
// THE STAKES, and why this is measured rather than assumed: `pty-worker.js:1755` records
// that the first cut of #147 seeded the readiness latch from restored scrollback on the
// belief that a restored agent would not reprint its marker — wrong, and wrong in the
// damaging direction. The mirror-image mistake is available here: if a resumed composer
// does NOT print the marker, the latch never flips, the 45s `WT_READY_FALLBACK_MS`
// ceiling fires instead, and EVERY restored session gets a 45-second submit block after
// every cold restart — including the restart that deploys the change.
//
// `lib/restore-command.js` builds the real command: the original autoCommand with any
// existing --continue/--resume stripped, plus ` --resume <claudeSessionId>`. So the
// string driven here is byte-identical to what the worker types at a restored prompt.

/** The newest Claude conversation id written for `cwd`, or null. */
function conversationIdFor(cwd, sinceMs) {
  // Claude encodes the cwd into a directory name under ~/.claude/projects.
  const root = path.join(os.homedir(), '.claude', 'projects');
  let best = null;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    // Match on the cwd's own leaf, which is unique per probe run.
    if (!d.name.includes(path.basename(cwd))) continue;
    for (const f of fs.readdirSync(path.join(root, d.name))) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(root, d.name, f);
      const st = fs.statSync(p);
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { id: f.replace(/\.jsonl$/, ''), mtimeMs: st.mtimeMs };
    }
  }
  return best ? best.id : null;
}

async function resume(cookie) {
  // --- 1. a real conversation to resume, made the way a user makes one.
  const cwd = trustedDir('resume-src');
  console.log(`source cwd: ${cwd}`);
  const t0 = Date.now();
  const src = await api(cookie, 'POST', '/api/sessions', { name: 'resume-src', cwd, autoCommand: 'claude', agent: 'claude' });
  const srcTerm = await openTerminal(cookie, src.id);
  await waitForScreen(srcTerm, COMPOSER_FOOTER, 60000);
  srcTerm.send('reply with exactly the single word OK and nothing else');
  await sleep(300);
  srcTerm.send('\r');
  const started = await waitFor(srcTerm, STARTED, 60000) !== null;
  console.log(`  source turn started: ${started}`);
  await sleep(6000);
  await kill(cookie, src.id, srcTerm);

  const convId = conversationIdFor(cwd, t0);
  console.log(`  conversation id: ${convId ? `${convId.slice(0, 8)}… (${convId.length} chars)` : 'NOT FOUND'}`);
  if (!convId) throw new Error('no conversation written — cannot measure a resume');

  // --- 2. resume it, at both widths, plus the failed-resume hole.
  const BOGUS = '00000000-0000-4000-8000-000000000000';
  const cases = [
    { tag: 'resume-120', id: convId, cols: 120 },
    { tag: 'resume-52', id: convId, cols: 52 },
    { tag: 'resume-bogus-120', id: BOGUS, cols: 120 },
  ];
  const rows = [];
  for (const c of cases) {
    console.log(`\n${'='.repeat(72)}\n== ${c.tag} — claude --resume ${c.id === BOGUS ? '<NONEXISTENT>' : '<id>'} @ ${c.cols} cols\n${'='.repeat(72)}`);
    const { id } = await api(cookie, 'POST', '/api/sessions',
      { name: c.tag, cwd, autoCommand: `claude --resume ${c.id}`, agent: 'claude' });
    const term = await openTerminal(cookie, id);
    const started2 = Date.now();
    try {
      term.ws.send(JSON.stringify({ resize: { cols: c.cols, rows: 30 } }));
      // Scan only AFTER the launch command is echoed — the same arming rule
      // pty-worker.js uses, so a marker left in earlier bytes cannot count.
      let armedAt = null;
      let markerAt = null;
      const deadline = Date.now() + 75000;
      while (Date.now() < deadline) {
        const raw = term.text();
        const i = raw.lastIndexOf('--resume');
        if (i >= 0) {
          if (armedAt === null) armedAt = Date.now() - started2;
          if (new RegExp(CARET + NBSP).test(raw.slice(i))) { markerAt = Date.now() - started2; break; }
        }
        await sleep(200);
      }
      await sleep(2000);
      const raw = term.text();
      const after = raw.slice(Math.max(0, raw.lastIndexOf('--resume')));
      const row = {
        tag: c.tag,
        marker: markerAt !== null,
        markerAt,
        armedAt,
        caret: /❯/.test(after),
        chevrons: /⏵⏵/.test(after),
        shell: /command not found|No conversation|not found|error/i.test(stripAnsi(after)),
      };
      rows.push(row);
      console.log(`  launch echoed at ${armedAt}ms · ❯+NBSP at ${markerAt === null ? 'NEVER' : `${markerAt}ms`}`);
      console.log(`\n---- code points after each ❯ (post-launch only) ----`);
      const re = /❯/g; let m; let n = 0;
      while ((m = re.exec(after)) && n < 5) {
        const tail = [...after.slice(m.index + 1, m.index + 7)]
          .map((ch) => (ch === '\x1b' ? 'ESC' : ch === NBSP ? 'NBSP' : ch === ' ' ? 'SP' : ch === '\r' ? 'CR' : ch === '\n' ? 'LF' : `${ch}(U+${ch.codePointAt(0).toString(16)})`));
        console.log(`  #${++n}: ${tail.join(' ')}`);
      }
      console.log(`\n---- SCREEN (last 14 lines) ----\n${screen(raw).split('\n').slice(-14).join('\n')}`);
    } finally {
      await kill(cookie, id, term);
    }
  }

  console.log(`\n${'='.repeat(72)}\nRESUME VERDICT\n${'='.repeat(72)}`);
  for (const r of rows) {
    console.log(`${r.tag.padEnd(18)} ❯+NBSP=${String(r.marker).padEnd(6)} at=${String(r.markerAt === null ? 'never' : `${r.markerAt}ms`).padEnd(8)} caret=${r.caret} chevrons=${r.chevrons}`);
  }
}

// ---------------------------------------------------------------- main

(async () => {
  const verb = process.argv[2] || 'capture';
  if (verb === 'clean') { clean(); return; }
  fs.mkdirSync(PROBE_PARENT, { recursive: true });
  const cookie = await login();
  if (verb === 'capture') await capture(cookie);
  else if (verb === 'drive') await drive(cookie);
  else if (verb === 'step') await step(cookie);
  else if (verb === 'frame') await frame(cookie);
  else if (verb === 'resume') await resume(cookie);
  else { console.error(`unknown verb '${verb}' — capture | drive | step | frame | resume | clean`); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
