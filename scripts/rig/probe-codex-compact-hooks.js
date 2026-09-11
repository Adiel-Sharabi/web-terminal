// #78 Step 0, the last two events - PreCompact / PostCompact.
//
// WHY THIS IS A SEPARATE PROBE. `probe-codex-hook-payloads.js` captured eight of
// the ten lifecycle events and reported these two as NOT REACHED, for a reason
// that was honest but environmental: it tried to reach compaction the only way
// that looked available, by typing `/compact` into the INTERACTIVE TUI over a
// PTY, and the PTY driver hit a reproducible node-pty crash
// (conpty_console_list_agent.js's AttachConsole failing, exit -1073741510) that
// reproduces with a plain `pty.spawn('cmd.exe')` and has nothing to do with
// Codex. A harness limit is not evidence about a feature, so item 3 of #78 was
// left unproven rather than guessed at.
//
// THE ROUTE THIS PROBE TAKES INSTEAD - no TUI, no PTY, so the crash is not in
// the picture at all. `/compact` is not the only way a Codex session compacts:
// AUTO-compaction is driven by a config key, `model_auto_compact_token_limit`
// (read out of codex.exe's own ConfigToml field list, alongside
// `model_auto_compact_token_limit_scope` and a `core/src/session/turn.rs`
// tracing event carrying `total_usage_tokens` / `auto_compact_scope_tokens` /
// `auto_compact_scope_limit`). Set that limit below the token usage the mock
// provider reports, keep the turn alive with a tool call so there IS a next
// model round-trip to compact before, and Codex compacts on its own inside a
// plain non-interactive `codex exec`.
//
// The scripted turns therefore are:
//   1. a function_call (shell) reporting HUGE usage  -> crosses the limit
//   2. the compaction round-trip itself, tiny usage  -> PreCompact fires before it
//   3. the final assistant message, tiny usage       -> PostCompact fires after it
//
// Turn 1 must be a TOOL CALL and not a plain message: a plain message ends the
// exec task outright, and a session that has already finished has no next
// round-trip to compact before. That is the difference between measuring the
// feature and measuring nothing.
//
// SessionStart / UserPromptSubmit / Stop are registered as POSITIVE CONTROLS. If
// those do not fire, this run's rig is broken and a silent PreCompact is
// meaningless - the script says so rather than reporting a negative.
//
// Safety is identical to its sibling and is verified, not asserted: a fully
// isolated CODEX_HOME under scripts/scratch-dirs.js, never ~/.codex; no
// auth.json copied (a scripted local HTTP server stands in for the model);
// `--dangerously-bypass-hook-trust` so the throwaway hooks.json never has to
// pass an interactive trust prompt; and the real ~/.codex/hooks.json and
// config.toml are sha256'd before and after and reported on.
//
// Usage:
//   node scripts/rig/probe-codex-compact-hooks.js [--keep] [--verbose]
//
// Exit code is always 0 - this is a measurement tool, not a pass/fail gate.
// Read the printed report.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');

const { PARENT } = require('../scratch-dirs');

const KEEP = process.argv.includes('--keep');
const VERBOSE = process.argv.includes('--verbose');

// Its own tree and its own port, so this can run beside
// probe-codex-hook-payloads.js (which owns 8793) without either clobbering the
// other's capture directory or losing its provider to a port collision.
const ROOT = path.join(PARENT, 'codex-compact-hook-probe');
const HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const CAP = path.join(ROOT, 'capture');
const REQLOG = path.join(ROOT, 'reqlog');
const PORT = 8794;

const CODEX_CMD = process.env.CODEX_BIN
  || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');
const NODE = process.execPath;
const HOOK_CAPTURE_JS = path.join(__dirname, 'codex-hook-capture.js');
const MOCK_PROVIDER_JS = path.join(__dirname, 'codex-mock-provider.js');

