#!/usr/bin/env node
'use strict';
// WHERE does a long PASTED prompt lose its bytes? (reported 2026-08-30)
//
// The report: a long text pasted into the companion's chat compose bar arrives at
// the terminal CUT — twice — and pasting straight into the terminal instead
// delivers it whole.
//
// WHY THE EXISTING HARNESS DOES NOT COVER THIS, which is the whole reason for a
// second one. `verify-long-prompt.js` sends its 1582 chars as a PLAIN frame
// (`text\r`), and #63 measured node-pty/ConPTY byte-complete to 32 KB the same
// way. But `buildComposeSubmission` only produces that shape for a SINGLE-LINE
// buffer. The moment the text contains a newline — which any pasted paragraph
// does — it is wrapped instead:
//
//     ESC[200~ <text, every \n rewritten to \r> ESC[201~ \r
//
// That is a different byte shape, a much larger single write, and it is the one
// the report is about. Nothing has ever measured it.
//
// THE EVIDENCE IS THE SHELL COUNTING BYTES, NEVER THE ECHO. Reading the echo back
// is a known trap here: readline redraws a long line as it wraps, so the text
// appears in the stream reflowed and a contiguous compare fails while every marker
// is present — a false alarm shaped exactly like the bug. `wc -c` collapses it to
// one integer no redraw can forge (the lesson verify-long-prompt.js already paid
// for; kept here because this probe would have hit it too).
//
// A PLAIN SHELL, not an agent, on purpose: this probe asks only "do our bytes
// survive the wire and the PTY". Whether a TUI then re-shapes a paste into a
// "[Pasted text #1]" reference is a SEPARATE question and must not be allowed to
// contaminate the transport answer.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-paste-truncation.js
//
// Nothing here touches production.

const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The sizes to sweep. A STABLE cutoff points at a fixed buffer; a variable one at
// timing or flow control. Either way the threshold names the layer.
const SIZES = [1024, 2048, 4096, 8192, 16384, 32768, 60000];

const ESC = '\x1b';
const PASTE_OPEN = ESC + '[200~';
const PASTE_CLOSE = ESC + '[201~';

/** A single-line filler of exactly `n` chars, safe inside single quotes. */
function filler(n) {
  const block = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  while (s.length < n) s += block;
  return s.slice(0, n);
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

async function newShell(cookie, name) {
  const { id } = await api(cookie, 'POST', '/api/sessions', { name, cwd: DIRS.rig });
  return id;
}

/** Wait for a bash prompt so the shell is genuinely ready to read a line. */
async function waitShell(term, budgetMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (/\$\s*$/m.test(stripAnsi(term.text()))) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Send ONE bracketed-paste frame carrying a `wc -c` command over `n` bytes of
 * payload, then a CR — exactly the shape buildComposeSubmission emits for any
 * multi-line buffer. Returns the integer the shell counted, or null.
 */
async function measure(term, n) {
  const payload = filler(n);
  const cmd = `printf '%s' '${payload}' | wc -c`;
  const mark = term.text().length;

  // ONE frame, as the client sends it. The worker owns the CR split (#55), so the
  // CR rides along and is separated server-side — not imitated here.
  term.send(PASTE_OPEN + cmd + PASTE_CLOSE + '\r');

  // wc prints one integer on its own line. Poll for any bare number that is a
  // plausible answer; the echoed command cannot forge it because the payload is
  // alphanumeric filler with no standalone integer in it.
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const out = stripAnsi(term.text().slice(mark));
    const m = out.match(/^\s*(\d{2,7})\s*$/m);
    if (m) return parseInt(m[1], 10);
    await sleep(300);
  }
  return null;
}

(async () => {
  const cookie = await login();
  const id = await newShell(cookie, 'paste-trunc');
  const term = await openTerminal(cookie, id);
  if (!(await waitShell(term))) {
    console.log('no shell prompt — aborting rather than reporting a false negative');
    term.close();
    return;
  }
  // Bracketed paste must be ON, or readline treats the markers as literal text
  // and the measurement is of something else entirely.
  term.send('printf "\\e[?2004h"\r');
  await sleep(600);

  console.log('payload |   counted | verdict');
  console.log('--------+-----------+---------------------------------------------');
  let firstBad = null;
  for (const n of SIZES) {
    const got = await measure(term, n);
    const ok = got === n;
    if (!ok && firstBad === null) firstBad = n;
    console.log(
      String(n).padStart(7) + ' | ' + String(got === null ? 'NO ANSWER' : got).padStart(9)
      + ' | ' + (ok ? 'intact' : got === null ? 'no answer within 25s' : `CUT — lost ${n - got}`),
    );
    await sleep(1200);
  }

  console.log('');
  if (firstBad === null) {
    console.log('TRANSPORT CLEAN to ' + SIZES[SIZES.length - 1] + ' bytes as ONE bracketed paste.');
    console.log('=> our wire/worker/PTY path is NOT the cut. Look at the receiving TUI.');
  } else {
    console.log('FIRST LOSS AT ' + firstBad + ' bytes — the cut is in OUR stack, at or below the PTY write.');
  }

  term.close();
  try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch { /* best effort */ }
})().catch((e) => { console.error(e); process.exit(2); });
