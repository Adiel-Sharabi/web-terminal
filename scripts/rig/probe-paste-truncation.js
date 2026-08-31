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
//
// THE SWEEP MUST CROSS 65536. `server.js` hard-drops any WS input frame longer than
// WS_INPUT_CAP and returns — a real cut, in OUR stack, that logs server-side and tells
// the client nothing. An earlier cut of this sweep stopped at 60000, i.e. 9% BELOW that
// boundary, and then printed "our stack is NOT the cut, look at the receiving TUI" —
// confidently redirecting the investigation away from the one drop we know we perform.
// A probe that stops short of a known threshold does not merely miss it; it argues
// against finding it.
const WS_INPUT_CAP = 65536;
const SIZES = [1024, 2048, 4096, 8192, 16384, 32768, 60000, 65000, WS_INPUT_CAP, 70000, 131072];

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
  const cmd = `printf '%s' '${payload}' | wc -c | tr -d ' ' | sed 's/^/WTCOUNT=/'`;
  const frame = PASTE_OPEN + cmd + PASTE_CLOSE + '\r';
  const frameBytes = Buffer.byteLength(frame, 'utf8');
  const mark = term.text().length;

  // ONE frame, as the client sends it. The worker owns the CR split (#55), so the
  // CR rides along and is separated server-side — not imitated here.
  term.send(frame);

  // The answer is TAGGED, not merely "a bare number on its own line". That earlier rule
  // was argued rather than enforced: this polls every 300ms WHILE a 60KB echo is still
  // streaming, and JS `m`-mode ^/$ also break on the \r that readline redisplay emits
  // freely — so a poll landing mid-redraw could match 2-7 digits out of the payload's
  // own `0123456789` run and return a forged count. A tag the payload cannot contain
  // makes the number unforgeable instead of improbable.
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const out = stripAnsi(term.text().slice(mark));
    const m = out.match(/^WTCOUNT=(\d+)$/m);
    if (m) return { count: parseInt(m[1], 10), frameBytes };
    await sleep(300);
  }
  return { count: null, frameBytes };
}

(async () => {
  const cookie = await login();
  const id = await newShell(cookie, 'paste-trunc');
  let term = null;
  // try/finally: every abort below used to `return` past the DELETE, leaking a rig
  // session per failed run until the 10-session cap was hit.
  try {
    term = await openTerminal(cookie, id);
    if (!(await waitShell(term))) {
      console.log('no shell prompt — aborting rather than reporting a false negative');
      process.exitCode = 1;
      return;
    }
    // Bracketed paste is guaranteed by the WORKER, not by this probe. pty-worker.js
    // writes an INPUTRC containing `set enable-bracketed-paste on` and exports INPUTRC,
    // which is what installs readline's \e[200~ keymap binding.
    //
    // An earlier cut sent `printf '\e[?2004h'` here and claimed it was the precondition.
    // It is not: that sequence written TO a terminal sets a DISPLAY mode; it does not
    // bind anything in readline. So the line was a no-op whose comment would have made
    // a genuinely unbound readline look like a measured result — the probe would have
    // silently measured literal-text insertion instead of a paste.
    console.log('payload |   counted | verdict');
    console.log('--------+-----------+---------------------------------------------');
    let firstBad = null;
    let firstNull = null;
    let firstDrop = null;
    for (const n of SIZES) {
      const { count, frameBytes } = await measure(term, n);
      const overCap = frameBytes > WS_INPUT_CAP;
      const ok = count === n;
      // A frame over the cap is EXPECTED to vanish — server.js drops it and tells the
      // client nothing. Reporting that as "inconclusive" would bury the very boundary
      // this sweep was extended to find; reporting it as a "cut" would invent a
      // mechanism. It is a known, located, silent drop, and it is OURS.
      if (overCap && count === null) { if (firstDrop === null) firstDrop = n; }
      else if (count === null) { if (firstNull === null) firstNull = n; }
      else if (!ok && firstBad === null) firstBad = n;
      const verdict = ok ? 'intact'
        : count === null
          ? (overCap ? `DROPPED — frame ${frameBytes}B exceeds the ${WS_INPUT_CAP}B WS cap` : 'no answer within 25s')
          : `CUT — lost ${n - count}`;
      console.log(
        String(n).padStart(7) + ' | ' + String(count === null ? 'NO ANSWER' : count).padStart(9)
        + ' | ' + verdict,
      );
      await sleep(1200);
    }

    console.log('');
    // A TIMEOUT IS NOT A MEASURED CUT. Reporting "FIRST LOSS AT n" for a run that
    // measured nothing is how a probe manufactures a root cause.
    if (firstBad !== null) {
      console.log(`FIRST LOSS AT ${firstBad} bytes — the cut is in OUR stack, at or below the PTY write.`);
      process.exitCode = 1;
    } else if (firstNull !== null) {
      console.log(`INCONCLUSIVE at ${firstNull} bytes — no answer within 25s. Nothing was measured there; do not read this as clean OR as a cut.`);
      process.exitCode = 1;
    } else if (firstDrop !== null) {
      // Exit 0 DELIBERATELY. Every size whose frame fits the cap counted intact, and the
      // sizes above it were dropped exactly as server.js is written to drop them — that
      // is the documented boundary being located, not an anomaly this run discovered.
      // The branch is self-validating: it is only reached when nothing was cut and
      // nothing timed out unexplained, and `overCap` is computed from the real frame
      // length against the real constant, so a cap that MOVED DOWN would surface as a
      // drop at a size whose frame still fits — which lands in the `firstNull` branch
      // above and exits non-zero. The user-facing defect (the drop is silent) is #193's,
      // not a failure of this measurement.
      console.log(`TRANSPORT CLEAN as ONE bracketed paste up to the last size whose FRAME fits ${WS_INPUT_CAP} bytes.`);
      console.log(`SILENT DROP from payload ${firstDrop} bytes up: the frame exceeds server.js's ${WS_INPUT_CAP}-byte WS input cap,`);
      console.log('which logs server-side and tells the client NOTHING. That is a real loss and it is OURS —');
      console.log('total, not partial, so it presents as "my paste did nothing", not as "my paste arrived cut".');
    } else {
      const max = SIZES[SIZES.length - 1];
      console.log(`TRANSPORT CLEAN to ${max} bytes as ONE bracketed paste.`);
      console.log('=> our wire/worker/PTY path is not the cut at any size swept.');
    }
  } finally {
    if (term) { try { term.close(); } catch { /* best effort */ } }
    try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch { /* best effort */ }
  }
})().catch((e) => { console.error(e); process.exit(2); });
