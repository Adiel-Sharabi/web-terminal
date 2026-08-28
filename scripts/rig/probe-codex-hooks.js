// #78 — DOES the Codex hook engine actually spawn a hook command?
//
// Runs in a FULLY ISOLATED CODEX_HOME. It never reads or writes ~/.codex, so it
// cannot block the machine's real Codex sessions — the documented hazard is that
// an installed-but-untrusted hooks.json stops EVERY new session at an
// interactive trust prompt, which is fatal for a worker-spawned PTY.
//
// The verdict is a MARKER FILE written by a .bat as its very first action, so
// "never invoked" is distinguishable from "invoked but node was unresolvable".
// A silent script cannot tell those apart, and that distinction IS the question.
//
// No auth.json is copied: Codex rotates its refresh token on start and a copy
// triggers "refresh token was already used", which can revoke the whole family.
// A stub provider suffices — and the reason it does is the finding itself:
// SessionStart does NOT fire at process start, so no model ever has to answer.
//
// MEASURED (codex-cli 0.144.6, 2026-08-04), and it corrects this repo's own
// previously recorded conclusion that hooks never run:
//
//   prompt submitted -> SessionStart FIRED, UserPromptSubmit FIRED
//   no prompt, 40s   -> NEITHER fires
//
// SessionStart fires when the FIRST TURN BEGINS, not when the process starts —
// the same laziness as the rollout file, which Codex also creates only on the
// first turn. Run this with NO_PROMPT=1 to reproduce the control.
//
// #78 STEP 0 FOLLOW-UP (2026-08-28): this file stays the POSITIVE CONTROL --
// "do SessionStart/UserPromptSubmit fire at all" -- and is deliberately left
// otherwise unchanged. The full payload capture for all ten lifecycle events
// (PreToolUse, PostToolUse, PermissionRequest, Stop, SubagentStart,
// SubagentStop measured with real JSON; PreCompact/PostCompact attempted and
// found environment-blocked in this harness, not codex-blocked) now lives in
// `probe-codex-hook-payloads.js`, `codex-mock-provider.js`,
// `codex-hook-capture.js` and `codex-pty-drive.js` alongside this file. Read
// this script's own result as the sanity check that the newer one's harder
// scenarios should be measured against: if THIS script's SessionStart ever
// stops firing, nothing downstream can be trusted either.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const pty = require('node-pty');
const { DIRS } = require('../scratch-dirs');

// NOT under %TEMP%: codex refuses to create helper binaries there and warns
// loudly, which is noise across the one signal we care about.
const ROOT = DIRS.codexHooks;
const HOME = path.join(ROOT, 'codex-home');
const WORK = path.join(ROOT, 'codex-work');
const MARKER = path.join(ROOT, 'HOOK-RAN.txt');
const BAT_START = path.join(ROOT, 'hook-session-start.bat');
const BAT_PROMPT = path.join(ROOT, 'hook-user-prompt.bat');
const MARK_START = path.join(ROOT, 'FIRED-session_start.txt');
const MARK_PROMPT = path.join(ROOT, 'FIRED-user_prompt_submit.txt');

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.rmSync(MARKER, { force: true });
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });

// One .bat per event, each with its OWN marker, so "which hook fired" is a
// measurement rather than an inference. Both also append to the shared marker.
const mkBat = (file, mark) => fs.writeFileSync(file, [
  '@echo off',
  'echo INVOKED %DATE% %TIME% >> "' + mark + '"',
  'echo INVOKED %DATE% %TIME% >> "' + MARKER + '"',
  'echo {"continue":true}',
  'exit /b 0',
  '',
].join('\r\n'));
mkBat(BAT_START, MARK_START);
mkBat(BAT_PROMPT, MARK_PROMPT);
fs.rmSync(MARK_START, { force: true });
fs.rmSync(MARK_PROMPT, { force: true });

const tomlPath = (s) => s.replace(/\\/g, '\\\\');

// ROOT KEYS FIRST. A bare key after a [table] header belongs to THAT table, so
// putting model/model_provider below [features] made codex read
// features.model = "stub-model", reject the whole config, and never enable the
// hooks gate — a false negative produced entirely by the probe's own bug.
fs.writeFileSync(path.join(HOME, 'config.toml'), [
  'model = "stub-model"',
  'model_provider = "stub"',
  '',
  '[features]',
  'hooks = true',
  '',
  '[model_providers.stub]',
  'name = "stub"',
  'base_url = "http://127.0.0.1:9/v1"',
  'wire_api = "responses"',
  '',
  '# Pre-trust the cwd so the DIRECTORY prompt cannot be mistaken for the HOOKS',
  '# prompt — answering the wrong one is how a probe reports the wrong thing.',
  '[projects."' + tomlPath(WORK) + '"]',
  'trust_level = "trusted"',
  '',
  '[tui]',
  'notifications = false',
  '',
].join('\n'));

