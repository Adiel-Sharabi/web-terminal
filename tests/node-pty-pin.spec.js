// @ts-check
// #418 - node-pty is pinned EXACTLY to 1.1.0, and this gate keeps it there.
//
// Pure: reads package.json and package-lock.json only (no webServer, no PTY).
//
// Why not 1.2: every 1.2 build (1.2.0-beta.13..18 measured, 2026-11-09) bundles ConPTY
// 1.25.2603.03002. That ConPTY sends a cursor-position query (ESC[6n) on EVERY resize and
// withholds the shell's input until a terminal answers it. Each attached xterm answers, so
// two viewers double-answer and the extra reply is typed into the shell (the next command
// ran as `3Recho`); with no viewer, typed input is held and never ran. 1.2 also sets
// term.pid ~50 ms after spawn (0 before). Upgrading needs a worker-side CPR plan first -
// see docs/findings/input-submit.md (#418). The caret this replaces (`^1.0.0`) would let a
// fresh install pick up a stable 1.2 with all of that.
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const PIN = '1.1.0';
const WHY = 'node-pty must stay pinned EXACTLY to ' + PIN + ' (#418): 1.2.x bundles ConPTY 1.25, '
  + 'which sends ESC[6n on every resize and withholds input until answered - two xterms '
  + 'double-answer (junk typed into the shell), none holds input - and term.pid is 0 for '
  + '~50 ms after spawn. Upgrading needs a worker-side CPR plan first; see '
  + 'docs/findings/input-submit.md #418.';

const ROOT = path.join(__dirname, '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

test.describe('#418 node-pty pin', () => {
  test('package.json pins node-pty exactly to 1.1.0 (no range)', () => {
    expect(readJson('package.json').dependencies['node-pty'], WHY).toBe(PIN);
  });

  test('package-lock.json resolves node-pty to 1.1.0, root spec included', () => {
    const lock = readJson('package-lock.json');
    expect(lock.packages[''].dependencies['node-pty'], WHY).toBe(PIN);
    expect(lock.packages['node_modules/node-pty'].version, WHY).toBe(PIN);
    expect(lock.packages['node_modules/node-pty'].resolved, WHY)
      .toBe('https://registry.npmjs.org/node-pty/-/node-pty-' + PIN + '.tgz');
  });
});
