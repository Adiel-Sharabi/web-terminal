// Ground truth for AskUserQuestion answering: drive a real `claude` TUI over a
// real PTY and read the verdict from the TRANSCRIPT, never the screen.
//
// Why this exists. Whether a row digit SELECTS, SUBMITS or merely MOVES THE
// HIGHLIGHT depends on the layout Claude picked, and the layout depends on
// whether any option carries a `preview` (side-by-side) or not (compact). The
// screen cannot tell "highlighted" from "submitted", so every verdict here comes
// from the AskUserQuestion `tool_result` written to the session transcript.
//
// Traps this script already handles (each one cost a wrong answer once):
//   * a fresh cwd raises claude's TRUST prompt before the composer — answered
//     off the de-ANSI'd buffer, since raw output is cursor-positioned and the
//     phrase is not contiguous;
//   * spawning as a child inherits CLAUDE_CODE_CHILD_SESSION, which turns
//     transcript writing OFF — so there would be no verdict at all;
//   * the tool render is detected by IDLE RHYTHM, not keywords: the eliciting
//     prompt's own words echo on screen and false-match;
//   * a PENDING question is not in the transcript (the tool_use is written only
//     once answered), so "nothing recorded" and "not yet answered" look alike —
//     assert on which option came back, not on whether a question is pending;
//   * each run gets its OWN temp cwd, or parallel probes read each other's
//     transcripts.
//
// Usage:
//   node scripts/rig/probe-askq-layout.js --shape preview-mq --keys "1,CR,2,3,RIGHT,CR"
//   node scripts/rig/probe-askq-layout.js --shape plain-mq   --keys "1,2,3,RIGHT,CR"
//
// Env: CLAUDE_BIN overrides the claude executable; XTERM_HEADLESS points at an
// @xterm/headless install (optional — without it the screen snapshots are
// skipped, the transcript verdict is unaffected).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pty = require(path.join(__dirname, '..', '..', 'node_modules', 'node-pty'));
const { claudeProjectDirName } = require(path.join(__dirname, '..', '..', 'lib', 'transcript.js'));

// ---------------------------------------------------------------- arguments
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const SHAPE = arg('shape', 'preview-mq');
const KEYS = arg('keys', '').split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(arg('timeout', '150000'));

// ------------------------------------------------------------- claude binary
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // node-pty needs a full exe path on Windows — a bare name or a .cmd shim fails.
  const guess = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(guess)) return guess;
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, ['claude'], { encoding: 'utf8', windowsHide: true });
    const first = out.split(/\r?\n/).find(l => l.trim());
    if (first) return first.trim();
  } catch { /* fall through */ }
  throw new Error('cannot locate the claude executable — set CLAUDE_BIN');
}

// --------------------------------------------------- optional headless screen
const ROWS = 40, COLS = 100;
let term = null;
(function loadTerm() {
  const candidates = [
    process.env.XTERM_HEADLESS,
    '@xterm/headless',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'agor-live', 'node_modules', '@xterm', 'headless'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const { Terminal } = require(c);
      term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
      return;
    } catch { /* try next */ }
  }
  console.log('[probe] no @xterm/headless — screen snapshots disabled (verdict unaffected)');
})();

