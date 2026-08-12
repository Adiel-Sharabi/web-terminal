#!/usr/bin/env node
'use strict';
// Bump SERVER_VERSION in server.js.
//
// Why a script for a one-line edit: SERVER_VERSION sits on a ~280KB SINGLE line, so
// every hand-editing route (read the file, diff it, sed it interactively) either drowns
// a reviewer or an agent's context in one unreadable line. This touches the version
// literal and nothing else.
//
//   node scripts/bump-server-version.js            # patch bump
//   node scripts/bump-server-version.js minor
//   node scripts/bump-server-version.js 1.60.0     # explicit
//   node scripts/bump-server-version.js --check     # print the current version only
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'server.js');
const RE = /(SERVER_VERSION = ')(\d+\.\d+\.\d+)(')/;

function next(cur, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [maj, min, pat] = cur.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function main() {
  const src = fs.readFileSync(FILE, 'utf8');
  const m = RE.exec(src);
  if (!m) {
    console.error('SERVER_VERSION not found in server.js');
    process.exit(1);
  }
  const cur = m[2];
  const arg = process.argv[2];
  if (arg === '--check') {
    console.log(cur);
    return;
  }
  const to = next(cur, arg || 'patch');
  fs.writeFileSync(FILE, src.replace(RE, `$1${to}$3`), 'utf8');
  console.log(`SERVER_VERSION ${cur} -> ${to}`);
}

if (require.main === module) main();
module.exports = { next };
