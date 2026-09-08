#!/usr/bin/env node
'use strict';
// #237 — why does the COMPANION underline every word?
//
// The issue names the decisive experiment: are the bytes carrying SGR 4, or is the
// vendored xterm.dart turning something else INTO underline? This answers both from one
// capture, because guessing at it was already producing confident wrong mechanisms.
//
// It does two things a screenshot cannot:
//   1. tallies every real `CSI ... m` claude emits, so "does SGR 4 appear at all, and is
//      it ever reset with 24/0" stops being a hypothesis;
//   2. replays each captured sequence through THE VENDORED PARSER'S OWN accumulation rule
//      (third_party/xterm/lib/src/core/escape/parser.dart, `_consumeCsi`) and compares its
//      parameter list against a correct ECMA-48 reading. Any sequence where the two
//      disagree — especially one that yields 4 only in the vendored reading — is the bug.
//
// It prints BYTE OFFSETS for every occurrence, because the claim this probe exists to
// settle is positional - "it arrives near the head and is never undone" - and a tally
// alone cannot say where anything sat. It prints the claude version for the same reason:
// the TUI's byte stream is version-specific and moves under you.
//
// The colon is the suspect the issue names: parser.dart tests semicolon, digits,
// `< '0'` intermediates and `>= '@'` finals, and COLON (0x3A) matches none of them, so it
// is consumed and silently dropped while `param` keeps accumulating. `ESC[4:3m` therefore
// reads as 43, not as 4 — which is why this has to be measured rather than assumed.

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { DIRS } = require('../scratch-dirs');

const BS = String.fromCharCode(92);   // built, never written literally: a heredoc
// strips one backslash level and JS then reads the survivors as escape sequences.
// (This very comment shipped a literal 0x08 on its first draft, from the escape it
// was describing. tests/control-bytes.spec.js caught it - which is what it is for.)
const SHELL = process.platform === 'win32'
  ? ['C:', 'Program Files', 'Git', 'bin', 'bash.exe'].join(BS)
  : '/bin/bash';
const PROMPT = process.argv.includes('--prompt')
  ? process.argv[process.argv.indexOf('--prompt') + 1]
  : null;
// `--replay <capture.bin>` re-reports an EXISTING capture instead of spawning a TUI. The
// probe has always written `capture.bin` and nothing could ever read it back, so a run
// that produced an interesting stream could only be re-analysed by re-running it against
// a claude that had since moved on. It is also the only way to exercise the reporting
// below when a PTY cannot be spawned at all.
const REPLAY = process.argv.includes('--replay')
  ? process.argv[process.argv.indexOf('--replay') + 1]
  : null;
const DWELL_MS = 22000;

// --- the vendored parser's accumulation rule, transcribed ------------------------------
// Deliberately a transcription rather than an import: the point is to show what THAT code
// does with these exact bytes.
//
// IT IS KEPT IN STEP BY HAND, and nothing enforces that. An earlier draft of this comment
// said "kept in step by construction ... and the comment in parser.dart says so" - both
// false, and the transcription had already drifted: it reset `hasParam` on ';' where
// `_consumeCsi` does not, so `ESC[1;m` read as [1] here and [1,0] there. Re-read
// `_consumeCsi` before trusting any disagreement this prints.

// `_consumeCsi` peels a PREFIX first: ONE leading byte in 0x3A..0x3F (Ascii.colon through
// Ascii.questionMark). That range is WIDER than ECMA-48's private markers 0x3C-0x3F, so a
// leading ':' or ';' is swallowed as a prefix too - which is why `ESC[;4m`, the ordinary
// SGR `0;4`, arrives carrying one. #237's guard therefore tests `>= 0x3C`, not `!= null`.
function splitPrefix(body) {
  const first = body.charCodeAt(0);
  if (body.length && first >= 0x3a && first <= 0x3f) {
    return { prefix: body[0], rest: body.slice(1) };
  }
  return { prefix: null, rest: body };
}

// The accumulation loop, on the bytes AFTER the prefix.
function vendoredParams(rest) {
  const params = [];
  let param = 0, hasParam = false;
  for (const ch of Buffer.from(rest, 'latin1')) {
    // `hasParam` is deliberately NOT reset: parser.dart:239-245 does not reset it, so once
    // any digit has been seen every later ';' pushes another value (`ESC[1;m` -> [1, 0]).
    if (ch === 0x3b) { if (hasParam) params.push(param); param = 0; continue; }
    if (ch >= 0x30 && ch <= 0x39) { hasParam = true; param = param * 10 + (ch - 0x30); continue; }
    if (ch > 0x00 && ch < 0x30) continue;          // intermediates - dropped
    if (ch >= 0x40 && ch <= 0x7e) { if (hasParam) params.push(param); return params; }
    // 0x3A COLON and 0x3C-0x3F fall through every branch: consumed, ignored.
  }
  if (hasParam) params.push(param);
  return params;
}

