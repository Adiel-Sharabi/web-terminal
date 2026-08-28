// #78 Step 0 (blocking) — capture the REAL payloads for every Codex lifecycle
// hook event, not just whether each one fires. `probe-codex-hooks.js` already
// proved SessionStart/UserPromptSubmit fire and is the POSITIVE CONTROL this
// script's own results should be read against; this script is the follow-up
// that answers "what shape is the JSON on stdin" for all ten events, including
// the six the issue calls out as unproven: PermissionRequest, Stop,
// UserPromptSubmit, PostToolUse, PostCompact, SubagentStop.
//
// Isolation and safety are identical in spirit to probe-codex-hooks.js: a
// fully isolated CODEX_HOME under scripts/scratch-dirs.js's scratch tree,
// never ~/.codex; no auth.json copied (a scripted local HTTP server stands in
// for the model -- see codex-mock-provider.js); `--dangerously-bypass-hook-trust`
// so the isolated, throwaway hooks.json never has to pass an interactive trust
// prompt. This script verifies, at the end, that the REAL ~/.codex/hooks.json
// and config.toml are byte-identical to how they were before it ran.
//
// Usage:
//   node scripts/rig/probe-codex-hook-payloads.js [--keep]
//
// `--keep` leaves the isolated tree on disk for manual inspection (default:
// deleted at the end, matching the documented hazard that an
// installed-but-untrusted hooks.json blocks every NEW Codex session -- keeping
// it around serves no purpose once this process exits and is one more thing
// that could be mistaken for something requiring cleanup later).
//
// Exit code is always 0 (this is a measurement tool, not a pass/fail gate);
// read the printed report.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const { PARENT } = require('../scratch-dirs');

const KEEP = process.argv.includes('--keep');
const ROOT = path.join(PARENT, 'codex-hook-payload-probe');
const HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const CAP = path.join(ROOT, 'capture');
const REQLOG = path.join(ROOT, 'reqlog');

const CODEX_CMD = process.env.CODEX_BIN || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');

// MEASURED, non-obvious: invoke the `codex.cmd` npm shim, NEVER the
// `node <...>\codex.js` entry point it wraps, even though calling codex.js
// directly looks strictly simpler (no shell hop, no quoting to get right).
// Bypassing the shim was tried first and TWO DIFFERENT invocations both
// produced a fully-completed turn, real command execution, and hooks that
// fired -- but every hook's stdin was EMPTY every single time (this script's
// own 5s "NO-STDIN-TIMEOUT" fallback fired on all ~19 invocations across three
// scenarios). Re-running the *identical* scenario through `codex.cmd` instead
// -- one extra cmd.exe hop before node.exe -- fixed it immediately and
// reproducibly. The mechanism was not root-caused (a plausible guess is that
// Git-Bash/MSYS hands a direct `node.exe` child a pipe handle that a Rust
// grandchild's own stdio redirection to a THIRD-generation process (the hook)
// does not get real bytes through, where the extra native cmd.exe hop
// produces a handle chain that does) -- but the fix is unambiguous and cheap:
// use the shim.
//
// The shim being a `.cmd` then forces `shell: true` on spawnSync (Node throws
// EINVAL on a bare `.cmd` without it, since Node 22 / the CVE-2024-27980
// hardening) -- and `shell: true` on Windows does NOT reproduce cmd.exe's own
// quoting for you the way plain (non-shell) spawn does: a multi-word prompt
// ("run a shell command") came back through as four SEPARATE positional args
// ("error: unexpected argument 'a' found" from clap) until this script quoted
// it itself. See `winQuote` below -- required on every arg that can contain a
// space, for every call into codex.cmd.
function winQuote(s) {
  return /[ "]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}
const HOOK_CAPTURE_JS = path.join(__dirname, 'codex-hook-capture.js');
const MOCK_PROVIDER_JS = path.join(__dirname, 'codex-mock-provider.js');
const PTY_DRIVE_JS = path.join(__dirname, 'codex-pty-drive.js');
const NODE = process.execPath;

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
  'Stop', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];

// ---------------------------------------------------------------- safety: baseline the REAL ~/.codex files
function hashFile(p) {
  try {
    const buf = fs.readFileSync(p);
    return { exists: true, sha256: crypto.createHash('sha256').update(buf).digest('hex'), mtimeMs: fs.statSync(p).mtimeMs, size: buf.length };
  } catch (e) {
    return { exists: false };
  }
}
const REAL_HOOKS_JSON = path.join(os.homedir(), '.codex', 'hooks.json');
const REAL_CONFIG_TOML = path.join(os.homedir(), '.codex', 'config.toml');
const baselineHooksJson = hashFile(REAL_HOOKS_JSON);
const baselineConfigToml = hashFile(REAL_CONFIG_TOML);

// ---------------------------------------------------------------- isolated CODEX_HOME
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [HOME, WORK, CAP, REQLOG]) fs.mkdirSync(d, { recursive: true });

