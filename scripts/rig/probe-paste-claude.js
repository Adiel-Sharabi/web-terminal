#!/usr/bin/env node
'use strict';
// Does a long MULTI-LINE paste reach CLAUDE whole? (reported 2026-08-30)
//
// `probe-paste-truncation.js` clears our own stack BELOW the server's 65536-byte WS
// input cap: the wire, the worker and the PTY carry one bracketed paste intact. Above
// that cap server.js drops the frame outright, which is a real cut and is OURS — so
// "the transport is clean" is only ever a statement about sizes under it. For a paste
// that does reach the PTY whole and still arrives cut, the loss is in what the TUI does
// with those bytes, and the suspect is a specific one.
//
// THE SUSPECT. `buildComposeSubmission` wraps any multi-line buffer in bracketed
// paste and rewrites EVERY newline to a CARRIAGE RETURN:
//
//     ESC[200~ line1 \r line2 \r line3 ESC[201~ \r
//
// That rewrite exists because #55 established CR, never LF, is what an agent TUI
// reads as Enter. But inside a paste the same byte is ambiguous: if the TUI treats
// an embedded CR as "submit", the prompt ends at the FIRST newline and everything
// after it is lost — which is exactly the shape of the report ("not everything is
// going to the terminal"), and exactly what pasting straight into the terminal
// would avoid, since that path never rewrites anything.
//
// THE TRANSCRIPT IS GROUND TRUTH, NEVER THE SCREEN. Claude renders a long paste as
// a "[Pasted text #1 +N lines]" placeholder, so the screen shows a summary whatever
// happened and cannot distinguish "held whole" from "cut". The recorded user turn
// can. Every line is labelled with its own index, so a cut names its own position.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-paste-claude.js
//
// Nothing here touches production.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');
const { claudeProjectDirName } = require('../../lib/transcript');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMPOSER = /❯/;
// server.js drops any WS input frame longer than this and tells the client nothing.
const WS_INPUT_CAP = 65536;
const ESC = '\x1b';

const LINES = parseInt(process.argv[2], 10) || 40;   // sweepable: node probe-paste-claude.js <lines>
const ASCII_FILL = 'the quick brown fox jumps over the lazy dog 0123456789';
// #166's lesson: non-ASCII has broken this app's input path before. UTF-8 is
// multi-byte, so a layer that counts BYTES where it means CHARACTERS (or slices a
// buffer mid-sequence) cuts HERE and nowhere else. ASCII-only probes cannot see it.
const UTF8_FILL = 'שלום עולם בדיקה ארוכה 12345 café naïve 😀 🚀 end';
const NONASCII = process.env.PROBE_NONASCII === '1';
const LINE_FILL = NONASCII ? UTF8_FILL : ASCII_FILL;

/** 40 labelled lines. A cut names its own position: L00 present, L07 missing, ... */
function multilineText() {
  // An instruction FIRST, so a permission-skipped agent is not handed 40 lines of
  // unframed filler and left to decide what to do with it. It sits before L00, so every
  // label index the verdict reports is unchanged.
  const out = ['Reply with OK only. Run no tools. The rest of this message is test filler.'];
  for (let i = 0; i < LINES; i++) {
    out.push('L' + String(i).padStart(2, '0') + ' ' + LINE_FILL);
  }
  return out.join('\n');
}

/**
 * The EXACT bytes the compose bar produces for a multi-line buffer — copied in
 * shape from buildComposeSubmission so the probe tests the real rule, not a
 * convenient approximation of it.
 */
function buildComposeSubmission(val) {
  val = val.replace(/[\r\n]+$/, '');
  if (val.includes('\n')) {
    const safe = val.replace(/\x1b\[2(?:00|01)~/g, '').replace(/\r?\n/g, '\r');
    return ESC + '[200~' + safe + ESC + '[201~\r';
  }
  return val + '\r';
}

// The project dir is DERIVED with the one encoder, never guessed. An earlier cut
// scanned ~/.claude/projects for /wt-rig$/i and took readdir order's first hit — which
// picks a stale directory the moment WT_SCRATCH_DIR/WT_RIG_DIR has ever been overridden
// (scratch-dirs.js supports exactly that), and returns null before the dir exists,
// routing a healthy run straight into the "no turn" branch.
function rigProjectDir() {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(DIRS.rig));
}

function jsonlFiles(dir) {
  try { return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); }
  catch { return []; }
}

/** Every `role:user` turn's text in a transcript, newest last. */
function userTurnTexts(file) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const msg = o.message || o;
    if (!msg || msg.role !== 'user') continue;
    const c = msg.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) if (part && part.type === 'text' && typeof part.text === 'string') out.push(part.text);
    }
  }
  return out;
}

