#!/usr/bin/env node

// Does a long SINGLE-LINE prompt reach CLAUDE whole? (reported 2026-09-02)
//
// #213. The report: a ~1500-character prompt entered in the companion's chat compose bar
// looked COMPLETE in the box, and after Send only its LAST part was in the terminal.
// The beginning was simply gone — the same prefix-drop shape as #89 (1582 sent, the
// last 666 received, from offset 916).
//
// WHY THE THREE EXISTING PROBES DO NOT COVER IT, which is the whole reason for a
// fourth. `buildComposeSubmission` (session_screen.dart) picks its byte shape on ONE
// predicate: does the buffer contain a newline.
//
//     val.contains('\n')  ->  ESC[200~ <body, every \n rewritten to \r> ESC[201~ \r
//     otherwise           ->  <body> \r                     <- UNBRACKETED, raw
//
// The prompts in this report are DICTATED, and dictation emits no line breaks at all,
// so they take the second branch — 1500 raw characters delivered to the TUI in one
// read, as though they had been typed. What has actually been measured is:
//
//   verify-long-prompt.js      unbracketed 1582 chars -> a plain SHELL     intact
//   probe-paste-truncation.js  bracketed              -> a plain SHELL     intact to 32 KB
//   probe-paste-claude.js      bracketed              -> a real CLAUDE     intact to 41,899
//   THIS PROBE                 unbracketed            -> a real CLAUDE     <- never measured
//
// The first row already carries this exact shape at this exact size through the whole
// HTTP -> WS -> server -> worker -> PTY path intact, so the transport is exonerated by
// measurement, not by argument. What is unmeasured is what the TUI does with the bytes
// once they arrive: a burst that large, with no ESC[200~ to declare itself, is left to
// the TUI's own paste inference, and a detector that latches part-way through the burst
// keeps what follows the latch and loses what preceded it. Head gone, tail kept.
//
// THE TRANSCRIPT IS GROUND TRUTH, NEVER THE SCREEN. Claude's composer scrolls, so a
// prompt 13 wrapped rows tall shows its tail whether or not the head arrived — "I saw
// only the last part" is exactly what a healthy long prompt looks like too. Only the
// recorded user turn separates them, which is why the verdict below is computed from
// the .jsonl and the screen is used for nothing but readiness.
//
// The text is INSTRUMENTED: a marker every 50 characters carrying its own offset
// (M0000, M0050, ...), so a cut names its own position instead of leaving prose to be
// eyeballed. The run's instruction to Claude sits at the very END, where the reported
// failure leaves it intact — an instruction in the head would be the first thing lost.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-paste-single-line.js              # sweep 200 500 1000 1500 2500
//   node scripts/rig/probe-paste-single-line.js 1500         # one length
//   PROBE_BRACKETED=1 node scripts/rig/probe-paste-single-line.js 1500
//         ^ the same text sent the way a MULTI-LINE buffer is sent today. This is the
//           candidate fix's byte shape, so a clean sweep here is what earns it.
//
// Nothing here touches production.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');
const { claudeProjectDirName } = require('../../lib/transcript');
const { readinessMarker } = require('../../lib/agents');
const { stripAnsi } = require('../../lib/ansi');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = '\x1b';

// The composer marker is READ FROM THE REGISTRY, never retyped. #190: the bare caret
// this used to be is also the folder-trust dialog's selection cursor, so a probe keying
// on it can believe a session parked at a SELECTOR is ready to take a prompt.
// It is a RegExp, not a string -- .test(), never .includes(). The ASCII-escaped
// fallback is deliberate: a literal U+00A0 is invisible in a diff and normalises away.
const COMPOSER = readinessMarker('claude') || new RegExp('\u276f\u00a0');

// server.js refuses a WS input frame longer than this (WS_INPUT_MAX, 256 KB since #201)
// and, for app.html, tells the client only in its own log. Far above anything this probe
// sends, but the guard keeps a swept length from silently changing what is being measured.
const WS_INPUT_CAP = 256 * 1024;

const DEFAULT_SWEEP = [200, 500, 1000, 1500, 2500];
const BRACKETED = process.env.PROBE_BRACKETED === '1';

const BLOCK = 50;
// Sits at the TAIL on purpose: the reported failure eats the head, and an instruction
// that goes with it leaves a permission-skipped agent holding unframed filler.
const TAIL_INSTRUCTION =
  ' <<END>> Reply with OK only. Run no tools. Everything above is test filler.';

