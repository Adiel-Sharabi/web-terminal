// #122 — does a mid-session `/model` write a NEW `turn_context` to the rollout?
//
// The badge's model/effort come from the rollout's newest `turn_context`
// (lib/metrics-codex.js). Real rollouts show that line written immediately before
// each `role:user` turn — so IF `/model` writes nothing, the badge cannot follow a
// model change until the next prompt, and no server-side fix can invent the data.
// That is the one step reasoning cannot settle, so this measures it.
//
// Method (the rollout is ground truth; the screen lies):
//   1. run the REAL codex in a scratch cwd no live session uses — a probe rollout in
//      a live cwd would hijack that session's Chat lens via findRolloutForCwd;
//   2. submit one trivial prompt, because Codex creates the rollout LAZILY on the
//      first turn (the same laziness that made SessionStart look dead in #78);
//   3. count `turn_context` lines;
//   4. open `/model`, change the selection, and DO NOT submit another prompt;
//   5. count again. A second line = the badge can follow immediately. No second
//      line = a Codex constraint, and the honest fix is to stop misrepresenting it.
//
// Cleans up its rollout and cwd. Uses the real CODEX_HOME on purpose: a second one
// would need auth.json, and copying that rotates a refresh token (see CLAUDE.md).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

const CWD = path.join('C:', 'dev', '.wt-scratch', 'codex-model-probe');
const CODEX = process.env.CODEX_BIN || path.join(process.env.APPDATA || '', 'npm', 'codex.cmd');
const SESSIONS = path.join(process.env.USERPROFILE || os.homedir(), '.codex', 'sessions');

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (m) => console.log('[' + stamp() + '] ' + m);
const clean = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

fs.mkdirSync(CWD, { recursive: true });

// The rollout for THIS run: the newest file under sessions/ created after we start.
const startedAt = Date.now();
function ourRollout() {
  const found = [];
  (function walk(dir) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { if (fs.statSync(p).birthtimeMs >= startedAt - 2000) found.push(p); } catch {}
      }
    }
  })(SESSIONS);
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}
function turnContexts(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).reduce((acc, l) => {
    try { const j = JSON.parse(l); if (j.type === 'turn_context') acc.push((j.payload && j.payload.model) + '/' + (j.payload && j.payload.effort)); } catch {}
    return acc;
  }, []);
}

let out = '';
let phase = 'boot';
let composerSeen = false;
const screens = {};

const p = pty.spawn(CODEX, [], { name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD, env: process.env });

function send(s, why) { log('send ' + JSON.stringify(s) + (why ? '  (' + why + ')' : '')); p.write(s); }

p.onData((d) => {
  out += d.toString('utf8');
  const c = clean(out);
  // Key on the composer's model/effort line, NEVER the banner or "esc to interrupt":
  // a cold TUI prints the latter while booting, and the banner's text moved between
  // 0.144.0 and 0.144.6 (CLAUDE.md).
  if (!composerSeen && /(gpt-[\d.]+\s+\w+|send a message|\/status)/i.test(c)) {
    composerSeen = true;
    log('composer up');
    setTimeout(() => { send('say ok', 'trivial first turn — the rollout is created LAZILY'); setTimeout(() => send('\r', 'bare CR on a cold PTY is never split'), 900); }, 600);
  }
});

const done = (code) => {
  try { p.kill(); } catch {}
  console.log('\n================ RESULT ================');
  for (const k of Object.keys(screens)) {
    console.log('\n--- screen: ' + k + ' ---\n' + screens[k].split('\n').slice(-18).join('\n'));
  }
  const f = ourRollout();
  console.log('\nrollout      : ' + (f || 'NONE CREATED'));
  console.log('turn_contexts: ' + JSON.stringify(turnContexts(f)));
  console.log('before /model: ' + JSON.stringify(global.__before || []));
  console.log('\nVERDICT: ' + (global.__verdict || 'inconclusive'));
  try { if (f) fs.unlinkSync(f); } catch {}
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  process.exit(code || 0);
};

// Driven by the ROLLOUT, never by a stopwatch. The first cut of this probe sampled
// "before" at a fixed 45s, caught the rollout before its first turn_context existed,
// and compared [] with ["gpt-5.5/high"] — reporting a model change that never
// happened. Zero-to-one is rollout creation, not a /model. Wait for the baseline to
// EXIST before doing anything that could add to it.
const t0 = Date.now();
const waitForBaseline = setInterval(() => {
  const tcs = turnContexts(ourRollout());
  if (tcs.length > 0) {
    clearInterval(waitForBaseline);
    global.__before = tcs;
    screens.afterFirstTurn = clean(out);
    log('BASELINE established after ' + Math.round((Date.now() - t0) / 1000) + 's: ' + JSON.stringify(tcs));
    out = '';
    send('/model', 'open the picker');
    setTimeout(() => send('\r', 'submit the slash command'), 1200);
    setTimeout(() => {
      screens.picker = clean(out);
      send('\x1b[B');                    // Down: a DIFFERENT model
      setTimeout(() => send('\r', 'confirm the selection'), 800);
    }, 6000);
    // Give the write every chance: sample repeatedly for 20s after the change.
    let ticks = 0;
    const watch = setInterval(() => {
      const after = turnContexts(ourRollout());
      if (after.length > global.__before.length || ++ticks > 20) {
        clearInterval(watch);
        screens.afterModelChange = clean(out);
        global.__verdict = after.length > global.__before.length
          ? 'a /model change DOES write a new turn_context — before=' + JSON.stringify(global.__before) + ' after=' + JSON.stringify(after) + '. The badge CAN follow without a turn.'
          : 'NO new turn_context in 20s after /model — still ' + JSON.stringify(after) + '. The model reaches the rollout only on the NEXT turn (a Codex constraint, not a server bug).';
        done(0);
      }
    }, 1000);
  } else if (Date.now() - t0 > 70000) {
    clearInterval(waitForBaseline);
    global.__verdict = 'INCONCLUSIVE — no turn_context was ever written, so the first turn never ran. Do not read anything into this.';
    done(1);
  }
}, 1500);

setTimeout(() => { log('hard timeout'); global.__verdict = global.__verdict || 'INCONCLUSIVE — hard timeout'; done(1); }, 150000);