fs.writeFileSync(path.join(HOME, 'hooks.json'), JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: BAT_START, statusMessage: 'probe-start', timeout: 15 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: BAT_PROMPT, statusMessage: 'probe-prompt', timeout: 15 }] }],
  },
}, null, 2));

const deansi = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b[[\]][0-9;?]*[A-Za-z]/g, '')
  .replace(/\r/g, '');

const CODEX = process.env.CODEX_BIN
  || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');

console.log('CODEX_HOME =', HOME);
console.log('cwd        =', WORK);
console.log('binary     =', CODEX);

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);

let buf = '';
let answeredHooks = false;
let sawHookPrompt = false;
let composerSeen = false;
let configError = false;
let exited = null;
let promptSent = false;
let markerAfterStart = null;

const p = pty.spawn(CODEX, [], {
  name: 'xterm-256color', cols: 110, rows: 34, cwd: WORK,
  env: Object.assign({}, process.env, { CODEX_HOME: HOME }),
});

p.onExit((e) => {
  exited = e;
  console.log('[' + stamp() + '] PTY EXITED code=' + e.exitCode);
});

p.onData((d) => {
  buf += d;
  const clean = deansi(buf);

  if (/Error loading config\.toml|invalid type/i.test(clean)) configError = true;

  if (!answeredHooks && /hooks?\s+need\s+review|are new or changed/i.test(clean)) {
    sawHookPrompt = true;
    answeredHooks = true;
    console.log('[' + stamp() + '] HOOK TRUST PROMPT -> answering "2" + Enter');
    setTimeout(() => p.write('2\r'), 500);
  }
  if (!composerSeen && /(send a message|ctrl\+c to quit|\/status|esc to interrupt)/i.test(clean)) {
    composerSeen = true;
    console.log('[' + stamp() + '] composer furniture seen');
  }
});

const tick = setInterval(() => {
  const age = Date.now() - t0;
  if (markerAfterStart === null && age > 14000) {
    markerAfterStart = fs.existsSync(MARKER);
    console.log('[' + stamp() + '] marker after SessionStart window: ' + markerAfterStart);
  }
  if (!promptSent && !process.env.NO_PROMPT && age > 17000 && !exited) {
    promptSent = true;
    console.log('[' + stamp() + '] submitting a prompt (for UserPromptSubmit)');
    p.write('hello');
    setTimeout(() => p.write('\r'), 800);
  }
}, 1000);

setTimeout(() => {
  clearInterval(tick);
  const clean = deansi(buf);
  console.log('\n--- bytes=' + buf.length + ' exited=' + JSON.stringify(exited));
  console.log('--- last screen ---');
  console.log(clean.split('\n').filter((l) => l.trim()).slice(-30).join('\n'));

  if (configError) {
    console.log('\n*** CONFIG FAILED TO LOAD — verdict INVALID, not a negative. ***');
    try { p.kill(); } catch (e) { /* gone */ }
    return setTimeout(() => process.exit(3), 300);
  }

  const ran = fs.existsSync(MARKER);
  console.log('\n================= VERDICT =================');
  console.log('hook trust prompt appeared : ' + sawHookPrompt);
  console.log('composer furniture seen    : ' + composerSeen);
  console.log('marker after SessionStart  : ' + markerAfterStart);
  console.log('prompt submitted           : ' + promptSent);
  console.log('MARKER FILE EXISTS         : ' + ran);
  console.log('SessionStart FIRED         : ' + fs.existsSync(MARK_START));
  console.log('UserPromptSubmit FIRED     : ' + fs.existsSync(MARK_PROMPT));
  if (ran) console.log('marker: ' + fs.readFileSync(MARKER, 'utf8').trim());
  console.log('===========================================');
  console.log(ran
    ? 'HOOKS DO RUN on this version — #78 is buildable.'
    : 'NO HOOK PROCESS SPAWNED — #78 premise still false.');

  try {
    const cfg = fs.readFileSync(path.join(HOME, 'config.toml'), 'utf8');
    const st = cfg.split('\n').filter((l) => /hooks\.state|trusted_hash/.test(l));
    console.log('\nrecorded hook trust state: ' + (st.length ? '\n' + st.join('\n') : '(none)'));
  } catch (e) { console.log('config read failed: ' + e.message); }

  try { p.kill(); } catch (e) { /* gone */ }
  setTimeout(() => process.exit(ran ? 0 : 2), 300);
}, 40000);