/**
 * One line, no newlines, `chars` long before the trailing instruction — a marker every
 * BLOCK characters carrying its own offset, so a cut names the offset it happened at.
 */
function singleLineText(chars, nonce) {
  const fill = 'the quick brown fox jumps over the lazy dog 0123456789 ';
  let out = '';
  for (let off = 0; out.length < chars; off += BLOCK) {
    const tag = 'M' + String(off).padStart(4, '0') + ' ';
    out += (tag + fill).slice(0, BLOCK);
  }
  return out.slice(0, chars) + ' RUN' + nonce + TAIL_INSTRUCTION;
}

/**
 * The EXACT bytes the compose bar produces — copied in SHAPE from
 * buildComposeSubmission so the probe tests the real rule rather than a convenient
 * approximation of it. `bracketed` forces the branch a multi-line buffer takes today,
 * which is the candidate fix.
 */
function buildComposeSubmission(val, bracketed) {
  val = val.replace(/[\r\n]+$/, '');
  if (bracketed || val.includes('\n')) {
    const safe = val.replace(/\x1b\[2(?:00|01)~/g, '').replace(/\r?\n/g, '\r');
    return ESC + '[200~' + safe + ESC + '[201~\r';
  }
  return val + '\r';
}

// DERIVED with the one encoder, never guessed — see probe-paste-claude.js for the stale
// -directory bug that scanning for /wt-rig$/i produced.
function rigProjectDir() {
  return path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(DIRS.rig));
}

function jsonlFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch { return []; }
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
      for (const part of c) {
        if (part && part.type === 'text' && typeof part.text === 'string') out.push(part.text);
      }
    }
  }
  return out;
}

/**
 * How much of the HEAD is missing: the smallest k for which the received turn still
 * contains `sent` from offset k on. 0 means whole; -1 means the loss is not a clean
 * prefix drop and the marker list below has to describe it instead.
 */
function headCutOffset(sent, received) {
  for (let k = 0; k <= sent.length; k++) {
    if (received.includes(sent.slice(k))) return k;
  }
  return -1;
}

function markersPresent(received, chars) {
  const present = [];
  for (let off = 0; off < chars; off += BLOCK) {
    if (received.includes('M' + String(off).padStart(4, '0') + ' ')) present.push(off);
  }
  return present;
}

