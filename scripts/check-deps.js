#!/usr/bin/env node
'use strict';

// Runtime-dependency preflight — the gate that stops a cold restart from turning a
// half-broken box into a dead one.
//
// Why this exists (2026-07-30, Home): production's node_modules was gutted the previous
// evening when a session junctioned a temp worktree's node_modules to the REAL one
// (`mklink /J`) and then tore that worktree down — `rmdir /s` and `git worktree remove
// --force` both follow a directory junction and delete the target. express, express-ws
// and node-pty's package.json/lib went with it. Nothing noticed for 21 hours, because a
// running Node process serves already-loaded modules from memory: server.js kept
// answering HTTP 200 and the worker kept streaming PTYs. The damage surfaced only when
// something had to load from disk — first as a pty.spawn that never returned (blocking
// the worker's event loop, so every IPC RPC timed out at 30s), and then, fatally, on the
// cold restart: the fresh worker could not `require('node-pty')`, exited 1 in 0.3s five
// times, and the monitor burned its crash budget and exited — taking server.js with it.
//
// So the check must run BEFORE anything is killed. A wedged worker still holds live PTYs;
// a monitor that gave up holds nothing.
//
// Resolution alone is not enough: `require.resolve` succeeds on a package whose native
// binding is broken. These are loaded for real.

const REQUIRED_MODULES = ['node-pty', 'express', 'express-ws'];

// `load` is injectable so the failure path is testable without breaking a real tree.
function checkDeps(load) {
  const loader = load || ((name) => require(name));
  const missing = [];

  for (const name of REQUIRED_MODULES) {
    try {
      loader(name);
    } catch (err) {
      missing.push({
        name,
        code: (err && err.code) || 'LOAD_FAILED',
        message: (err && err.message) || String(err),
      });
    }
  }

  return { ok: missing.length === 0, missing };
}

module.exports = { REQUIRED_MODULES, checkDeps };

if (require.main === module) {
  const { ok, missing } = checkDeps();

  if (ok) {
    console.log(`deps OK (${REQUIRED_MODULES.join(', ')})`);
    process.exit(0);
  }

  for (const m of missing) console.error(`MISSING ${m.name}: ${m.code}`);
  // The worker holds node-pty's OpenConsole.exe open, so an install while it runs is what
  // leaves a half-extracted tree in the first place. Stop it first.
  console.error('Run `npm install` with the pty-worker STOPPED, then retry.');
  process.exit(1);
}
