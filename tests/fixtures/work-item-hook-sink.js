#!/usr/bin/env node
'use strict';
// #413 - a stand-in for the configured work-item command (the AM8 `wi-flow` CLI in real
// use). It writes what it was handed on stdin to a file in the directory named by argv[2],
// so a spec can read back exactly the payload the server sent. argv[3] = 'slow' sleeps
// past any sane timeout; 'fail' exits 3 after writing.
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const mode = process.argv[3] || '';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  if (mode === 'slow') { setTimeout(() => process.exit(0), 60000); return; }
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(dir, name), raw);
  process.exit(mode === 'fail' ? 3 : 0);
});
