'use strict';
// A stand-in for `claude -p` for the check-in pre-check specs (#540). The suite never calls the real
// model.
//   1. reads all of stdin (the prompt);
//   2. records it to FAKE_PRECHECK_DIR/run-<pid>-<ms>.json: stdin, argv, cwd, env NAMES;
//   3. answers as FAKE_PRECHECK_DIR/mode.json says (default `wake`):
//        { mode:'wake'|'skip'|'tell', reason? }   the verdict, wrapped as claude does
//        { mode:'bad' }                           prose that is not JSON
//        { mode:'verdict', verdict:'x' }          a JSON object whose verdict is not one of the three
//        { mode:'exit1' }                         exits non-zero
//        { mode:'sleep', ms }                     waits before answering (a timeout test)
//      any mode may add { delayMs } to hold a run in flight.

const fs = require('fs');
const path = require('path');

const dir = process.env.FAKE_PRECHECK_DIR;
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  let mode = { mode: 'wake' };
  try { mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8')); } catch { /* default */ }
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `run-${process.pid}-${Date.now()}.json`), JSON.stringify({
      pid: process.pid, stdin, argv: process.argv.slice(2), cwd: process.cwd(), envNames: Object.keys(process.env), mode,
    }));
  }
  const wrap = (obj) => process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(obj) }));
  const answer = () => {
    if (mode.mode === 'exit1') process.exit(1);
    if (mode.mode === 'bad') return process.stdout.write(JSON.stringify({ is_error: false, result: 'It seems fine, I would leave it.' }));
    if (mode.mode === 'verdict') return wrap({ verdict: mode.verdict, reason: 'a made-up verdict' });
    const verdict = mode.mode === 'skip' || mode.mode === 'tell' ? mode.mode : 'wake';
    return wrap({ verdict, reason: mode.reason || `fake ${verdict}` });
  };
  setTimeout(answer, (mode.mode === 'sleep' ? mode.ms : 0) + (mode.delayMs || 0));
});
