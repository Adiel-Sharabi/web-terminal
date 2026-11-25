#!/usr/bin/env node
'use strict';
// Which build is a web-terminal server running RIGHT NOW? Answers from the server's own
// /api/version (hash + date, fixed when the process started - lib/build-id.js), so it
// proves a reload really took the new code. The release number does not move per change,
// so it cannot prove that; the hash can.
//
//   node scripts/wt-build.js                    # this machine: print the running build
//   node scripts/wt-build.js --head             # ... and fail unless it is this checkout's HEAD
//   node scripts/wt-build.js --expect <hash>    # ... and fail unless it is <hash>
//   node scripts/wt-build.js <peer> [...]       # a cluster peer (url or name in cluster-tokens.json)
//
// Exit: 0 = answered (and matches, when asked) - 1 = answered, a DIFFERENT build - 2 = could
// not ask (no token, unreachable, not a web-terminal). Credential and transport: wt-api.js.

const { execFileSync } = require('child_process');
const { ROOT, target, call } = require('./wt-api');
const { sameBuild } = require('../lib/build-id');

function headOfCheckout() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function main(argv) {
  let peer = null;
  let expect = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--head') expect = headOfCheckout();
    else if (argv[i] === '--expect') expect = argv[++i] || '';
    else if (!argv[i].startsWith('--')) peer = argv[i];
    else { console.error(`unknown option ${argv[i]}`); return 2; }
  }
  if (expect !== null && !/^[0-9a-f]{7,40}$/i.test(expect)) {
    console.error(`not a commit hash: "${expect}"`);
    return 2;
  }
  let r;
  try {
    r = await call(target(peer), 'GET', '/api/version');
  } catch (e) {
    console.error(`could not ask: ${e.message}`);
    return 2;
  }
  const v = r.json || {};
  if (r.status !== 200 || typeof v.hash !== 'string') {
    console.error(`could not read the build (HTTP ${r.status})`);
    return 2;
  }
  console.log(`running build ${v.hash} of ${v.date || 'an unknown date'} (release ${v.version})`);
  if (expect === null) return 0;
  if (sameBuild(v.hash, expect)) {
    console.log(`matches ${expect.slice(0, v.hash.length)}`);
    return 0;
  }
  console.log(`does NOT match ${expect.slice(0, 12)}: the server is running other code than that commit`);
  return 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
module.exports = { main };
