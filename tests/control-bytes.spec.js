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
// THE ALLOWLIST IS AN INVENTORY, NOT A SUPPRESSION. Each entry names the FILE, the
// CODEPOINTS and how many, so a new byte, a different byte, or one more of the same byte all
// turn this red. Updating it is meant to cost a moment's thought — that is the whole
// mechanism.
//
// ONE RESIDUAL BLIND SPOT, recorded rather than closed (review). Same file, same codepoint,
// same count, DIFFERENT LINE: delete the legitimate ESC from an ANSI stripper and put an ESC
// somewhere harmful in that same file, and the map is unchanged. Keying entries on line
// numbers would close it, and was rejected deliberately — line numbers drift with every
// edit above them, so the gate would go red for changes that touched no control byte at all,
// and a gate that cries wolf is one people learn to silence. That is the exact failure this
// whole exercise is about, so a known-narrow hole beats a check nobody trusts.
//
// This file is deliberately ASCII-only: it never writes a control character at all, only
// NUMERIC CODEPOINTS (`0x1b`, `TAB = 0x09`). A gate that contained the thing it forbids
// would flag itself, and one that exempted itself would be no gate at all.
//
// (An earlier draft of this comment said the file builds each character with
// `String.fromCharCode`. It does not — that identifier appears nowhere in the code, and
// comparing numbers is better than constructing characters. Caught in review, and worth
// keeping visible: a comment asserting a mechanism the code does not use is the exact
// defect this gate exists to catch, reappearing in the gate's own description.)
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Directories walked in full, plus the top-level files that are served or supervise.
 *
 * `docs/` AND THE COMPANION WERE OUT OF SCOPE UNTIL #259, and the omission had the shape
 * this gate exists to catch: it covered the trees somebody thought of, silently, with
 * nothing saying so. Both are written through exactly the same editing channels as the
 * server - and `ai-terminal/` has its own recorded instance of this defect, a literal
 * U+0008 shipped inside a comment warning about literal control bytes.
 *
 * MEASURED before widening, not after: 233 files -> 389, and ZERO new hits. So the
 * allowlist and both pinned numbers below are unchanged by the widening, which is what
 * makes it a coverage change rather than a triage exercise.
 *
 * `ai-terminal/third_party/` is deliberately absent: it is vendored xterm (#81), not
 * written here, and `walk` skips the directory name as a second line of defence.
 */
const DIRS = ['tests', 'lib', 'scripts', 'docs', 'ai-terminal/lib', 'ai-terminal/test'];
const FILES = [
  'server.js', 'pty-worker.js', 'monitor.js',
  'app.html', 'terminal.html', 'lobby.html', 'sw.js', 'eslint.config.js',
  // The two root documents agents rewrite most often, and the place this repo records
  // the escape-normalisation trap in the first place.
  'README.md', 'CLAUDE.md',
];

/**
 * Extensions walked. `.md` and `.dart` join `.js` with #259's widening: a control byte
 * hides just as well in prose as in code, and the companion is Dart.
 */
const EXTS = ['.js', '.md', '.dart'];

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

/** Recursive source walk, skipping anything installed rather than written here. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'test-results',
  // Vendored xterm (#81) and Flutter build output - neither is written in this repo.
  'third_party', 'build', '.dart_tool',
]);

/**
 * Every directory the walk declined to enter, recorded so the decision is auditable.
 *
 * A SKIP is a silent narrowing by construction: `continue` leaves nothing behind for any
 * later assertion to notice. `SKIP_DIRS.add('rig')` would drop `scripts/rig` - 28 files,
 * and the most escape-sequence-heavy tree in the repo - with every other check in this
 * file still green.
 */
const skipped = [];

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) { skipped.push(full); continue; }
      walk(full, out);
    } else if (EXTS.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

test.describe('#221 no stray control bytes in source', () => {
  test('every raw C0/DEL byte is one the inventory expects', () => {
    // The WALK's own output is kept apart from the hand-listed FILES, because the coverage
    // assertions below must be about the walk. `FILES` carries `README.md` and `CLAUDE.md`
    // unconditionally, so a `.md` check over the combined list passes even when the walk
    // covers no markdown at all — measured, not guessed: that is exactly what the first
    // version of this did.
    // `skipped` is module-level because `walk` is, so it ACCUMULATES across calls. Across
    // the six roots below that is exactly right - the union is what the assertion wants -
    // but a Playwright retry, or a second test added to this file later, would append to a
    // list that already held the previous run's entries. It could never produce a false
    // RED (duplicates of an empty set are still empty), only a confusing report on the day
    // it legitimately fires. Cleared here so the array means "this run", not "every run".
    skipped.length = 0;
    const walked = [];
    for (const d of DIRS) walk(path.join(ROOT, d), walked);
    const targets = walked.concat(FILES.map((f) => path.join(ROOT, f)));

    // EVERY NAMED FILE MUST EXIST, asserted rather than assumed. The scan below
    // swallows a read failure with `catch { continue; }`, which is right for a file
    // that vanishes mid-walk but wrong for this hand-written list: a renamed or
    // mistyped entry would simply stop being scanned, and — unlike a DIRS entry, whose
    // loss shows up as an allowlist entry going stale in the whole-map comparison —
    // there is nothing left behind to notice. An inventory gate that silently covers
    // less is the failure this whole file exists to prevent, so it must not have that
    // shape itself. Caught in review.
    for (const f of FILES) {
      expect(fs.existsSync(path.join(ROOT, f)),
        `control-bytes FILES names "${f}", which does not exist — the scan would skip `
          + 'it silently. Fix the name, or drop it if the file is genuinely gone.')
        .toBe(true);
    }

    // EVERY NAMED DIRECTORY TOO (#259). The comment above argues a lost DIRS entry shows
    // up as an allowlist entry going stale — true of `tests`, `lib` and `scripts`, which
    // each own one, and FALSE of `docs` and the two companion trees, which own none. A
    // rename there would quietly reduce the gate to its old scope with every test still
    // green, which is precisely the defect #259 filed. `walk` swallows a failed
    // readdirSync by design, so nothing downstream can notice.
    for (const d of DIRS) {
      expect(fs.existsSync(path.join(ROOT, d)),
        `control-bytes DIRS names "${d}", which does not exist — the walk would cover `
          + 'nothing there and say nothing about it.').toBe(true);
    }

    // EVERY NAMED THING MUST ACTUALLY CONTRIBUTE, which a single aggregate floor does not
    // check. Found in review of #261: with one floor at 300, deleting `.md` from EXTS
    // leaves 367 targets and deleting `'docs'` from DIRS leaves 367 — both comfortably
    // green. The floor only ever guarded the companion, because the Dart tree is the one
    // big enough to cross it alone. So it protected ONE of the two trees #259 widened to,
    // and the docs half — the half with 16 files — could have been reverted in silence.
    //
    // A bigger number is not the fix; it would be the fixed bet this repo keeps paying
    // for. The predicate is per-entry: every tree and every file type #259 widened to must
    // actually contribute at least one scanned file.
    //
    // THE REQUIRED SCOPE IS DECLARED SEPARATELY FROM `EXTS`/`DIRS`, and that is the whole
    // point rather than a duplication slip. The first cut of this looped over `EXTS`
    // itself — which cannot catch a DELETED entry, because the loop shrinks with the thing
    // it is checking. Deleting `.md` left the new check green and was caught only
    // incidentally, by `docs` (all-markdown) then walking to zero. Had anyone ever added a
    // `.js` file to `docs/`, that accident would evaporate and both halves would pass.
    // A check derived from its own subject asserts nothing; these two lists are the
    // independent statement of what #259 bought.
    const REQUIRED_EXTS = ['.js', '.md', '.dart'];
    const REQUIRED_DIRS = ['tests', 'lib', 'scripts', 'docs', 'ai-terminal/lib', 'ai-terminal/test'];

    // A COPY IS TOLERABLE ONLY WITH A GATE, and without this pair these two lists rot in
    // one direction: DELETING from DIRS/EXTS goes red (that is the point), but ADDING to
    // them without mirroring leaves the new tree or extension unguarded forever, silently
    // — the same shape as the omission #259 was filed for. Set equality keeps the two
    // declarations independent, which is what makes the checks above mean anything, while
    // forcing an edit to either to be a conscious edit to both.
    expect(new Set(REQUIRED_DIRS),
      'DIRS and REQUIRED_DIRS have drifted — a directory added to the scan with nothing '
        + 'asserting it contributes, or removed from one list only.').toEqual(new Set(DIRS));
    expect(new Set(REQUIRED_EXTS),
      'EXTS and REQUIRED_EXTS have drifted — an extension added to the scan with nothing '
        + 'asserting it matches anything, or removed from one list only.').toEqual(new Set(EXTS));

    for (const x of REQUIRED_EXTS) {
      expect(walked.filter((f) => f.endsWith(x)).length,
        `#259 widened the control-byte scan to "${x}" files and the WALK found NONE — the `
          + 'extension has been dropped from EXTS or skipped out of the walk. (Counted over '
          + 'the walk alone: FILES lists two .md files by hand and would mask this.)')
        .toBeGreaterThan(0);
    }
    for (const d of REQUIRED_DIRS) {
      // ASK WHAT THE SCAN ACTUALLY COLLECTED, never re-walk the directory here. A fresh
      // `walk(ROOT/d)` answers "does this tree contain files", which stays true after the
      // entry is deleted from DIRS — so the check would pass through the exact regression
      // it names. Measured: dropping `'docs'` left a re-walking version green.
      const prefix = path.join(ROOT, d) + path.sep;
      expect(walked.filter((f) => f.startsWith(prefix)).length,
        `#259 widened the control-byte scan to "${d}" and the scan collected NOTHING from `
          + 'it — the entry has been dropped from DIRS, renamed, or skipped out of the walk.')
        .toBeGreaterThan(0);
    }

    // NOTHING UNDER A NAMED ROOT MAY BE SKIPPED. This is the assertion that covers
    // SKIP_DIRS, and the floor below provably does NOT — measured in review of #261: the
    // floor trips only once 93 of the 393 targets are gone, while the entire universe of
    // subdirectory names that could be added to SKIP_DIRS is worth 83 files. Adding EVERY
    // one of them at once leaves it green, and `SKIP_DIRS.add('rig')` alone drops 28 files
    // from the most escape-sequence-heavy tree in the repo with every check passing. The
    // comment here used to call the floor "a coarse backstop" for exactly this case; it
    // could not do that job, which is this PR's own defect — a claim of coverage nothing
    // delivers — sitting inside its fix.
    //
    // Not a number. `walk` now records what it declined to enter, and today that list is
    // EMPTY beneath these roots (none of the six SKIP_DIRS names occurs under them), so
    // the honest assertion is exactly that.
    const skippedUnderRoots = skipped.filter(
      (s) => DIRS.some((d) => s.startsWith(path.join(ROOT, d) + path.sep)),
    );
    expect(skippedUnderRoots,
      'the control-byte walk skipped a directory INSIDE one of its own roots, so the scan '
        + 'silently covers less than DIRS claims. Either the skip is wrong, or this gate '
        + 'needs to say so out loud.').toEqual([]);

    // The floor is kept only as a crude tripwire for gross shrinkage — a root emptied, a
    // walk that stops walking. It is NOT the SKIP_DIRS guard; the assertion above is.
    // 393 targets today: 383 from the walk (229 .js + 138 .dart + 16 .md) plus the 10
    // hand-listed FILES.
    expect(targets.length,
      'the control-byte scan covers far fewer files than #259 measured — an extension or '
        + 'a directory has stopped being walked.').toBeGreaterThan(300);

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

    // AN INVENTORY GATE DEGRADES BY GROWING, and the comparison above cannot see it: add a
    // control byte AND an allowlist entry for it in the same change, and both sides move
    // together with nothing to complain. So the SIZE is pinned separately — raising it is a
    // second, deliberate edit, and it is the first number a reviewer should look at.
    const totalAllowed = Object.values(ALLOWED)
      .reduce((n, spec) => n + Object.values(spec.counts).reduce((a, b) => a + b, 0), 0);
    expect(Object.keys(ALLOWED).length,
      'a FILE was added to the control-byte allowlist. That is allowed, and it is meant to '
        + 'be noticed: say in the entry why the raw byte is the subject there, then update '
        + 'this number.').toBe(3);
    expect(totalAllowed,
      'the number of allowed control bytes changed. Every one is a hole; confirm each is '
        + 'still deliberate, then update this number.').toBe(6);
  });
});