/** Runs ONE length in its own session. Returns a row for the summary table. */
async function runCase(cookie, chars) {
  const nonce = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1000);
  const text = singleLineText(chars, nonce);
  const frame = buildComposeSubmission(text, BRACKETED);
  const frameBytes = Buffer.byteLength(frame, 'utf8');

  console.log(`\n--- ${chars} chars ---`);
  console.log(`sent   : ${text.length} chars, newlines=${(text.match(/\n/g) || []).length}, ` +
    `bracketed=${frame.startsWith(ESC + '[200~')}, frame=${frameBytes} bytes`);

  if (frameBytes > WS_INPUT_CAP) {
    console.log(`ABORT: frame is over server.js's ${WS_INPUT_CAP}-byte WS input cap and would be refused.`);
    return { chars, verdict: 'SKIPPED (over the wire cap)', failed: true };
  }

  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: `single-line-${chars}`, cwd: DIRS.rig,
    autoCommand: 'claude --dangerously-skip-permissions', agent: 'claude',
  });

  let term = null;
  try {
    term = await openTerminal(cookie, id);

    const t0 = Date.now();
    while (Date.now() - t0 < 45000 && !COMPOSER.test(term.text())) await sleep(250);
    if (!COMPOSER.test(term.text())) {
      console.log('composer never appeared — this case proves nothing.');
      return { chars, verdict: 'ABORTED (no composer)', failed: true };
    }

    const tSend = Date.now();
    term.send(frame);
    await sleep(20000); // let the turn start and the transcript flush

    // ONLY a transcript written AFTER the send can be this run's answer, and the match
    // key is this run's own nonce — a previous run's markers are identical.
    const dir = rigProjectDir();
    const files = jsonlFiles(dir);
    const candidates = files
      .map((f) => ({ f, m: (() => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } })() }))
      .filter(({ m }) => m >= tSend)
      .sort((a, b) => b.m - a.m);

    let found = null;
    for (const { f } of candidates.slice(0, 4)) {
      for (const t of userTurnTexts(f)) {
        if (t.includes('RUN' + nonce)) { found = { file: path.basename(f), text: t }; break; }
      }
      if (found) break;
    }

    if (!found) {
      // NO TURN and A CUT are different bugs, and the transcript can only see the
      // second. What separates them is whether the BODY reached the composer, which
      // only the screen knows — so this is the one branch that reads it. Markers are
      // counted on the ANSI-STRIPPED screen: Claude redraws a wrapped line, so a
      // contiguous compare fails while every marker is present (the false alarm
      // verify-long-prompt.js paid for first).
      const screen = stripAnsi(term.text());
      const onScreen = markersPresent(screen, chars);
      const total = Math.ceil(chars / BLOCK);
      console.log('NO user turn carrying this run\'s nonce was recorded.');
      console.log('screen : ' + onScreen.length + '/' + total + ' markers visible' +
        (onScreen.length
          ? ', first M' + String(onScreen[0]).padStart(4, '0') +
            ', last M' + String(onScreen[onScreen.length - 1]).padStart(4, '0')
          : ''));
      if (onScreen.length) {
        console.log('=> the body REACHED the composer and was never SUBMITTED: the submit CR was');
        console.log("   absorbed into the burst. That is #55's failure, at a length nobody swept.");
        return { chars, verdict: 'NOT SUBMITTED (' + onScreen.length + '/' + total + ' on screen)', failed: true };
      }
      console.log('=> nothing of the body is on screen either: it never reached the PTY.');
      return { chars, verdict: 'NO TURN, nothing on screen', failed: true };
    }

    const cut = headCutOffset(text, found.text);
    const present = markersPresent(found.text, chars);
    console.log(`turn   : ${found.text.length} chars in ${found.file}`);
    console.log(`markers: ${present.length}/${Math.ceil(chars / BLOCK)} present` +
      (present.length ? `, first M${String(present[0]).padStart(4, '0')}` : ''));

    if (cut === 0) {
      console.log('=> WHOLE.');
      return { chars, verdict: 'whole', failed: false };
    }
    if (cut > 0) {
      console.log(`=> HEAD CUT: the first ${cut} characters are missing; the tail is intact.`);
      return { chars, verdict: `HEAD CUT ${cut}`, failed: true };
    }
    console.log('=> CUT, but not a clean prefix drop — the marker list above names what survived.');
    return { chars, verdict: 'CUT (not a prefix)', failed: true };
  } finally {
    // try/finally, not a bare return: an aborted case used to leave a live
    // `claude --dangerously-skip-permissions` in the rig worker, burning the real
    // account and walking into the 10-session cap over repeated runs.
    if (term) { try { term.close(); } catch { /* best effort */ } }
    // The DELETE is what kills the `claude --dangerously-skip-permissions` this case
    // spawned, and a silent `catch {}` here is not "best effort" — it is a leak nobody
    // can see. Observed: one case's DELETE failed, the session SURVIVED THE NEXT COLD
    // RESTART (the worker restores sessions and re-runs the autoCommand), and a real
    // agent sat there burning the account until it was found by hand. Retry once, then
    // say so loudly enough that the next run's operator cleans up.
    let deleted = false;
    for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
      try { await api(cookie, 'DELETE', `/api/sessions/${id}`); deleted = true; }
      catch (e) { if (attempt) console.log(`LEAKED session ${id} (${e.message}) — delete it by hand.`); }
    }
  }
}

(async () => {
  const sweep = process.argv.slice(2).map((a) => parseInt(a, 10)).filter((n) => n > 0);
  const lengths = sweep.length ? sweep : DEFAULT_SWEEP;
  console.log(`shape: ${BRACKETED ? 'BRACKETED (the candidate fix)' : 'UNBRACKETED (what a dictated prompt sends today)'}`);
  console.log(`sweep: ${lengths.join(', ')}`);

  const cookie = await login();
  const rows = [];
  for (const chars of lengths) rows.push(await runCase(cookie, chars));

  console.log('\n=== SUMMARY ===');
  for (const r of rows) console.log(`${String(r.chars).padStart(6)} chars  ${r.verdict}`);
  const bad = rows.find((r) => r.failed);
  if (bad) {
    process.exitCode = 1;
    console.log(`\nFirst length that FAILED: ${bad.chars}. The largest CLEAN length is the`);
    console.log('bound a fix may rely on — take the threshold strictly under it, not at it.');
  } else {
    console.log('\nEvery swept length arrived whole AND started a turn in this shape.');
  }
})().catch((e) => { console.error(e); process.exit(2); });
