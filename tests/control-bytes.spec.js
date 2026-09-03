// @ts-check
// #221 — A RAW CONTROL BYTE WHERE AN ESCAPE WAS INTENDED IS INVISIBLE IN EVERY RENDERING.
//
// The instance that produced this gate: a `not.toHaveClass(/\bopen\b/)` guard was committed
// carrying two raw U+0008 BACKSPACE bytes instead of the two-character escape. The compiled
// regex was /<BS>open<BS>/, which matches no class attribute that can exist, so the negated
// assertion passed unconditionally — against a fully-open drawer — while its own comment
// claimed it could not. It survived `git diff` (which printed it as `/open/`), an editor
// (which printed it as `/\bopen\b/`), a green full suite, green CI, and two readers.
//
// A DEAD ASSERTION THAT CLAIMS COVERAGE IS WORSE THAN NO ASSERTION, which is why this is a
// gate and not a note. The trap had already been recorded twice before that commit and hit
// twice more the same day while the fix was being written — including in the tooling used to
// write it. Nothing about it is rare; it is simply unreadable.
//
// `\b` IS THE WORST MEMBER OF THE FAMILY. It is the one escape whose literal-byte form is
// still a *valid* regex with a completely different, always-false meaning. A corrupted `\n`
// or `\t` breaks something visibly. A corrupted `\b` silently stops matching.
//
// WHY ESLINT CANNOT DO THIS. `no-control-regex` is the rule that catches it, and
// `eslint.config.js` turns it off in both the server block and the tests block — for a good
// reason: this app's ANSI handling genuinely matches ESC. The rule is unavailable by design,
// so the enforceable form is an explicit inventory.
//
// THE ALLOWLIST IS AN INVENTORY, NOT A SUPPRESSION. Each entry names the codepoints AND how
// many, so adding a control byte to an already-listed file still turns this red. Updating it
// is meant to cost a moment's thought — that is the whole mechanism.
//
// This file is deliberately ASCII-only. It builds every control character it names with
// `String.fromCharCode`, because a gate that contained the thing it forbids would flag
// itself — and a gate that exempted itself would be no gate at all.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Directories walked in full, plus the top-level files that are served or supervise. */
const DIRS = ['tests', 'lib', 'scripts'];
const FILES = [
  'server.js', 'pty-worker.js', 'monitor.js',
  'app.html', 'terminal.html', 'lobby.html', 'sw.js', 'eslint.config.js',
];

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const DEL = 0x7f;

/**
 * Every control byte that is SUPPOSED to be here, by file and by codepoint, with a count.
 *
 * Derived by measurement, not by accepting a report: scanned independently before this gate
 * was written. Four lines across 211 `.js` files, every one of them a deliberate raw byte in
 * a place where the raw byte IS the subject.
 *
 * Counts are per FILE rather than per line on purpose — line numbers drift with every edit
 * above them, and a gate that goes red because someone added a comment teaches people to
 * silence it.
 */
const ALLOWED = {
  'tests/cluster-client-token.spec.js': {
    // A NUL injected into a label, and the assertion that it does not come back out. The
    // raw byte is the payload; escaping it would test a different string.
    counts: { 0x00: 2 },
  },
  'scripts/rig/probe-blocked-markers.js': {
    // An OSC stripper: ESC ] ... BEL. Matching the real bytes is the point of the rig.
    counts: { 0x1b: 1, 0x07: 2 },
  },
  'scripts/rig/probe-slash-submit.js': {
    // A CSI stripper, same reason.
    counts: { 0x1b: 1 },
  },
};

/** Recursive `.js` walk, skipping anything installed rather than written here. */
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test-results') continue;
      walk(full, out);
    } else if (e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test.describe('#221 no stray control bytes in source', () => {
  test('every raw C0/DEL byte is one the inventory expects', () => {
    const targets = [];
    for (const d of DIRS) walk(path.join(ROOT, d), targets);
    for (const f of FILES) targets.push(path.join(ROOT, f));

    /** file -> { codepoint -> count } */
    const found = {};
    const lines = [];

    for (const abs of targets) {
      let src;
      try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      src.split('\n').forEach((line, i) => {
        for (const ch of line) {
          const cp = ch.codePointAt(0);
          if (cp === TAB || cp === CR || cp === LF) continue;
          if (cp >= 0x20 && cp !== DEL) continue;
          found[rel] = found[rel] || {};
          found[rel][cp] = (found[rel][cp] || 0) + 1;
          lines.push(`${rel}:${i + 1}  U+${cp.toString(16).padStart(4, '0').toUpperCase()}`);
        }
      });
    }

    // Compared as a whole map rather than file by file, so BOTH directions fail loudly: an
    // unexpected byte appears, and an allowlist entry whose bytes are gone goes stale. A
    // stale exemption is how an inventory quietly turns back into a suppression.
    const expected = {};
    for (const [f, spec] of Object.entries(ALLOWED)) expected[f] = spec.counts;

    const norm = (m) => Object.fromEntries(
      Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([f, counts]) => [
        f,
        Object.fromEntries(Object.entries(counts)
          .map(([cp, n]) => [`U+${Number(cp).toString(16).padStart(4, '0').toUpperCase()}`, n])
          .sort(([a], [b]) => a.localeCompare(b))),
      ]),
    );

    expect(
      norm(found),
      'A raw control byte appeared where an escape was almost certainly meant. `\\b` written '
        + 'as a literal U+0008 compiles to a regex that matches nothing, so a negated '
        + 'assertion around it passes unconditionally and reports coverage it does not have '
        + '(#221). Rewrite it as an escape and verify by BYTES, not by reading it — every '
        + 'renderer hides this. If the byte is genuinely the subject (an ANSI matcher, an '
        + 'injection payload), add it to ALLOWED above with a reason. Offending lines:\n'
        + lines.join('\n'),
    ).toEqual(norm(expected));
  });
});
