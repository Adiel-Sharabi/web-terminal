#!/usr/bin/env node
'use strict';
// Start-of-run reset for the per-run test state files (#240, #272).
//
// Runs as the FIRST HALF of the Playwright `webServer.command`
// (`node scripts/reset-test-run-files.js && node server.js`), and only there:
//
//  * A real run is the ONLY thing that executes a webServer command. A listing
//    (`playwright test --list`, the VS Code extension re-listing on save) loads
//    `playwright.config.js` but never launches the server, so it can no longer
//    delete anything. When the delete lived at config module scope, a listing
//    during a live run emptied the token store under it: `loadApiTokens()` then
//    read `{}` on its next refresh and every token minted so far stopped working.
//  * Workers never run it either, so a worker restarted after a failing test
//    cannot delete mid-run (the reason an earlier cut gated on TEST_WORKER_INDEX).
//  * `&&` orders it BEFORE `server.js` reads either file - #240's requirement:
//    plugin setup (where the webServer lives) runs before globalSetup, so by
//    then the server has already read whatever the last run left.
//
// The files:
//  * `config.test.json` (#240) - the path `server.js` derives under `WT_TEST`.
//    Deleting it puts the run where a fresh CI checkout is; the specs that need
//    config recreate it through `PUT /api/config`.
//  * the API token store at `WT_API_TOKENS_FILE` (#272) - set by
//    `playwright.config.js`, inherited through the webServer env. A token minted
//    by one run must not still authenticate in the next.
//
// REFUSES to touch a production file. This script deletes by path, and the token
// path comes from the environment; a mis-set variable must not be able to turn a
// test reset into the deletion of the real credential store or the real config.
const fs = require('fs');
const path = require('path');

// `WT_RESET_ROOT` exists ONLY so tests/api-tokens-isolation.spec.js can drive the refusal
// against a scratch tree holding a FAKE api-tokens.json. A refusal test pointed at the
// real checkout would delete the real store the day the refusal broke.
const CHECKOUT = path.join(__dirname, '..');
const ROOT = process.env.WT_RESET_ROOT ? path.resolve(process.env.WT_RESET_ROOT) : CHECKOUT;
// The production files of BOTH trees are refused, so the override can widen what is
// protected but never narrow it: setting WT_RESET_ROOT elsewhere does not make the real
// checkout's store deletable.
const PRODUCTION = new Set([CHECKOUT, ROOT].flatMap((dir) =>
  ['api-tokens.json', 'config.json', 'cluster-tokens.json'].map((f) => path.resolve(dir, f).toLowerCase())));

function reset(file, issue) {
  const abs = path.resolve(ROOT, file);
  if (PRODUCTION.has(abs.toLowerCase())) {
    console.error(`[test-reset] REFUSED: ${path.basename(abs)} is a production file (${issue})`);
    process.exitCode = 1;
    return;
  }
  try {
    fs.unlinkSync(abs);
    // stderr, not stdout: Playwright discards a webServer's stdout and forwards its stderr.
    console.error(`[test-reset] removed ${path.basename(abs)} left by an earlier run (${issue})`);
  } catch (e) {
    // ENOENT is the normal case (CI, or a run that cleaned up). Anything else is worth
    // seeing rather than swallowing - a locked file would silently reinstate the leak.
    if (e.code !== 'ENOENT') console.warn(`[test-reset] could not remove ${path.basename(abs)}:`, e.message);
  }
}

if (process.env.WT_TEST !== '1') {
  // Only ever meaningful inside the suite's webServer, which sets WT_TEST=1.
  console.error('[test-reset] WT_TEST is not 1 - refusing to reset anything');
  process.exit(1);
}
reset('config.test.json', '#240');
if (process.env.WT_API_TOKENS_FILE) reset(process.env.WT_API_TOKENS_FILE, '#272');
else {
  console.error('[test-reset] WT_API_TOKENS_FILE is not set - the server would mint into production');
  process.exitCode = 1;
}
// Below the guard, not between it and its `if`: #298 once landed there, which hung the
// #272 refusal off the briefs file instead of the token store.
if (process.env.WT_SESSION_BRIEFS_FILE) reset(process.env.WT_SESSION_BRIEFS_FILE, '#298');
if (process.env.WT_DEVICE_OPS_FILE) reset(process.env.WT_DEVICE_OPS_FILE, '#311');
