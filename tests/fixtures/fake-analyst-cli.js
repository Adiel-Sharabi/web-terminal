'use strict';
// A stand-in for `claude -p` for the Mission Control Ask specs (#511). The suite never calls
// the real model.
//   1. reads all of stdin (the prompt);
//   2. records it to FAKE_ANALYST_DIR/run-<pid>-<ms>.json: stdin, argv, cwd, env NAMES;
//   3. answers as FAKE_ANALYST_DIR/mode.json says (default `ok`):
//        { mode:'ok' }     cites every block id it was given, plus one it was NOT given (S999),
//                          wrapped as claude does
//        { mode:'bad' }    prose that is not JSON
//        { mode:'exit1' }  exits non-zero
//        { mode:'sleep', ms }  waits before answering (a timeout test)
//      any mode may add { delayMs } to hold a run in flight.

const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_ANALYST_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  let mode = { mode: 'ok' };
  try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { /* default */ }
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `run-${process.pid}-${Date.now()}.json`), JSON.stringify({
      pid: process.pid, stdin, argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env), mode,
    }));
  }
  const ids = [...stdin.matchAll(/^\s*\[(S\d+)\]/gm)].map((m) => m[1]);
  const answer = () => {
    if (mode.mode === 'exit1') process.exit(1);
    if (mode.mode === 'bad') return process.stdout.write(JSON.stringify({ is_error: false, result: 'Here is what I found, in prose.' }));
    const body = { answer: `Fake answer from ${ids.length} blocks [${ids[0] || 'S0'}].`, sources: [...ids, 'S999'] };
    return process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(body) }));
  };
  setTimeout(answer, (mode.mode === 'sleep' ? mode.ms : 0) + (mode.delayMs || 0));
});