// --- a correct ECMA-48 reading: ';' separates, ':' opens sub-parameters ----------------
function correctParams(rest) {
  if (rest === '') return [];
  return rest.split(';').map((p) => {
    const head = p.split(':')[0];
    return head === '' ? 0 : parseInt(head, 10);
  });
}

// --- which SGR ATTRIBUTES a parameter list actually selects ----------------------------
// NOT `params.includes(n)`. In `ESC[48;2;0;0;0m` those trailing zeros are the blue channel
// of an extended colour, not three `SGR 0` resets, and `ESC[38;2;4;...m` carries a 4 that is
// not underline - so an `includes` tally over-counts exactly the two numbers this probe is
// here to count. `_csiHandleSgr` consumes the arguments itself (`i += 4` for mode 2,
// `i += 2` for mode 5) and this mirrors it, INCLUDING the quirks: only 38 and 48 are
// handled there (there is no `case 58`), and a mode that is neither 2 nor 5 advances
// nothing, so its arguments are read as attributes.
function sgrAttributes(params) {
  const out = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    out.push(p);
    if (p === 38 || p === 48) {
      if (params[i + 1] === 2) i += 4;
      else if (params[i + 1] === 5) i += 2;
    }
  }
  return out;
}

// An EMPTY parameter list is a full reset: `_csiHandleSgr` answers `params.isEmpty` with
// `resetCursorStyle()`, so a bare `ESC[m` clears underline exactly like `ESC[0m`.
const isReset = (attrs) => attrs.length === 0 || attrs.includes(0);

function main() {
  const cwd = path.join(DIRS.probe, 'underline-sgr');
  fs.mkdirSync(cwd, { recursive: true });

  if (REPLAY) {
    report(fs.readFileSync(REPLAY), cwd, REPLAY);
    return;
  }

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(k)) continue;    // a nested child session behaves differently
    if (/^WT_/i.test(k)) continue;
    env[k] = v;
  }
  env.DISABLE_AUTOUPDATER = '1';

  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd, env, encoding: null,
    useConptyDll: true,
  });

  let raw = Buffer.alloc(0);
  term.onData((d) => {
    const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
    raw = Buffer.concat([raw, b]);
  });

  console.log(`spawned shell pid=${term.pid} cwd=${cwd}`);
  setTimeout(() => term.write('claude --dangerously-skip-permissions\r'), 1200);
  if (PROMPT) setTimeout(() => term.write(PROMPT + '\r'), 12000);

  setTimeout(() => {
    try { term.kill(); } catch { /* already gone */ }
    report(raw, cwd);
  }, DWELL_MS);
}

// `claude --version`, so a capture can be compared with a later one. The TUI's byte stream
// is version-specific: a release that stops emitting `CSI > 4 m` makes every tally below
// change meaning, and without this line nobody could tell that from a probe that misfired.
function claudeVersion() {
  try {
    return require('child_process')
      .execFileSync(SHELL, ['-c', 'claude --version'], { encoding: 'utf8', timeout: 30000 })
      .trim().split('\n').pop().trim() || 'unknown';
  } catch (e) {
    return `unknown (${e.code || e.message})`;
  }
}

