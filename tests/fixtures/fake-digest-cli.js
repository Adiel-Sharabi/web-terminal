'use strict';
// A stand-in for `claude -p` for the inbox-digest specs (#383). The suite must never call
// the real model: it is slow, billed, and answers differently on every machine.
//
// What it does, in order:
//   1. reads all of stdin (the prompt) - the real CLI is given its prompt there too;
//   2. records what it was run with to FAKE_DIGEST_DIR/run-<pid>-<n>.json: stdin, argv,
//      cwd, the NAMES of its environment variables, and its own pid;
//   3. behaves as FAKE_DIGEST_DIR/mode.json says (default: a good answer):
//        { mode:'ok',    about?: string }   a well-formed digest, wrapped as claude does
//        { mode:'bare' }                    the digest object with no wrapper
//        { mode:'bad' }                     prose that is not JSON
//        { mode:'partial' }                 JSON missing `about`
//        { mode:'iserror' }                 the wrapper's is_error flag set
//        { mode:'exit1' }                   exits non-zero
//        { mode:'sleep', ms }               waits `ms` before answering (a timeout test)
// Every mode may add { delayMs } to wait first, so a test can hold a run in flight.

const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_DIGEST_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  let mode = { mode: 'ok' };
  try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { /* default */ }
  if (dir) {
    const rec = {
      pid: process.pid, stdin, argv: process.argv.slice(2), cwd: process.cwd(),
      envNames: Object.keys(process.env), mode,
    };
    fs.writeFileSync(path.join(dir, `run-${process.pid}-${Date.now()}.json`), JSON.stringify(rec));
  }
  const digest = {
    about: mode.about || 'The agent is changing the build and wants a decision.',
    asking: ['Should the build folder be deleted?'],
    know: ['Deleting it forces a full rebuild.'],
  };
  const answer = () => {
    if (mode.mode === 'exit1') process.exit(1);
    if (mode.mode === 'bad') return process.stdout.write(JSON.stringify({ is_error: false, result: 'Sure! Here is a summary, in prose.' }));
    if (mode.mode === 'partial') return process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify({ asking: ['x'] }) }));
    if (mode.mode === 'iserror') return process.stdout.write(JSON.stringify({ is_error: true, result: JSON.stringify(digest) }));
    if (mode.mode === 'bare') return process.stdout.write(JSON.stringify(digest));
    return process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(digest) }));
  };
  const wait = (mode.mode === 'sleep' ? mode.ms : 0) + (mode.delayMs || 0);
  setTimeout(answer, wait);
});
