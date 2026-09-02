#!/usr/bin/env node
'use strict';
// #210 — what does the chat lens's tail strip ACTUALLY have to work with?
//
// The strip renders the last few non-blank rows of the visible screen. The report was
// that it shows Claude's fixed footer (composer border, mode hint, status line, update
// notice) on every idle session, so it is least informative in exactly the state its own
// gate selects for. The fix hides the strip when the screen ENDS IN THE COMPOSER, keyed
// on the marker lib/agents.js already owns and #190 already measured.
//
// That fix needs ONE number this probe exists to supply: how far above the last non-blank
// row the composer's caret actually sits (`kComposerScanRows`). It must be measured, not
// picked — Claude renders inline rather than on the alternate screen (#146, measured
// twice), so a previous frame's composer can linger ABOVE a live dialog, and a window too
// generous would hide the strip on the one screen it exists for.
//
// It also fills the three rows #210 filed as UNMEASURED: `/usage`, an open slash menu and
// Agent View — the states #179 measured as swallowing a submitted prompt while emitting no
// distinguishing byte.
//
// ## This probe only CAPTURES. The rendering happens in Dart, on purpose.
//
// The strip reads the vendored xterm BUFFER, not raw bytes, and the whole reason is #190:
// Claude's dialogs position every word with CHA and emit no literal spaces, so a byte
// view reads `Quicksafetycheck:Isthis...`. Rendering here in Node would answer a
// different question from the one the app asks. So each state's raw stream is written to
// the scratch dir and `tool/tail_strip_report.dart` renders it through the SAME emulator
// the app ships.
//
// ## The captures are NOT checked in, and must not be
//
// #146 recorded why: an Agent View frame lists every Claude session on the machine by
// name and one-line summary, and this is a PUBLIC repo. The idle capture carries the
// status line, which on this fleet names a project and a user. Keep the NUMBERS, drop the
// BYTES — the same rule #146 followed.
//
// Usage:  node scripts/rig/rig.js up   &&   node scripts/rig/probe-tail-strip.js
const fs = require('fs');
const path = require('path');
const { login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESC = '\x1b';
// The composer marker itself, from the registry — never a second copy of it here. A probe
// that hardcodes the thing it is measuring can only ever confirm itself.
const { readinessMarker } = require('../../lib/agents');
const COMPOSER = readinessMarker('claude');

const OUT = path.join(DIRS.rig, 'tail-strip-captures');

// One session per state. They are never prompted, so the whole run costs agent STARTUPS
// and no turns. `idle` sends nothing at all — it is the reported case, and the one the
// constant comes from.
const CASES = [
  { name: 'idle', cols: 120, enter: null },
  { name: 'idle-phone', cols: 52, enter: null },
  { name: 'usage', cols: 120, enter: '/usage\r' },
  { name: 'slashmenu', cols: 120, enter: '/' },
  // A NARROWED menu, and it is the case that matters. Review pointed out that measuring
  // the bare `/` menu alone measures the menu at its TALLEST: its ~16 entries are what
  // push the composer's caret out of the scan window. Type a few characters, the list
  // filters down, the caret comes back toward the bottom — and the window may swallow it,
  // hiding the strip on a screen #179 catalogued as prompt-swallowing. Bare `/` is the
  // easy case; this is the one the bound has to survive.
  { name: 'slashmenu-narrow', cols: 120, enter: '/usa' },
  // ...and the TIGHTEST members of that family, because one narrowed sample is still one
  // sample. `/usage` typed in full is the fewest entries a MATCHING filter can leave, and
  // a filter matching NOTHING is the shortest the menu can get before it stops being a
  // menu at all. If the bound survives these it survives the family.
  { name: 'slashmenu-exact', cols: 120, enter: '/usage' },
  { name: 'slashmenu-nomatch', cols: 120, enter: '/zzzq' },
  { name: 'agentview', cols: 120, enter: `${ESC}[D` },
];

// Optional argv filter, so one case can be re-measured without paying for five agent
// startups: `node scripts/rig/probe-tail-strip.js slashmenu-narrow`.
const ONLY = process.argv.slice(2);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cookie = await login();
  const manifest = [];

  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.name)) continue;
    // A probe run in a LIVE session's cwd writes a newer rollout and hijacks that
    // session's chat lens (CLAUDE.md, the Codex rules — the same hazard applies to any
    // agent keyed on cwd). DIRS.rig is the rig's own, already-trusted directory.
    const { id } = await api(cookie, 'POST', '/api/sessions', {
      name: `ts-${c.name}`,
      cwd: DIRS.rig,
      autoCommand: 'claude --dangerously-skip-permissions',
      agent: 'claude',
    });
    const term = await openTerminal(cookie, id);
    try {
      // Declare the width BEFORE the agent draws, so the capture is a frame Claude
      // rendered FOR that width. #146: Claude truncates every row itself for the width it
      // is told about, and a viewer narrower than the PTY is what produced the reported
      // mess — measuring at the wrong width would measure our own bug, not Claude's.
      term.ws.send(JSON.stringify({ resize: { cols: c.cols, rows: 30 } }));

      // Key on the composer, never on the banner or "esc to interrupt" — CLAUDE.md
      // records both as measured false positives, the banner having broken a probe on a
      // routine auto-update.
      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < 90000) {
        if (COMPOSER.test(term.text())) { ready = true; break; }
        await sleep(250);
      }
      if (!ready) { console.log(`${c.name}: NO COMPOSER in 90s — skipped`); continue; }
      await sleep(2000); // let the status line and any update notice settle

      if (c.enter) {
        term.send(c.enter);
        await sleep(6000);
      }

      const file = path.join(OUT, `${c.name}.txt`);
      fs.writeFileSync(file, term.text(), 'utf8');
      manifest.push({ name: c.name, cols: c.cols, bytes: term.text().length, file });
      console.log(`${c.name.padEnd(11)} cols=${String(c.cols).padEnd(4)} ${term.text().length} bytes -> ${file}`);
    } finally {
      term.close();
      await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
    }
  }

  // MERGE, never overwrite: a filtered re-run of one case must not delete the other
  // captures from the manifest the Dart reporter reads.
  const mf = path.join(OUT, 'manifest.json');
  const prior = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : [];
  const merged = prior
    .filter((e) => !manifest.some((m) => m.name === e.name))
    .concat(manifest);
  fs.writeFileSync(mf, JSON.stringify(merged, null, 2));
  console.log(`\ncaptures in ${OUT}`);
  console.log('now render them:');
  console.log(`  cd ai-terminal && WT_TAIL_CAPTURES='${OUT}' flutter test tool/tail_strip_report.dart`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