const tomlPath = (s) => "'" + s + "'"; // TOML literal string -- no backslash escaping needed
fs.writeFileSync(path.join(HOME, 'config.toml'), [
  'model = "stub-model"',
  'model_provider = "stub"',
  '',
  '[features]',
  'hooks = true',
  '',
  '[model_providers.stub]',
  'name = "stub"',
  'base_url = "http://127.0.0.1:8793/v1"',
  'wire_api = "responses"',
  '',
  '[projects.' + tomlPath(WORK) + ']',
  'trust_level = "trusted"',
  '',
  '[tui]',
  'notifications = false',
  '',
].join('\n'));

// Every event -> its own no-space .bat wrapper -> codex-hook-capture.js. A
// direct '"<node with spaces>" "<script>" ...' command string in hooks.json
// silently never invokes (see codex-hook-capture.js header) -- the .bat
// indirection is load-bearing, not style.
const hooks = {};
for (const ev of EVENTS) {
  const batPath = path.join(HOME, 'hook-' + ev + '.bat');
  fs.writeFileSync(batPath, ['@echo off', '"' + NODE + '" "' + HOOK_CAPTURE_JS + '" ' + ev + ' "' + CAP + '"', ''].join('\r\n'));
  hooks[ev] = [{ hooks: [{ type: 'command', command: batPath, timeout: 15 }] }];
}
fs.writeFileSync(path.join(HOME, 'hooks.json'), JSON.stringify({ hooks }, null, 2));

// ---------------------------------------------------------------- mock provider lifecycle
let mockProc = null;
function startMock(scriptMainPath, scriptSubPath, reqlogSubdir) {
  stopMock();
  const reqlogDir = path.join(REQLOG, reqlogSubdir);
  const args = [MOCK_PROVIDER_JS, '8793', reqlogDir, scriptMainPath].concat(scriptSubPath ? [scriptSubPath] : []);
  mockProc = require('child_process').spawn(NODE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Give the server a moment to bind before codex starts talking to it.
  execFileSync(NODE, ['-e', 'setTimeout(()=>{}, 700)']);
}
function stopMock() {
  if (mockProc && !mockProc.killed) { try { mockProc.kill(); } catch (e) { /* ignore */ } }
  mockProc = null;
}

function writeScript(name, turns) {
  const p = path.join(ROOT, name + '.json');
  fs.writeFileSync(p, JSON.stringify(turns, null, 2));
  return p;
}

function runExec(promptText, sandbox, extraArgs) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', '-s', sandbox]
    .concat(extraArgs || []).concat([promptText]);
  const r = spawnSync(CODEX_CMD, args.map(winQuote), {
    cwd: WORK, env: Object.assign({}, process.env, { CODEX_HOME: HOME }), timeout: 30000, encoding: 'utf8', shell: true,
  });
  return r;
}

// ================================================================== Scenario A: shell tool call (exec mode)
console.log('\n=== Scenario A: shell tool call, workspace-write (exec mode) ===');
const scriptA = writeScript('script-a', [
  { output: [{ type: 'function_call', name: 'shell_command', arguments: { command: 'Write-Output hello-from-mock' } }] },
  { output: [{ type: 'message', role: 'assistant', text: 'ran the command, done' }] },
]);
startMock(scriptA, scriptA, 'a');
const resA = runExec('run a shell command', 'workspace-write');
console.log('exec exit=' + resA.status);
if (resA.status !== 0) console.log('  stdout=' + (resA.stdout || '').slice(0, 2000) + '\n  stderr=' + (resA.stderr || '').slice(0, 2000));

// ================================================================== Scenario B: escalation attempt (exec mode) -- expected to prove exec CANNOT reach PermissionRequest
console.log('\n=== Scenario B: escalation attempt, read-only (exec mode -- expected to be structurally rejected) ===');
const scriptB = writeScript('script-b', [
  { output: [{ type: 'function_call', name: 'shell_command', arguments: { command: "'x' | Out-File -FilePath test.txt", sandbox_permissions: 'require_escalated', justification: 'need to write a file' } }] },
  { output: [{ type: 'message', role: 'assistant', text: 'wrote the file, done' }] },
]);
startMock(scriptB, scriptB, 'b');
const resB = runExec('run a shell command that writes a file', 'read-only');
const execRejectedEscalation = /approval policy is Never/i.test(resB.stderr || '') || /approval policy is Never/i.test(resB.stdout || '');
console.log('exec exit=' + resB.status + ' rejected-as-expected=' + execRejectedEscalation);

