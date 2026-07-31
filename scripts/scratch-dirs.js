#!/usr/bin/env node
'use strict';
// SSOT for the generated, disposable trees this repo's tooling creates OUTSIDE the
// production checkout (#80).
//
// WHY THEY LIVE OUTSIDE THE REPO AT ALL — this is deliberate, not sloppiness:
//   * rig.js's orphan sweep identifies rig processes by the rig directory's name, which
//     only works while that name cannot appear in a production command line;
//   * the Flutter build scripts write a STRIPPED copy of the tree (Firebase bits removed)
//     and must not do that inside the checkout they copied from.
// So "move them into the repo" is the wrong fix. The right one is to stop them littering
// C:\dev as siblings of real repos, and to make their disposability obvious — hence one
// clearly-scratch parent, and one place that decides where it is.
//
// WHY THE BASENAMES ARE PRESERVED. The obvious layout — .wt-scratch/{rig,winbuild,probe} —
// silently breaks rig.js's safety property. That sweep globs process command lines for
// `*<basename(RIG)>*`; with a basename of `rig` it would match any path containing "rig"
// and could kill unrelated node processes. Keeping `wt-rig` keeps the glob as specific as
// it was, and `wt-rig` still cannot occur inside `web-terminal`. Do not "tidy" these names.
//
// Every entry stays individually overridable by env var, so an existing WT_RIG_DIR keeps
// working and a machine that wants its scratch on another drive can say so once.
//
//   node scripts/scratch-dirs.js            # print all, as `name<TAB>path`
//   node scripts/scratch-dirs.js rig        # print one (Windows form)
//   node scripts/scratch-dirs.js winbuild --posix   # /c/dev/... form, for bash

const path = require('path');
const os = require('os');

/** Parent of every generated tree. Dot-prefixed so it sorts away from real repos. */
const PARENT = process.env.WT_SCRATCH_DIR
  || (process.platform === 'win32'
    ? 'C:\\dev\\.wt-scratch'
    : path.join(os.homedir(), '.wt-scratch'));

const DIRS = Object.freeze({
  /** Isolated web-terminal instance (scripts/rig/rig.js). */
  rig: process.env.WT_RIG_DIR || path.join(PARENT, 'wt-rig'),
  /** Stripped Flutter tree for the release Windows build. */
  winbuild: process.env.WT_WINBUILD_DIR || path.join(PARENT, 'ai-terminal-winbuild'),
  /** Stripped Flutter tree for the input-probe build. */
  probe: process.env.WT_PROBE_DIR || path.join(PARENT, 'ai-terminal-probe'),
});

/** `C:\dev\x\y` -> `/c/dev/x/y`, the form Git Bash needs. */
function toPosix(p) {
  return p.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
}

function main(argv) {
  const posix = argv.includes('--posix');
  const name = argv.find((a) => !a.startsWith('--'));
  const fmt = (p) => (posix ? toPosix(p) : p);

  if (!name) {
    for (const [k, v] of Object.entries(DIRS)) console.log(`${k}\t${fmt(v)}`);
    return 0;
  }
  if (!(name in DIRS)) {
    console.error(`unknown scratch dir '${name}' — known: ${Object.keys(DIRS).join(', ')}`);
    return 1;
  }
  console.log(fmt(DIRS[name]));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { PARENT, DIRS, toPosix };
