#!/usr/bin/env node
'use strict';
// Verify that a value defined in BOTH clients still holds the same number in each.
//
//   node scripts/check-shared-constants.js
//
// WHY THIS EXISTS. This repo ships two clients — `app.html` (JavaScript) and the
// companion (Dart) — and they cannot import from one another. A few values are
// therefore genuinely defined twice, which is the one duplication the SSOT rule cannot
// design away. What it CAN do is make the copies unable to drift silently.
//
// The case that prompted it (#165): the memory-headroom colour thresholds. Both
// definitions are explicitly marked PROVISIONAL and both invite re-tuning against a box
// observed in the middle of the range — so the day somebody takes that invitation is a
// day one client gets re-tuned and the other does not, and the same fleet then renders
// the same server amber on the phone and neutral in the browser. Nothing would have
// failed. Now this does.
//
// It is deliberately NOT a general duplication detector: it checks a hand-written list,
// because the value of the gate is that every entry was a considered decision to
// duplicate. Adding a shared constant means adding a line here in the same change.
//
// A MISSING constant is a failure, not a skip. A gate that quietly passes when a name is
// renamed away is worse than none — it reports green over a check it never ran.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// One entry per value that is defined in more than one place. `re` must capture the
// numeric expression in group 1; the expression is evaluated as arithmetic (see below),
// so `2 * 1024 * 1024 * 1024` and `2147483648` compare equal — the gate is about the
// NUMBER, not how it is spelled in two different languages.
const SHARED = [
  {
    what: 'memory headroom: RED threshold (#165)',
    sites: [
      { file: 'app.html', re: /const\s+MEM_HEADROOM_RED_BYTES\s*=\s*([^;]+);/ },
      { file: 'ai-terminal/lib/widgets/format_utils.dart', re: /const\s+int\s+kHeadroomRedBytes\s*=\s*([^;]+);/ },
    ],
  },
  {
    what: 'memory headroom: AMBER threshold (#165)',
    sites: [
      { file: 'app.html', re: /const\s+MEM_HEADROOM_AMBER_BYTES\s*=\s*([^;]+);/ },
      { file: 'ai-terminal/lib/widgets/format_utils.dart', re: /const\s+int\s+kHeadroomAmberBytes\s*=\s*([^;]+);/ },
    ],
  },
];

// Arithmetic only — digits, `*`, `+`, `-`, `(`, `)`, `_` (Dart's digit separator) and
// whitespace. Anything else is refused rather than evaluated: this file reads two source
// files, and "evaluate whatever the regex captured" is how a checker becomes a way to run
// code. A refusal is reported as a failure, so an expression this cannot read is visible
// rather than silently skipped.
function evalNumeric(expr) {
  const cleaned = String(expr).trim().replace(/_/g, '');
  if (!/^[\d\s*+\-()]+$/.test(cleaned)) return null;
  const v = Function('"use strict"; return (' + cleaned + ');')();
  return Number.isFinite(v) ? v : null;
}

const problems = [];
let checked = 0;

for (const entry of SHARED) {
  const found = [];
  for (const site of entry.sites) {
    const abs = path.join(ROOT, site.file);
    if (!fs.existsSync(abs)) {
      problems.push(`${entry.what}: ${site.file} does not exist`);
      continue;
    }
    const m = fs.readFileSync(abs, 'utf8').match(site.re);
    if (!m) {
      problems.push(`${entry.what}: not found in ${site.file}`
        + ' (renamed or removed? update scripts/check-shared-constants.js in the same change)');
      continue;
    }
    const value = evalNumeric(m[1]);
    if (value === null) {
      problems.push(`${entry.what}: ${site.file} defines it as \`${m[1].trim()}\`, which this gate cannot read as a number`);
      continue;
    }
    found.push({ file: site.file, expr: m[1].trim(), value });
  }
  if (found.length !== entry.sites.length) continue; // already reported above
  checked++;
  const first = found[0];
  for (const other of found.slice(1)) {
    if (other.value !== first.value) {
      problems.push(`${entry.what}: DRIFTED\n`
        + `      ${first.file}: ${first.expr}  = ${first.value}\n`
        + `      ${other.file}: ${other.expr}  = ${other.value}`);
    }
  }
}

if (problems.length) {
  console.error(`\nShared constants out of sync (${problems.length}):\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('\nThese values are defined in both clients because neither can import from the other.');
  console.error('Re-tune BOTH, in the same change, or the same server renders differently in each.\n');
  process.exit(1);
}
console.log(`OK — ${checked} shared constant(s) agree across every client that defines them.`);