// ================================================================== Scenario C: sub-agent (exec mode)
console.log('\n=== Scenario C: spawn_agent + wait_agent (exec mode) ===');
const scriptCMain = writeScript('script-c-main', [
  { output: [{ type: 'function_call', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: { message: 'look at files in this directory and report back' } }] },
  { output: [{ type: 'function_call', name: 'wait_agent', namespace: 'multi_agent_v1', arguments: { targets: ['{{SPAWNED_AGENT_ID}}'], timeout_ms: 10000 } }] },
  { output: [{ type: 'message', role: 'assistant', text: 'helper agent finished, done' }] },
]);
const scriptCSub = writeScript('script-c-sub', [
  { output: [{ type: 'message', role: 'assistant', text: 'child agent report: nothing interesting here' }] },
]);
startMock(scriptCMain, scriptCSub, 'c');
const resC = runExec('spawn a sub-agent to look at files, then wait for it', 'workspace-write');
console.log('exec exit=' + resC.status);
stopMock();

// ================================================================== Scenario D: PermissionRequest (interactive TUI over a PTY)
console.log('\n=== Scenario D: escalation approval (interactive TUI, PermissionRequest) ===');
const scriptD = writeScript('script-d', [
  { output: [{ type: 'function_call', name: 'shell_command', arguments: { command: "'x' | Out-File -FilePath test.txt", sandbox_permissions: 'require_escalated', justification: 'need to write a file to verify escalation' } }] },
  { output: [{ type: 'message', role: 'assistant', text: 'wrote the file, done' }] },
]);
startMock(scriptD, scriptD, 'd');
const resD = spawnSync(NODE, [PTY_DRIVE_JS, 'permission', HOME, WORK], { timeout: 25000, encoding: 'utf8' });
console.log('driver exit=' + resD.status + (resD.status === 3 ? ' (ENVIRONMENT crash in the PTY driver -- see script output)' : ''));
if (resD.stdout) console.log(resD.stdout.trim());
stopMock();

// ================================================================== Scenario E: PreCompact/PostCompact (interactive TUI over a PTY)
console.log('\n=== Scenario E: /compact (interactive TUI, PreCompact/PostCompact) ===');
const scriptE = writeScript('script-e', [
  { output: [{ type: 'message', role: 'assistant', text: 'ok' }] },
  { output: [{ type: 'message', role: 'assistant', text: 'compacted-summary-placeholder' }] },
  { output: [{ type: 'message', role: 'assistant', text: 'post compact reply' }] },
]);
startMock(scriptE, scriptE, 'e');
const resE = spawnSync(NODE, [PTY_DRIVE_JS, 'compact', HOME, WORK], { timeout: 35000, encoding: 'utf8' });
console.log('driver exit=' + resE.status + (resE.status === 3 ? ' (ENVIRONMENT crash in the PTY driver -- see script output)' : ''));
if (resE.stdout) console.log(resE.stdout.trim());
stopMock();

// ================================================================== Report
console.log('\n================= PAYLOAD REPORT =================');
for (const ev of EVENTS) {
  const files = fs.existsSync(CAP) ? fs.readdirSync(CAP).filter((f) => f.startsWith(ev + '-')).sort() : [];
  if (!files.length) { console.log(ev + ': NOT OBSERVED'); continue; }
  console.log(ev + ': fired ' + files.length + 'x');
  files.forEach((f) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CAP, f), 'utf8'));
      console.log('  ' + f + ' keys=[' + Object.keys(j).join(', ') + ']');
    } catch (e) {
      console.log('  ' + f + ' (unparsed, ' + e.message + ')');
    }
  });
}
console.log('\ncapture dir (payload JSON files): ' + CAP);
console.log('request log dir (what codex actually sent):  ' + REQLOG);

// ---------------------------------------------------------------- safety: verify the REAL ~/.codex was never touched
console.log('\n================= SAFETY VERIFICATION =================');
const afterHooksJson = hashFile(REAL_HOOKS_JSON);
const afterConfigToml = hashFile(REAL_CONFIG_TOML);
function reportDrift(name, before, after) {
  const unchanged = before.exists === after.exists
    && (!before.exists || (before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs));
  console.log(name + ': ' + (unchanged ? 'UNCHANGED' : '*** CHANGED -- INVESTIGATE ***'));
  if (!unchanged) console.log('  before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
}
reportDrift('~/.codex/hooks.json', baselineHooksJson, afterHooksJson);
reportDrift('~/.codex/config.toml', baselineConfigToml, afterConfigToml);

// ---------------------------------------------------------------- cleanup
if (!KEEP) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('\nisolated tree removed: ' + ROOT);
} else {
  console.log('\n--keep passed: isolated tree left at ' + ROOT);
}