function report(raw, cwd, replayedFrom) {
  const text = raw.toString('latin1');
  let outFile = replayedFrom;
  if (!replayedFrom) {
    outFile = path.join(cwd, 'capture.bin');
    fs.writeFileSync(outFile, raw);
  }
  // On a replay the version is the one installed NOW, which is not necessarily the one
  // that produced the capture - say so rather than stamping it as if it were.
  console.log(`\nclaude version: ${claudeVersion()}${replayedFrom ? ' (INSTALLED NOW - the replayed capture may predate it)' : ''}`);
  console.log(`${replayedFrom ? 'replayed' : 'captured'} ${raw.length} bytes ${replayedFrom ? 'from' : '->'} ${outFile}\n`);

  // Every CSI ... m (SGR), WITH ITS BYTE OFFSET. The body is everything between `ESC[` and
  // the final `m`; latin1 is one byte per code unit, so `m.index` IS the byte offset.
  const hits = [];
  const sgr = new Map();
  const re = /\x1b\[([\x30-\x3f]*)m/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const { prefix, rest } = splitPrefix(m[1]);
    const vendored = vendoredParams(rest);
    hits.push({
      at: m.index, body: m[1], prefix, vendored,
      attrs: sgrAttributes(vendored),
    });
    sgr.set(m[1], (sgr.get(m[1]) || 0) + 1);
  }

  console.log(`SGR sequences: ${hits.length} total, ${sgr.size} distinct`);
  const rows = [...sgr.entries()].sort((a, b) => b[1] - a[1]);

  let colonCount = 0, disagree = 0;
  const problems = [];
  for (const [body, n] of rows) {
    const { prefix, rest } = splitPrefix(body);
    const v = vendoredParams(rest);
    const c = correctParams(rest);
    const vU = sgrAttributes(v).includes(4);
    const cU = sgrAttributes(c).includes(4);
    if (body.includes(':')) colonCount += n;
    if (JSON.stringify(v) !== JSON.stringify(c)) {
      disagree += n;
      problems.push({ body, n, prefix, vendored: v, correct: c, vU, cU });
    }
  }

  console.log('\n--- the 20 most common, as CSI <body> m ---');
  for (const [body, n] of rows.slice(0, 20)) {
    const { prefix, rest } = splitPrefix(body);
    const pfx = prefix === null ? '' : `  prefix=${JSON.stringify(prefix)}`;
    console.log(`  ${String(n).padStart(6)}x  ESC[${body}m   vendored=${JSON.stringify(vendoredParams(rest))}${pfx}`);
  }

  // The accounting that matters, and it is POSITIONAL. A private-prefixed sequence sets
  // underline in the VENDORED reading and in no correct one; what makes it a latch rather
  // than a blip is that nothing after it turns underline off. So: where does each one sit,
  // and is there an `SGR 24` or a reset ANYWHERE after it?
  //
  // Note WHERE the #237 finding surfaces. Once the prefix is peeled off first - as
  // `_consumeCsi` really does - the two readings of `>4` AGREE on `[4]`, so the
  // disagreement table below does NOT flag it. It never was an accumulation bug: the
  // params are read correctly and the DISPATCH throws the prefix away. That is what the
  // "carrying a PRIVATE prefix" line counts, and the disagreement table is left to do its
  // own job (colon forms, `ESC[1;m`) rather than doubling as this one.
  const isPrivate = (h) =>
    h.prefix !== null && h.prefix.charCodeAt(0) >= 0x3c && h.prefix.charCodeAt(0) <= 0x3f;
  const underlineOn = hits.filter((h) => h.attrs.includes(4));
  const clears = hits.filter((h) => h.attrs.includes(24) || isReset(h.attrs)).filter((h) => !isPrivate(h));

  console.log('\n--- underline accounting (offsets are bytes into the capture) ---');
  console.log(`  sequences containing a colon                     : ${colonCount}`);
  console.log(`  underline ON in the VENDORED reading             : ${underlineOn.length}`);
  console.log(`    of those, carrying a PRIVATE prefix (the bug)  : ${underlineOn.filter(isPrivate).length}`);
  console.log(`  underline OFF (SGR 24), effective                : ${hits.filter((h) => h.attrs.includes(24) && !isPrivate(h)).length}`);
  console.log(`  full reset (SGR 0 or bare ESC[m), effective      : ${hits.filter((h) => isReset(h.attrs) && !isPrivate(h)).length}`);

  for (const h of underlineOn.slice(0, 20)) {
    const after = clears.find((c) => c.at > h.at);
    const tag = isPrivate(h) ? 'PRIVATE-PREFIXED, not an SGR at all' : 'a real SGR 4';
    console.log(`    ESC[${h.body}m at byte ${h.at} of ${raw.length} (${(100 * h.at / raw.length).toFixed(1)}%) - ${tag}`);
    console.log(`      first clear after it: ${after ? `ESC[${after.body}m at byte ${after.at}` : 'NONE - underline latches for the rest of the stream'}`);
  }
  if (!underlineOn.length) console.log('    (no sequence sets underline in the vendored reading)');

  console.log(`
--- sequences the VENDORED parser reads differently: ${problems.length} distinct, ${disagree} occurrence(s) ---`);
  for (const p of problems.slice(0, 25)) {
    const flag = p.vU && !p.cU ? '   <-- INVENTS UNDERLINE' : (!p.vU && p.cU ? '   <-- LOSES UNDERLINE' : '');
    console.log(`  ${String(p.n).padStart(6)}x  ESC[${p.body}m  vendored=${JSON.stringify(p.vendored)}  correct=${JSON.stringify(p.correct)}${flag}`);
  }
  if (!problems.length) console.log('  (none - the vendored accumulation agrees with ECMA-48 on every captured sequence)');

  // OSC 8 hyperlinks: many terminals underline these, and claude 2.x emits them.
  const osc8 = (text.match(/\x1b\]8;/g) || []).length;
  console.log(`\nOSC 8 hyperlink introducers: ${osc8}`);
}

main();
