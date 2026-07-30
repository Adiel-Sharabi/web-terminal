#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, that a LONG prompt reaches the PTY WHOLE.
//
// The report this exists for: a 1582-character prompt arrived at the agent as only its
// last 666 characters — a clean PREFIX drop, the beginning simply gone. Everything
// downstream of the client had already been cleared once (#63 measured node-pty/ConPTY,
// the IPC frame and a real TUI byte-complete to 32 KB), but "already cleared" is not a
// gate: nothing in the suite actually asserted that a prompt of that size survives the
// real HTTP -> WebSocket -> server -> worker -> PTY path in one piece. This does.
//
// The text is INSTRUMENTED: every 50-character block opens with its own offset (M0000,
// M0050, ...). A truncation therefore names its own cut point instead of leaving us to
// eyeball prose, and a missing MIDDLE is distinguishable from a missing head or tail.
//
// The evidence is the shell COUNTING the bytes, never the echo. Reading the echo back was
// the first design and it is a trap: readline redraws a 1582-character line as it wraps,
// so the text appears in the stream in reflowed fragments and a contiguous compare fails
// while every single marker is present — a FALSE ALARM that looks exactly like the bug
// under test. `printf '%s' '<text>' | wc -c` collapses the whole question to one integer
// that no redraw, wrap or cursor move can forge.
//
//   node scripts/rig/rig.js up            # sync working tree + (re)start the rig
//   node scripts/rig/verify-long-prompt.js
//
// Nothing here touches production.

const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');

const TOTAL = 1582; // the exact length of the reported prompt
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 1582 chars; each 50-char block labelled with its own offset. */
function instrumentedPrompt() {
  const filler = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqr'; // 44
  let s = '';
  for (let off = 0; s.length < TOTAL; off += 50) {
    s += 'M' + String(off).padStart(4, '0') + filler + ' '; // 5 + 44 + 1
  }
  return s.slice(0, TOTAL);
}

/** Remove OSC and CSI/escape sequences, leaving the characters the screen shows. */
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/** Strip ANSI and every whitespace run, so line-wrapping cannot alter the verdict. */
function normalize(s) {
  return stripAnsi(s).replace(/\s+/g, '');
}

/** Which instrumented markers are missing from the echo — the cut, located. */
function missingMarkers(haystack, prompt) {
  const gone = [];
  for (const m of prompt.match(/M\d{4}/g) || []) {
    if (!haystack.includes(m)) gone.push(m);
  }
  return gone;
}

async function main() {
  const prompt = instrumentedPrompt();
  if (prompt.length !== TOTAL) throw new Error(`bad probe text: ${prompt.length}`);

  const cookie = await login();
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: 'verify-long-prompt',
    cwd: 'C:\\dev\\wt-rig',
  });
  console.log(`session ${id} created`);

  // openTerminal declares {"mode":"active"} — without it the server drops every
  // keystroke as background input and this verifier would prove nothing at all.
  const term = await openTerminal(cookie, id);
  try {
    for (let i = 0; i < 40 && !/[$#>]/.test(term.text()); i++) await sleep(250);

    // ONE frame, exactly as a client's sendInput does it. The probe text is alphanumeric
    // plus spaces, so single-quoting it is safe with no escaping to get wrong. The worker
    // splits the trailing CR itself (the submit contract) — that is the real path.
    const before = term.text().length;
    term.send(`printf '%s' '${prompt}' | wc -c\r`);

    // `wc -c` prints ONE integer. The echoed command cannot forge it: the markers are
    // M0000..M1550, whose digits sit inside a word, so \b1582\b cannot match them.
    // Match on ANSI-STRIPPED text. The raw stream wraps that integer in escape
    // sequences, so a line-anchored `^\s*(\d+)\s*$` against the raw bytes never matches
    // and the probe reports FAIL while the shell has plainly answered 1582 — the exact
    // false alarm this verifier exists to distinguish from a real truncation.
    //
    // Be generous with the window too: readline redraws a 1582-char line as it wraps,
    // and on a Windows ConPTY that echo alone takes tens of seconds.
    let counted = null;
    for (let i = 0; i < 240; i++) {
      await sleep(250);
      const hit = stripAnsi(term.text().slice(before)).match(/^[ \t\r]*(\d{2,7})[ \t\r]*$/m);
      if (hit) { counted = parseInt(hit[1], 10); break; }
    }

    const gone = missingMarkers(normalize(term.text()), prompt);
    const ok = counted === TOTAL;

    console.log(`prompt sent   : ${prompt.length} chars, as ONE frame`);
    console.log(`shell counted : ${counted === null ? '(no count returned)' : counted + ' bytes'}`);
    console.log(`markers echoed: ${gone.length === 0 ? 'all 32 present' : 'MISSING ' + gone.join(' ')}`);
    console.log(ok
      ? `PASS — all ${TOTAL} bytes reached the PTY intact`
      : `FAIL — the PTY received ${counted} of ${TOTAL} bytes`);

    if (!ok) {
      // Show what the shell actually did. A verifier that only says FAIL sends you
      // hunting the product for what is usually a fault in the probe.
      const clean = stripAnsi(term.text().slice(before));
      console.log('--- last 240 chars the PTY emitted ---');
      console.log(JSON.stringify(clean.slice(-240)));
      process.exitCode = 1;
    }
  } finally {
    term.close();
    try { await api(cookie, 'DELETE', `/api/sessions/${id}`); } catch {}
  }
}

main().catch((e) => {
  console.error('verify-long-prompt failed:', e.message);
  process.exitCode = 1;
});