function screen() {
  if (!term) return '(no headless VT)';
  const b = term.buffer.active;
  const out = [];
  for (let y = 0; y < ROWS; y++) {
    const line = b.getLine(b.baseY + y);
    out.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function deansi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[[\]][0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[=>()][A-Za-z0-9]?/g, '')
    .replace(/[\r\n]+/g, '\n');
}

// ------------------------------------------------------------ eliciting text
// Q1 single-select WITH previews + Q2 multi-select is the exact shape reported
// broken on 2026-08-03 (Q1 3 options all with previews, Q2 multiSelect with 4).
const SHAPES = {
  'preview-mq':
    'Call the AskUserQuestion tool RIGHT NOW, in ONE call, and do nothing else first. ' +
    'EXACTLY two questions. Q1: header "Color", question "Pick a color", single-select, ' +
    'three options "Red", "Green", "Blue" and EVERY option MUST have a non-empty "preview" ' +
    'field containing a few lines of example text. Q2: header "Fruit", question "Pick fruits", ' +
    'multiSelect true, four options "Apple", "Banana", "Cherry", "Date" with NO preview field. ' +
    'Do not run any other tool and do not say anything before calling it.',
  'plain-mq':
    'Call the AskUserQuestion tool RIGHT NOW, in ONE call, and do nothing else first. ' +
    'EXACTLY two questions and NO option may have a "preview" field. Q1: header "Color", ' +
    'question "Pick a color", single-select, three options "Red", "Green", "Blue". ' +
    'Q2: header "Fruit", question "Pick fruits", multiSelect true, four options "Apple", ' +
    '"Banana", "Cherry", "Date". Do not run any other tool and do not say anything first.',
  'preview-single':
    'Call the AskUserQuestion tool RIGHT NOW, in ONE call, and do nothing else first. ' +
    'EXACTLY one question: header "Color", question "Pick a color", single-select, three ' +
    'options "Red", "Green", "Blue", and EVERY option MUST have a non-empty "preview" field ' +
    'containing a few lines of example text. Do not run any other tool or say anything first.',
  // Compact single-select, ONE question — the layout the shipped 'Other' (#36) and
  // 'note' (#64 Gap 1) branches are gated to. The note byte sequence has never been
  // device-verified; this is the shape that verifies it.
  'plain-single':
    'Call the AskUserQuestion tool RIGHT NOW, in ONE call, and do nothing else first. ' +
    'EXACTLY one question and NO option may have a "preview" field: header "Color", ' +
    'question "Pick a color", single-select, three options "Red", "Green", "Blue". ' +
    'Do not run any other tool and do not say anything first.',
  // Single multi-select — to settle whether its trailing row is a free-text input or
  // a plain checkbox (the recorded reason 'Other' is deferred for multi-select).
  'plain-multi':
    'Call the AskUserQuestion tool RIGHT NOW, in ONE call, and do nothing else first. ' +
    'EXACTLY one question and NO option may have a "preview" field: header "Fruit", ' +
    'question "Pick fruits", multiSelect true, four options "Apple", "Banana", ' +
    '"Cherry", "Date". Do not run any other tool and do not say anything first.',
  // Two SINGLE-select questions, no previews — the shape that exercises "Other"
  // on the LAST tab of a multi-question prompt. plain-mq cannot: its Q2 is
  // multi-select, where the free-text row is a checkbox and Other is never
  // offered. Advancing past the final tab is what lands on the Submit review.
  'plain-mq2':
    'Call the AskUserQuestion tool RIGHT NOW, in ONE call, and do nothing else first. ' +
    'EXACTLY two questions, both single-select, and NO option may have a "preview" ' +
    'field. Q1: header "Color", question "Pick a color", three options "Red", ' +
    '"Green", "Blue". Q2: header "Size", question "Pick a size", three options ' +
    '"Small", "Medium", "Large". Do not run any other tool or say anything first.',
};
if (!SHAPES[SHAPE]) throw new Error('unknown --shape ' + SHAPE + ' (have: ' + Object.keys(SHAPES).join(', ') + ')');

const TOK = {
  TAB: '\t', CR: '\r', SPACE: ' ', ESC: '\x1b',
  UP: '\x1b[A', DOWN: '\x1b[B', RIGHT: '\x1b[C', LEFT: '\x1b[D',
};
const keyBytes = t => (TOK[t] !== undefined ? TOK[t] : t);

// ------------------------------------------------------------------- run it
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'askq-'));
const childEnv = { ...process.env };
delete childEnv.CLAUDE_CODE_CHILD_SESSION; // else the transcript is never written
delete childEnv.CLAUDE_CODE_SESSION_ID;
delete childEnv.CLAUDE_CODE_ENTRYPOINT;

const p = pty.spawn(resolveClaude(), ['--dangerously-skip-permissions'], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env: childEnv,
});

let buf = '';
let lastData = Date.now();
let state = 'trust';
let elicitAt = 0;
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);

