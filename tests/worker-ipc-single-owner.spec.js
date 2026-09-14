// @ts-check
// #262 - THE GATE THAT KEEPS THE HARNESS SINGULAR.
//
// This repo's own rule: "a new rule ships with its test/lint/CI gate. A rule with no gate
// is violated within weeks." #262 exists because that did not happen the first time - one
// `rpc()` was pasted into 23 spec files with five different deadlines, and the copies were
// added one at a time by people doing something else, each of whom was right that their
// file needed an IPC harness.
//
// NO BEHAVIOURAL TEST CAN SEE THIS. A 24th private copy with its own 3000ms budget would
// leave every test in the repo green and reintroduce the exact failure mode #253, #254 and
// #262 each had to diagnose separately: a different spec going red on each loaded run,
// which reads as flake and gets written off. So the assertion is against the SOURCE, the
// same shape as `tests/app-input-path.spec.js` (the input funnel) and
// `tests/legacy-route-redirect.spec.js` (the unserved page).
//
// WHAT IT DOES NOT COVER, said rather than implied: it matches the DECLARATION, so it
// catches the copy-paste this issue is about and would not catch someone rebuilding the
// same thing under a different name. That is the honest limit of a source gate, and it is
// still worth more than nothing, because the failure it guards is specifically a pasted
// duplicate of a function that already exists.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OWNER = 'worker-ipc.js';
/** This gate spec itself - see the caller scan below for why it is excluded there. */
const SELF = 'worker-ipc-single-owner.spec.js';

/** SENTINELS - see the positive controls below. Named files, not counts. */
const SENTINEL_CALLER = 'worker-kill.js';      // calls rpc(client, ...) and is NOT a .spec.js
const SENTINEL_SPEC = 'worker-basic.spec.js';  // an ordinary migrated worker spec

/**
 * EVERY .js in tests/, not just .spec.js - minus the owner, which defines these on
 * purpose. The `.spec.js` filter that stood here was a real hole: `tests/worker-kill.js`
 * (the one file that historically took `rpc` as a PARAMETER) and `tests/test-helpers.js`
 * were scanned by neither test, and a shared helper is exactly where a 24th private copy
 * would naturally be pasted. Caught in review.
 */
function testFiles() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.js') && f !== OWNER);
}

test.describe('#262: one owner for the worker IPC harness', () => {
  test('no spec declares its own rpc() or connectClient()', () => {
    const offenders = [];
    const files = testFiles();

    for (const f of files) {
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(?:async\s+)?function\s+(?:rpc|connectClient)\s*\(/.test(line)) {
          offenders.push(`${f}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    // THE POSITIVE CONTROL. A gate that scans nothing is indistinguishable from a gate
    // that passes (#260's lesson, and #262's own first measurement was exactly this
    // defect - a body comparison that could not fail).
    //
    // IT IS A SENTINEL, NOT A COUNT. This was `files.length > 20` against a real 149,
    // which would have survived 129 files vanishing - and its sibling below was `> 20`
    // against a real 23, three from going RED with a message that would have been false.
    // A threshold nobody re-measures is the fixed-timeout bet this repo keeps paying for,
    // in count form. Naming two files that must be there says the same thing without
    // betting a number: if either is legitimately renamed, this fails LOUDLY and the fix
    // is to update the sentinel, which is a decision someone makes rather than a drift.
    expect(files, `the scan must cover ordinary specs - is ${SENTINEL_SPEC} renamed?`)
      .toContain(SENTINEL_SPEC);
    expect(files, `the scan must cover NON-spec helpers too - is ${SENTINEL_CALLER} renamed?`)
      .toContain(SENTINEL_CALLER);

    expect(offenders,
      `a private IPC harness is back. Import it from ./${OWNER} instead — 23 copies with `
      + 'five different deadlines is what #262 removed, and the deadline is the part that '
      + 'drifts. A genuinely different budget belongs at the CALL SITE with its measurement.')
      .toEqual([]);
  });

  test('the owner exists and every worker spec that talks IPC imports it', () => {
    const ownerPath = path.join(DIR, OWNER);
    expect(fs.existsSync(ownerPath), `${OWNER} is the single owner and must exist`).toBe(true);

    const owner = require('./worker-ipc');
    expect(typeof owner.rpc, 'the owner must export rpc').toBe('function');
    expect(typeof owner.connectClient, 'the owner must export connectClient').toBe('function');
    expect(Number.isFinite(owner.RPC_BUDGET_MS),
      'the budget is the fact this module exists to own').toBe(true);

    // Anything that calls rpc(...) must be getting it from the owner. This is the other
    // half of the gate: the first test stops a redeclaration, this one stops a spec from
    // quietly reaching for some other implementation.
    const importers = [];
    const callers = [];
    for (const f of testFiles()) {
      // THIS FILE IS EXCLUDED FROM THE CALLER SCAN, and the reason generalises: a gate
      // spec necessarily WRITES THE PATTERN IT SEARCHES FOR. This one matched itself
      // until review caught it - first through the comment explaining that prose should
      // not count, and, after that comment was rewritten, still through its own two
      // assertion MESSAGES, which spell out the call so a failure reads clearly. Chasing
      // spellings is whack-a-mole; the describing file is simply not one of the files
      // being described. It inflated the control below from 23 to 24, and left this spec
      // out of its own offender list only because it requires the owner for the export
      // assertions - so the pass hung on an unrelated line.
      if (f === SELF) continue;
      const src = fs.readFileSync(path.join(DIR, f), 'utf8');
      // Spelling-tolerant on purpose: single or double quotes, with or without the `.js`
      // suffix. The literal `includes("require('./worker-ipc')")` that stood here would
      // have called a legitimate double-quoted import a non-importing caller and gone RED
      // with a message that was false. No `quotes` rule is configured in eslint.config.js,
      // so nothing else would have stopped it.
      const imports = /require\(\s*['"]\.\/worker-ipc(?:\.js)?['"]\s*\)/.test(src);
      // Comment LINES are stripped as well, so a spec that merely MENTIONS the call in a
      // comment is not dragged in as a caller. (A trailing comment on a code line is not
      // stripped - that line carries code too, so counting it is not wrong in that way.)
      const code = src.split(/\r?\n/)
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
        .join('\n');
      const calls = /(?:^|[^.\w])rpc\(\s*client/m.test(code);
      if (imports) importers.push(f);
      if (calls) callers.push(f);
    }

    // POSITIVE CONTROL, again a sentinel rather than a count - and this one does double
    // duty: SENTINEL_CALLER is NOT a `.spec.js`, so it can only be found if the widened
    // scan from finding 5 is actually in effect. Revert that filter and this goes red.
    expect(callers, `${SENTINEL_CALLER} calls rpc(client, ...) - if this fails the scan is `
      + 'not reaching non-spec files, or the sentinel moved').toContain(SENTINEL_CALLER);
    expect(callers.filter((f) => !importers.includes(f)),
      'these call rpc(client, …) without importing the owner').toEqual([]);
  });
});
