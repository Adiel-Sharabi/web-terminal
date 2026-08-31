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
// The list is not limited to the two clients. #201 added a SERVER constant paired with a
// CLIENT one: `server.js`'s per-frame WS input cap and the companion's offline-buffer
// ceiling are one invariant held as two equal numbers, and JS and Dart cannot import
// from one another there either. Anything that must stay equal across a language
// boundary belongs here.
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
  {
    // #201 — not two clients this time but a SERVER cap and a CLIENT one, which is
    // the same problem in a different direction: they are one invariant ("nothing
    // the offline buffer can hold within its ceiling may be refused at the wire"),
    // they are equal by construction, and neither file can import the other. The
    // seam this closes existed for months precisely because the two numbers looked
    // independent — 64KB on the wire, 256KB in the buffer, nothing tying them. Both
    // count UTF-16 code units, so the comparison is meaningful.
    what: 'WS input cap == companion offline-buffer ceiling (#201)',
    sites: [
      { file: 'server.js', re: /const\s+WS_INPUT_MAX\s*=\s*([^;]+);/ },
      { file: 'ai-terminal/lib/api/api_client.dart', re: /static\s+const\s+int\s+_inputBufferHardCap\s*=\s*([^;]+);/ },
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
  let v;
  try {
    v = Function('"use strict"; return (' + cleaned + ');')();
  } catch {
    // Character-legal but not parseable — `2 * (1024;`. Report it through the
    // caller's "cannot read as a number" path rather than dying with a stack
    // trace, so the failure names the constant instead of the checker.
    return null;
  }
  return Number.isFinite(v) ? v : null;
}

/// The site regexes are authored without `g` (they are read as single patterns);
/// `matchAll` requires it, so add it without disturbing their other flags.
function flagsWithGlobal(re) {
  return re.flags.includes('g') ? re.flags : re.flags + 'g';
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
    // EVERY occurrence, not the first. A non-global `.match()` returns match #1,
    // and the commonest way a person records a re-tune is to leave the old value
    // in a comment directly above the new one — which would make this gate read
    // the stale line, report agreement, and pass while the two clients genuinely
    // disagree. That is the single scenario this gate exists for, so more than
    // one hit is a failure rather than a first-wins guess.
    const all = [...fs.readFileSync(abs, 'utf8').matchAll(new RegExp(site.re, flagsWithGlobal(site.re)))];
    if (all.length === 0) {
      problems.push(`${entry.what}: not found in ${site.file}`
        + ' (renamed or removed? update scripts/check-shared-constants.js in the same change)');
      continue;
    }
    if (all.length > 1) {
      problems.push(`${entry.what}: ${all.length} definitions in ${site.file}`
        + ` (\`${all.map((x) => x[1].trim()).join('\`, \`')}\`)`
        + ' — a gate that reads only the first would pass while the clients disagree;'
        + ' delete the stale one (a commented-out old value counts)');
      continue;
    }
    const m = all[0];
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
