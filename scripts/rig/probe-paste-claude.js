#!/usr/bin/env node
'use strict';
// Does a long MULTI-LINE paste reach CLAUDE whole? (reported 2026-08-30)
//
// `probe-paste-truncation.js` already cleared our own stack: 32 KB survives the
// wire, the worker and the PTY intact as ONE bracketed paste. So if a pasted
// prompt still arrives cut, the loss is in what the TUI does with those bytes —
// and the suspect is a specific one.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMPOSER = /❯/;
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
  const out = [];
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

function rigProjectDir() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    const d = fs.readdirSync(root).filter((x) => /wt-rig$/i.test(x));
    return d.length ? path.join(root, d[0]) : null;
  } catch { return null; }
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
  const term = await openTerminal(cookie, id);

  const t0 = Date.now();
  while (Date.now() - t0 < 45000 && !COMPOSER.test(term.text())) await sleep(250);
  if (!COMPOSER.test(term.text())) { console.log('composer never appeared — aborting'); term.close(); return; }

  const dir = rigProjectDir();
  const before = new Set(dir ? jsonlFiles(dir) : []);

  const text = multilineText();
  const frame = buildComposeSubmission(text);
  console.log(`pasting ${LINES} labelled lines, ${text.length} chars`);
  console.log(`frame: ${frame.length} bytes, bracketed=${frame.startsWith(ESC + '[200~')}, embedded CRs=${(frame.match(/\r/g) || []).length}`);

  term.send(frame);
  await sleep(20000);   // let the turn start and the transcript flush

  // Find the newest transcript and read back what Claude actually recorded.
  const files = dir ? jsonlFiles(dir) : [];
  const fresh = files.filter((f) => !before.has(f));
  const candidates = (fresh.length ? fresh : files)
    .map((f) => ({ f, m: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.m - a.m);

  let found = null;
  for (const { f } of candidates.slice(0, 4)) {
    for (const t of userTurnTexts(f)) {
      if (t.includes('L00 ')) { found = { file: path.basename(f), text: t }; break; }
    }
    if (found) break;
  }

  console.log('');
  if (!found) {
    console.log('NO user turn containing L00 was recorded.');
    console.log('=> the paste started no turn at all (a different failure from a cut).');
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

  term.close();
  try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch { /* best effort */ }
})().catch((e) => { console.error(e); process.exit(2); });