(async () => {
  const cookie = await login();
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'paste-claude', cwd: DIRS.rig,
    autoCommand: 'claude --dangerously-skip-permissions', agent: 'claude',
  });
  let term = null;
  // try/finally: the abort paths used to `return` past the DELETE, leaving a live
  // `claude --dangerously-skip-permissions` running in the rig worker indefinitely —
  // burning the real account and walking into the 10-session cap over repeated runs.
  try {
  term = await openTerminal(cookie, id);

  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && !COMPOSER.test(term.text())) await sleep(250);
  if (!COMPOSER.test(term.text())) {
    console.log('composer never appeared — aborting');
    process.exitCode = 1;
    return;
  }

  const dir = rigProjectDir();

  const text = multilineText();
  const frame = buildComposeSubmission(text);
  // BYTES, not UTF-16 code units. `frame.length` undercounts exactly in PROBE_NONASCII
  // mode — the mode that exists to hunt a byte/char confusion — where Hebrew is 2 bytes
  // per char and the emoji 4 bytes across 2 units.
  const frameBytes = Buffer.byteLength(frame, 'utf8');
  console.log(`pasting ${LINES} labelled lines, ${text.length} chars`);
  console.log(`frame: ${frameBytes} bytes (${frame.length} UTF-16 units), bracketed=${frame.startsWith(ESC + '[200~')}, embedded CRs=${(frame.match(/\r/g) || []).length}`);
  // LINES is a CLI argument, so the frame can be driven over the server's WS input cap.
  // Past it server.js DROPS the frame and tells the client nothing, and this probe would
  // report "the paste started no turn at all" — a wrong diagnosis of a known drop.
  if (frameBytes > WS_INPUT_CAP) {
    console.log(`\nABORT: frame is ${frameBytes} bytes, over server.js's ${WS_INPUT_CAP}-byte WS input cap.`);
    console.log('It would be DROPPED before reaching the PTY. Use probe-paste-truncation.js for that boundary.');
    process.exitCode = 1;
    return;
  }

  const tSend = Date.now();
  term.send(frame);
  await sleep(20000);   // let the turn start and the transcript flush

  // ONLY a transcript written AFTER the send can be this run's answer.
  //
  // An earlier cut snapshotted `before` after the composer appeared — by which time
  // Claude may already have created its .jsonl — so `fresh` came back empty and it fell
  // back to EVERY .jsonl in the dir, newest 4, with no lower bound on mtime. The match
  // key `L00 ` is written by every previous run of this probe. So a run whose paste
  // started no turn at all would walk to candidate #2, find a PREVIOUS run's 40 tags,
  // and print "ALL LINES PRESENT" — a failed run reported as a clean one, which is the
  // single worst thing a measurement tool can do.
  const files = dir ? jsonlFiles(dir) : [];
  const candidates = files
    .map((f) => ({ f, m: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
    .filter(({ m }) => m >= tSend)
    .sort((a, b) => b.m - a.m);

  let found = null;
  let staleOnly = false;
  if (!candidates.length) {
    staleOnly = files.length > 0;
  }
  for (const { f } of candidates.slice(0, 4)) {
    for (const t of userTurnTexts(f)) {
      if (t.includes('L00 ')) { found = { file: path.basename(f), text: t }; break; }
    }
    if (found) break;
  }

  console.log('');
  if (!found) {
    process.exitCode = 1;
    console.log('NO user turn containing L00 was recorded.');
    console.log('=> the paste started no turn at all (a different failure from a cut).');
    if (staleOnly) {
      console.log(`   (${files.length} older transcript(s) exist but none was written after the send;`);
      console.log('    they are PREVIOUS runs and are deliberately not read.)');
    }
  } else {
    const present = [];
    const missing = [];
    for (let i = 0; i < LINES; i++) {
      const tag = 'L' + String(i).padStart(2, '0') + ' ';
      (found.text.includes(tag) ? present : missing).push(i);
    }
    console.log(`recorded in : ${found.file}`);
    console.log(`turn length : ${found.text.length} chars  (sent ${text.length})`);
    console.log(`lines present: ${present.length}/${LINES}`);
    if (missing.length) {
      process.exitCode = 1;
      console.log(`MISSING lines: ${missing.join(',')}`);
      console.log(`first missing: L${String(missing[0]).padStart(2, '0')}`);
      console.log('\n=> CUT REPRODUCED. The position names the mechanism:');
      console.log('   missing from L01 on  -> an embedded CR ended the prompt at the first newline');
      console.log('   a later, stable cut  -> a fixed buffer in the TUI');
    } else {
      console.log('\n=> ALL LINES PRESENT. A multi-line paste of this size reaches Claude whole;');
      console.log('   the reported cut needs a bigger payload or a different shape.');
    }
  }

  } finally {
    if (term) { try { term.close(); } catch { /* best effort */ } }
    try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch { /* best effort */ }
  }
})().catch((e) => { console.error(e); process.exit(2); });