p.onData(d => {
  buf += d;
  if (term) term.write(d);
  lastData = Date.now();
  if (state === 'trust' && /trust/i.test(deansi(buf))) {
    state = 'trusting';
    setTimeout(() => {
      p.write('\r');
      state = 'settle';
      buf = '';
      console.log('[' + stamp() + '] trust accepted');
    }, 500);
  }
});

const tick = setInterval(() => {
  if (state === 'settle' && Date.now() - lastData > 2500) {
    state = 'awaiting-tool';
    elicitAt = Date.now();
    console.log('[' + stamp() + '] eliciting shape=' + SHAPE);
    p.write(SHAPES[SHAPE]);
    setTimeout(() => p.write('\r'), 900);
    return;
  }
  // The tool render leaves the UI idle waiting for input — that settled screen is
  // the selector, not the thinking spinner or the echoed prompt.
  if (state === 'awaiting-tool' && Date.now() - elicitAt > 9000 && Date.now() - lastData > 4000) {
    state = 'driving';
    console.log('[' + stamp() + '] tool idle-waiting — capturing');
    console.log('\n===== SCREEN A: initial tool render =====\n' + screen() + '\n');
    driveKeys();
  }
}, 500);

async function driveKeys() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < KEYS.length; i++) {
    await sleep(1200);
    console.log('\n[' + stamp() + '] >>> key ' + (i + 1) + '/' + KEYS.length + ': ' + KEYS[i]);
    p.write(keyBytes(KEYS[i]));
    await sleep(1400);
    console.log('===== after ' + KEYS[i] + ' =====\n' + screen() + '\n');
  }
  await sleep(9000); // let claude record the tool_result
  console.log('===== FINAL screen =====\n' + screen() + '\n');
  verdict();
}

// ------------------------------------------------------------------ verdict
// The ONLY trustworthy readout: what claude recorded as the answer.
function verdict() {
  clearInterval(tick);
  try { p.kill(); } catch { /* already gone */ }
  const dir = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd));
  console.log('\n================ VERDICT (from transcript) ================');
  console.log('cwd:        ' + cwd);
  console.log('transcript: ' + dir);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {
    console.log('RESULT: NO TRANSCRIPT DIRECTORY — claude never wrote one.');
    return finish();
  }
  const asks = [];
  const results = new Map();
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const raw of txt.split('\n')) {
      if (!raw.trim()) continue;
      let o; try { o = JSON.parse(raw); } catch { continue; }
      const c = o && o.message && o.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b && b.type === 'tool_use' && b.name === 'AskUserQuestion') asks.push(b);
        else if (b && b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
      }
    }
  }
  if (!asks.length) {
    console.log('RESULT: NO AskUserQuestion tool_use RECORDED.');
    console.log('  (a PENDING question is not in the transcript — it is written only');
    console.log('   once answered, so this means the prompt was never submitted.)');
    return finish();
  }
  for (const a of asks) {
    console.log('\n--- asked (' + a.id + ') ---');
    for (const [i, q] of (a.input.questions || []).entries()) {
      const opts = q.options || [];
      const withPrev = opts.filter(o => o && o.preview).length;
      console.log(`  Q${i + 1} header=${JSON.stringify(q.header)} multiSelect=${q.multiSelect === true} ` +
        `opts=${opts.length} withPreview=${withPrev}`);
      console.log('       options: ' + opts.map(o => o.label).join(' | '));
    }
    const r = results.get(a.id);
    if (!r) {
      console.log('  ANSWER: (none recorded — still pending / never submitted)');
      continue;
    }
    const body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
    console.log('  ANSWER: ' + body.replace(/\s+/g, ' ').slice(0, 600));
  }
  finish();
}

function finish() {
  console.log('\n(temp cwd left in place for inspection: ' + cwd + ')');
  setTimeout(() => process.exit(0), 400);
}

setTimeout(() => {
  if (state !== 'done') {
    console.log('[' + stamp() + '] TIMEOUT in state=' + state);
    console.log('===== TIMEOUT screen =====\n' + screen() + '\n');
    verdict();
  }
}, TIMEOUT_MS);