// Invoke the codex.cmd npm shim, never the codex.js it wraps: measured in
// probe-codex-hook-payloads.js, bypassing the shim makes every hook's stdin
// arrive EMPTY. The shim being a .cmd then forces shell:true on spawnSync,
// which on Windows does not redo cmd.exe's quoting for you - hence winQuote on
// every argument that can contain a space.
function winQuote(s) {
  return /[ "]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PreCompact', 'PostCompact', 'Stop'];
const CONTROLS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const TARGETS = ['PreCompact', 'PostCompact'];

// ---------------------------------------------------------------- safety: baseline the REAL ~/.codex
function hashFile(p) {
  try {
    const buf = fs.readFileSync(p);
    return {
      exists: true,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      mtimeMs: fs.statSync(p).mtimeMs,
      size: buf.length,
    };
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

// ROOT KEYS FIRST. A bare key after a [table] header belongs to THAT table - the
// trap that once made codex read `features.model`, reject the whole config, and
// never enable the hooks gate, which the probe of the day reported as "hooks do
// not run". This script aborts on a config-load error rather than folding one
// into a verdict; see CONFIG_ERROR below.
const tomlPath = (s) => "'" + s + "'"; // TOML literal string, no backslash escaping
fs.writeFileSync(path.join(HOME, 'config.toml'), [
  'model = "stub-model"',
  'model_provider = "stub"',
  '',
  '# The whole point of this probe. The mock reports 5000 tokens on turn 1 (see',
  '# the script below), so any sane reading of a 64-token limit is crossed.',
  'model_context_window = 4096',
  'model_auto_compact_token_limit = 64',
  '',
  '[features]',
  'hooks = true',
  '',
  '[model_providers.stub]',
  'name = "stub"',
  'base_url = "http://127.0.0.1:' + PORT + '/v1"',
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
// direct '"<node with spaces>" "<script>"' command string in hooks.json
// silently never invokes; the .bat indirection is load-bearing, not style.
const hooks = {};
for (const ev of EVENTS) {
  const batPath = path.join(HOME, 'hook-' + ev + '.bat');
  fs.writeFileSync(batPath, [
    '@echo off',
    '"' + NODE + '" "' + HOOK_CAPTURE_JS + '" ' + ev + ' "' + CAP + '"',
    '',
  ].join('\r\n'));
  hooks[ev] = [{ hooks: [{ type: 'command', command: batPath, timeout: 15 }] }];
}
fs.writeFileSync(path.join(HOME, 'hooks.json'), JSON.stringify({ hooks }, null, 2));

// ---------------------------------------------------------------- the scripted conversation
// Turn 1 is a TOOL CALL on purpose - see the header. Its reported usage is what
// crosses model_auto_compact_token_limit; turns 2 and 3 report a small number so
// that a successful compaction actually settles instead of re-triggering on
// every subsequent round-trip.
const SCRIPT = [
  {
    output: [{ type: 'function_call', name: 'shell_command', arguments: { command: 'Write-Output hello-from-mock' } }],
    usage: { input_tokens: 5000, output_tokens: 20, total_tokens: 5020 },
  },
  {
    output: [{ type: 'message', role: 'assistant', text: 'SUMMARY: the user asked for a shell command; it ran and printed hello-from-mock.' }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  },
  {
    output: [{ type: 'message', role: 'assistant', text: 'all done' }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  },
];
const scriptPath = path.join(ROOT, 'script-compact.json');
fs.writeFileSync(scriptPath, JSON.stringify(SCRIPT, null, 2));

// ---------------------------------------------------------------- run
const mockLog = fs.openSync(path.join(ROOT, 'mock.log'), 'a');
const mockProc = spawn(NODE, [MOCK_PROVIDER_JS, String(PORT), path.join(REQLOG, 'compact'), scriptPath], {
  stdio: ['ignore', mockLog, mockLog],
});
// Give the server a moment to bind before codex starts talking to it.
execFileSync(NODE, ['-e', 'setTimeout(()=>{}, 700)']);

console.log('CODEX_HOME  = ' + HOME);
console.log('cwd         = ' + WORK);
console.log('binary      = ' + CODEX_CMD);
console.log('auto-compact limit = 64 tokens, turn 1 reports 5020');
console.log('\n=== running: codex exec (non-interactive, no PTY) ===');

const args = ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust',
  '-s', 'workspace-write', 'run a shell command'];
const res = spawnSync(CODEX_CMD, args.map(winQuote), {
  cwd: WORK,
  env: Object.assign({}, process.env, {
    CODEX_HOME: HOME,
    // Makes the auto-compact DECISION observable, so a miss is diagnosable
    // rather than silent - turn.rs logs the scope tokens and the limit it
    // compared them against.
    RUST_LOG: process.env.RUST_LOG || 'codex_core=debug',
  }),
  timeout: 90000,
  encoding: 'utf8',
  shell: true,
});

try { mockProc.kill(); } catch (e) { /* already gone */ }
fs.closeSync(mockLog);

const stdout = res.stdout || '';
const stderr = res.stderr || '';
fs.writeFileSync(path.join(ROOT, 'codex-stdout.txt'), stdout);
fs.writeFileSync(path.join(ROOT, 'codex-stderr.txt'), stderr);

console.log('exec exit=' + res.status + (res.error ? ' error=' + res.error.message : ''));

// A config that failed to load must ABORT, never be folded into a negative -
// that exact mistake is why this repo once recorded "Codex hooks never run".
const CONFIG_ERROR = /Error loading config\.toml|invalid type|unknown field/i.test(stdout + stderr);
if (CONFIG_ERROR) {
  console.log('\n*** CONFIG FAILED TO LOAD - VERDICT INVALID, NOT A NEGATIVE ***');
  console.log((stderr || stdout).split('\n').filter((l) => l.trim()).slice(0, 20).join('\n'));
}

if (VERBOSE) {
  console.log('\n--- codex stdout (first 60 lines) ---');
  console.log(stdout.split('\n').slice(0, 60).join('\n'));
}

// Did codex even evaluate the auto-compact decision, and did it act on it?
const compactTrace = (stderr.match(/.*auto_compact.*/gi) || []).slice(0, 10);
const sawCompactInStream = /"?(auto_)?compact/i.test(stdout);
console.log('\nauto_compact trace lines in stderr : ' + (compactTrace.length || 'none'));
compactTrace.forEach((l) => console.log('  ' + l.trim().slice(0, 240)));
console.log('compaction mentioned in --json stream : ' + sawCompactInStream);

const reqDir = path.join(REQLOG, 'compact');
const reqCount = fs.existsSync(reqDir) ? fs.readdirSync(reqDir).length : 0;
console.log('model round-trips the mock served     : ' + reqCount
  + (reqCount >= 2 ? '' : '   <- fewer than 2 means the turn ended before anything could be compacted'));

// ---------------------------------------------------------------- report
function payloads(ev) {
  if (!fs.existsSync(CAP)) return [];
  return fs.readdirSync(CAP).filter((f) => f.startsWith(ev + '-')).sort();
}

console.log('\n================= PAYLOAD REPORT =================');
for (const ev of EVENTS) {
  const files = payloads(ev);
  if (!files.length) { console.log(ev + ': NOT OBSERVED'); continue; }
  console.log(ev + ': fired ' + files.length + 'x');
  files.forEach((f) => {
    const raw = fs.readFileSync(path.join(CAP, f), 'utf8');
    if (!raw.trim()) { console.log('  ' + f + ' (EMPTY - no stdin delivered)'); return; }
    try {
      const j = JSON.parse(raw);
      console.log('  ' + f + ' keys=[' + Object.keys(j).join(', ') + ']');
    } catch (e) {
      console.log('  ' + f + ' (unparsed: ' + e.message + ')');
    }
  });
}

const controlsOk = CONTROLS.every((ev) => payloads(ev).length > 0);
const hitTargets = TARGETS.filter((ev) => payloads(ev).length > 0);

console.log('\n================= VERDICT =================');
console.log('positive controls fired (' + CONTROLS.join(', ') + '): ' + controlsOk);
if (CONFIG_ERROR) {
  console.log('RESULT: INVALID RUN - the config did not load. Fix the config, re-run.');
} else if (!controlsOk) {
  console.log('RESULT: INVALID RUN - the controls did not fire, so the rig is broken.');
  console.log('        A silent PreCompact here is meaningless. Do NOT record a negative.');
} else if (hitTargets.length === TARGETS.length) {
  console.log('RESULT: BOTH PreCompact AND PostCompact CAPTURED. #78 item 3 is unblocked.');
} else if (hitTargets.length) {
  console.log('RESULT: PARTIAL - captured ' + hitTargets.join(', ') + ' only.');
} else {
  console.log('RESULT: controls fired, compaction did NOT. Auto-compaction did not trigger');
  console.log('        on this version/config - read the auto_compact trace lines above');
  console.log('        before concluding anything about the EVENTS themselves.');
}
console.log('capture dir : ' + CAP);
console.log('reqlog dir  : ' + reqDir);

// ---------------------------------------------------------------- safety verification
console.log('\n================= SAFETY VERIFICATION =================');
function reportDrift(name, before, after) {
  const unchanged = before.exists === after.exists
    && (!before.exists || (before.sha256 === after.sha256 && before.mtimeMs === after.mtimeMs));
  console.log(name + ': ' + (unchanged ? 'UNCHANGED' : '*** CHANGED - INVESTIGATE ***'));
  if (!unchanged) console.log('  before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
}
reportDrift('~/.codex/hooks.json', baselineHooksJson, hashFile(REAL_HOOKS_JSON));
reportDrift('~/.codex/config.toml', baselineConfigToml, hashFile(REAL_CONFIG_TOML));

// ---------------------------------------------------------------- cleanup
if (!KEEP) {
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('\nisolated tree removed: ' + ROOT);
} else {
  console.log('\n--keep passed: isolated tree left at ' + ROOT);
}
