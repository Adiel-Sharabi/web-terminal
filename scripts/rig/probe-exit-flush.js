#!/usr/bin/env node
'use strict';
// #191 — WHAT does `/exit` flush that a hard PTY kill loses?
//
// The issue asks for Kill to submit `/exit` to Claude before killing the PTY, on
// the reporter's premise that "there is some work that Claude is doing in the
// memory". That premise is the whole question, and it has never been measured.
// A ceremony that buys nothing is WORSE than an immediate kill — it makes Kill
// feel broken — so this probe exists to earn the answer either way. "Nothing is
// lost" is a completely acceptable verdict; do not bend the measurement.
//
// MATCHED SESSIONS THAT DIFFER ONLY IN HOW THEY END:
//
//   arm A — hard kill : `term.kill()`, exactly what pty-worker.js killSession does
//                       today (pty-worker.js ~:2189). No warning, no signal, and a
//                       withheld CR in `_inputQueue` would die with the PTY.
//   arm B — graceful  : `/exit` submitted with the registry's own submit discipline,
//                       then the process is AWAITED, and only then is the PTY
//                       disposed.
//   arm C — CONTROL   : `process.kill(<agent pid>)` — TerminateProcess on Windows, so
//                       no handler runs at all. Not a candidate design; it is what
//                       makes A-vs-B interpretable. If C flushes what A flushes, then
//                       A's flush says nothing about the teardown.
//
// Both arms first do IDENTICAL REAL WORK — one >80-character prompt (the length at
// which Claude's TUI is measured to fold an atomic `text\r` into a paste, #55) that
// makes the agent run a tool and write a file — so there is something to lose.
//
// GROUND TRUTH IS THE DISK AND THE HOOKS, NEVER THE SCREEN. The screen cannot tell a
// typed line from a submitted one, and it can show nothing at all about what was
// flushed. Three sources, all on disk:
//
//   1. the transcript JSONL     — which lines exist, and what the LAST one is
//   2. the config tree          — every file under the isolated CLAUDE_CONFIG_DIR,
//                                 snapshotted before the end-action and after it,
//                                 with a key-level JSON diff on anything that moved
//   3. hook marker files        — one .bat per lifecycle event, each writing its own
//                                 marker, so "which hooks fired" is a measurement and
//                                 not an inference. SessionEnd is registered on
//                                 purpose: it is NOT in this fleet's real settings.json,
//                                 and the string IS in the 2.1.251 binary.
//
// WHAT TO LOOK FOR, found by reading 60 real transcripts before writing a line of this:
// claude-code writes a `{"type":"cost-state",...}` line carrying the session's whole
// cost/duration/model-usage roll-up, and it is the LAST line of 48 of those 60 files.
// `~/.claude.json`'s per-project entry carries a literal `lastGracefulShutdown` boolean
// beside `lastSessionId`, `lastCost`, `lastDuration` and `lastSessionMetrics`. If any of
// that is written at exit, a hard kill loses it — which is exactly what this measures.
//
// ISOLATION — the probe must not touch production or the user's real Claude state:
//   * CLAUDE_CONFIG_DIR points at a throwaway tree, so the probe's conversation,
//     projects index and settings never reach `~/.claude` / `~/.claude.json`. That is
//     also what makes requirement 2 (diff the WHOLE config tree) meaningful: `~/.claude`
//     is written continuously by every live session on this machine, so a diff of it
//     would be pure noise.
//   * That isolated tree registers COMMAND hooks writing marker files. The fleet's real
//     settings.json registers HTTP hooks that POST to production `127.0.0.1:7681/api/hook`
//     and a statusLine that POSTs to `/api/claude-status`; an isolated config has
//     neither, so no probe lifecycle event can land in production's session table.
//   * EVERY `CLAUDE*`, `WT_*` and `ANTHROPIC*` variable is stripped from the child env.
//     This is not hygiene, it is correctness: run from inside a Claude Code session —
//     which is how anyone will run it — `process.env` carries CLAUDE_CODE_SESSION_ID,
//     CLAUDE_CODE_CHILD_SESSION=1, CLAUDECODE=1 and CLAUDE_CODE_MESSAGING_SOCKET (a
//     named pipe into the PARENT session). The first run of this probe inherited them
//     and wrote NO TRANSCRIPT AT ALL, in four sessions across both arms — a nested
//     child session persists nothing. That looked exactly like a claude behaviour and
//     would have been reported as one. pty-worker.js spawns from the worker's env,
//     which carries none of them.
//   * The cwd is a fresh scratch directory, never a live session's cwd and never the
//     checkout — a probe running where a real session runs pollutes that session.
//
// THE ONE THING THAT IS NOT ISOLATED, stated plainly rather than buried: an isolated
// CLAUDE_CONFIG_DIR has no credentials, and claude would sit on a login screen instead
// of a composer. So `.credentials.json` is COPIED in. The Codex rule ("never copy
// auth.json into a second CODEX_HOME") exists because a refresh rotates the token and
// reuse-detection can revoke the family, so this probe refuses to run unless the access
// token has `--min-token-life` minutes left (default 30). THAT REFUSAL is what makes a
// refresh impossible inside a run — no after-the-fact check can. It also hashes each
// COPY just before shredding it and SHOUTS if the child moved one; the original cannot
// show that, because the child runs with CLAUDE_CONFIG_DIR elsewhere and never opens it,
// so it is checked separately and only for what it does show (the HOST refreshing).
// Every copy is deleted on the way out, including on --keep.
//
// Usage:
//   node scripts/rig/probe-exit-flush.js                 # 2 runs of each arm
//   node scripts/rig/probe-exit-flush.js --runs 1        # one of each
//   node scripts/rig/probe-exit-flush.js --arms ABC      # add the TerminateProcess control
//   node scripts/rig/probe-exit-flush.js --dwell 20000   # keep the session alive longer first
//   node scripts/rig/probe-exit-flush.js --dump          # print the final screen too
//   node scripts/rig/probe-exit-flush.js --clean         # remove the probe tree, run nothing
//
// Nothing here talks to the rig or to production. It drives node-pty directly, so the
// process it kills is a process it spawned and recorded — the only kind this fleet's
// rules allow anything to kill.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const pty = require('node-pty');
const { PARENT } = require('../scratch-dirs');
const { readinessMarker, submitPolicy } = require('../../lib/agents');
const { createReadyDetector } = require('../../lib/agent-ready');
const { stripAnsi } = require('../../lib/ansi');
const { claudeProjectDirName } = require('../../lib/transcript');

// ---------------------------------------------------------------- constants

/** Own scratch parent. Overridable, but NEVER pointed at a directory with anything else in it. */
const PROBE_PARENT = process.env.WT_EXIT_FLUSH_DIR || path.join(PARENT, 'wt-exit-flush');

const REAL_CLAUDE_DIR = path.join(os.homedir(), '.claude');
const REAL_CREDS = path.join(REAL_CLAUDE_DIR, '.credentials.json');
const REAL_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

const SHELL = process.env.WT_SHELL
  || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash');
const LAUNCH = process.env.WT_EXIT_FLUSH_LAUNCH || 'claude --dangerously-skip-permissions';

// >80 characters ON PURPOSE. Measured (#55): Claude's TUI folds an atomic `text\r` of
// 80+ chars into a paste and submits nothing, so a short probe prompt would "work"
// through a path production does not use. It also makes the agent run a real tool, so
// the session has state worth flushing rather than one bare assistant sentence.
const PROMPT = 'Write a file called note.txt in the current directory containing only the word BANANA, then reply with just the word DONE.';

/** The composer marker — taken from the registry, never restated (it is 5 bytes, #190). */
const COMPOSER = readinessMarker('claude');
/** The submit gap — likewise from the registry. */
const GAP_MS = submitPolicy('claude').gapMs;

/**
 * Every lifecycle hook claude-code 2.1.251 knows about. SessionEnd is here BECAUSE the
 * fleet's own settings.json does not register it — "does a clean exit fire an event a
 * hard kill cannot" is half of #191's question, and an unregistered event answers it
 * with silence that looks like a negative.
 */
const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStart', 'SubagentStop', 'Notification', 'PreCompact', 'PostCompact',
];
/** Events whose config entry takes a tool matcher. */
const MATCHED = new Set(['PreToolUse', 'PostToolUse']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- small helpers

const NLC = String.fromCharCode(10);
/** Credential copies on disk right now — see the signal handler below. */
const liveCredCopies = new Set();
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
/** Named because a comparison against it is NOT evidence of a change. */
const UNREADABLE = '<unreadable>';
const sha1File = (p) => { try { return sha1(fs.readFileSync(p)); } catch { return UNREADABLE; } };

/**
 * The screen with EVERY space removed.
 *
 * Claude's folder-trust dialog positions each word with CHA and emits no spaces at all
 * (#190), so a stripped stream reads `Yes,Itrustthisfolder`. Collapsing whitespace on
 * both sides of the comparison matches it without duplicating probe-trust-prompt.js's
 * column-aware renderer here — this probe only needs to RECOGNISE the dialog, never to
 * transcribe it.
 */
const squashed = (s) => stripAnsi(s).replace(/\s+/g, '');

/** ISO-ish local stamp with ms, for the timeline. */
const hhmmss = (t) => new Date(t).toISOString().slice(11, 23);

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* gone */ } }

/** Overwrite before unlinking — the file held a live OAuth token. */
function shred(p) {
  try {
    if (!fs.existsSync(p)) return;
    const n = fs.statSync(p).size;
    fs.writeFileSync(p, Buffer.alloc(n, 0x30));
    fs.rmSync(p, { force: true });
  } catch { /* best effort */ }
  liveCredCopies.delete(p);
}

/**
 * Every credential copy currently on disk.
 *
 * A SIGNAL RUNS NO `finally`. Node unwinds nothing on SIGINT, so Ctrl-C skipped both
 * shred paths in this file and stranded a PLAINTEXT token copy under the probe parent
 * until somebody remembered `--clean` — the one review finding here with a consequence
 * outside the write-up. Registered when a copy is made and cleared when it is shredded,
 * so this handler destroys exactly what is still there and nothing else.
 *
 * The trees themselves are deliberately LEFT: they are inert, and `--clean` refuses to
 * remove anything it did not create. Only the secret is urgent.
 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of [...liveCredCopies]) shred(p);
    console.error(`${NLC}${sig} - credential copies shredded. Probe trees left; run --clean.`);
    process.exit(130);
  });
}

// ---------------------------------------------------------------- tree snapshots

/** relpath -> { size, mtimeMs, sha1 } for every file under `root`. */
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      out.set(r, { size: st.size, mtimeMs: st.mtimeMs, sha1: sha1File(p) });
    }
  };
  walk(root, '');
  return out;
}

function diffTrees(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of after) {
    const b = before.get(k);
    if (!b) added.push({ rel: k, size: v.size });
    else if (b.sha1 !== v.sha1) changed.push({ rel: k, from: b.size, to: v.size });
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push({ rel: k });
  return { added, removed, changed };
}

/** A flat `a.b.c` map of a JSON value, so two configs can be compared key by key. */
function flatten(obj, prefix = '', out = {}, depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== 'object') { out[prefix || '<root>'] = obj; return out; }
  if (Array.isArray(obj)) { out[prefix] = `array[${obj.length}]`; return out; }
  for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  return out;
}

function jsonKeyDiff(beforeText, afterText) {
  let a; let b;
  try { a = flatten(JSON.parse(beforeText)); } catch { a = null; }
  try { b = flatten(JSON.parse(afterText)); } catch { b = null; }
  if (!a || !b) return null;
  const rows = [];
  for (const [k, v] of Object.entries(b)) {
    if (!(k in a)) rows.push({ k, from: '(absent)', to: JSON.stringify(v) });
    else if (JSON.stringify(a[k]) !== JSON.stringify(v)) rows.push({ k, from: JSON.stringify(a[k]), to: JSON.stringify(v) });
  }
  for (const k of Object.keys(a)) if (!(k in b)) rows.push({ k, from: JSON.stringify(a[k]), to: '(absent)' });
  return rows;
}

// ---------------------------------------------------------------- transcript

/** Every `.jsonl` under `<cfg>/projects/`, newest first. */
function findTranscripts(cfgDir) {
  const root = path.join(cfgDir, 'projects');
  const found = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(root, d.name);
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(sub, f);
      found.push({ path: p, project: d.name, mtimeMs: fs.statSync(p).mtimeMs });
    }
  }
  return found.sort((x, y) => y.mtimeMs - x.mtimeMs);
}

/** Parsed line summaries, so "what is the last line" is answered without dumping content. */
function readTranscript(p) {
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const lines = txt.split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => {
    let o = null;
    try { o = JSON.parse(l); } catch { return { type: '<unparseable>', bytes: l.length }; }
    return {
      type: o.type,
      role: (o.message && o.message.role) || null,
      uuid: o.uuid || null,
      bytes: l.length,
      // Kept so the report can say WHAT an extra line is, not merely that one exists.
      preview: JSON.stringify(o).slice(0, 220),
    };
  });
  return { bytes: txt.length, lines: rows.length, rows };
}

// ---------------------------------------------------------------- seeding

function writeHookBats(markerDir) {
  fs.mkdirSync(markerDir, { recursive: true });
  const bats = {};
  for (const ev of HOOK_EVENTS) {
    const bat = path.join(markerDir, `hook-${ev}.bat`);
    const marker = path.join(markerDir, `FIRED-${ev}.txt`);
    // Marker FIRST, before anything that could fail, so "never invoked" stays
    // distinguishable from "invoked but something inside blew up" — the discipline
    // probe-codex-hooks.js established, and the reason its verdict was trustworthy.
    fs.writeFileSync(bat, [
      '@echo off',
      `echo %DATE% %TIME% >> "${marker}"`,
      'echo {"continue":true}',
      'exit /b 0',
      '',
    ].join('\r\n'));
    bats[ev] = bat;
  }
  return bats;
}

function seedConfigDir(cfgDir, cwd, bats) {
  fs.mkdirSync(cfgDir, { recursive: true });

  const hooks = {};
  for (const ev of HOOK_EVENTS) {
    const entry = { hooks: [{ type: 'command', command: `"${bats[ev]}"`, timeout: 15 }] };
    if (MATCHED.has(ev)) entry.matcher = '*';
    hooks[ev] = [entry];
  }

  // NO statusLine and NO plugins, deliberately: the real settings.json's status line
  // POSTs usage to production `/api/claude-status`, and that is exactly the kind of
  // leak this isolation exists to prevent.
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' },
    skipDangerousModePermissionPrompt: true,
    autoCompactEnabled: false,
    hooks,
  }, null, 2));

  // Pre-trust the cwd. Without this every arm parks on the folder-trust selector,
  // whose DEFAULT ROW IS `No, exit` (#190) — the probe would measure a session that
  // never started, and a stray CR there would answer it destructively.
  const proj = {
    allowedTools: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: true,
    hasClaudeMdExternalIncludesWarningShown: true,
    history: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    mcpContextUris: [],
    exampleFiles: [],
  };
  const projects = {};
  // Both separator forms: the real file keys on forward slashes, but which form a given
  // release writes is not something to bet a whole run on.
  projects[cwd.replace(/\\/g, '/')] = proj;
  projects[cwd] = JSON.parse(JSON.stringify(proj));

  fs.writeFileSync(path.join(cfgDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    autoUpdates: false,
    autoUpdatesProtectedForNative: true,
    installMethod: 'native',
    numStartups: 5,
    hasSeenTasksHint: true,
    // A fresh config downloads the official plugin marketplace — 440 files of pure
    // noise in a tree diff whose whole job is to notice a single flushed file, and it
    // lands asynchronously, so WHICH arm it lands in is a coin toss. Declaring it
    // already done is the difference between a readable diff and an unreadable one.
    officialMarketplaceAutoInstallAttempted: true,
    officialMarketplaceAutoInstalled: true,
    projects,
  }, null, 2));

  fs.copyFileSync(REAL_CREDS, path.join(cfgDir, '.credentials.json'));
  return path.join(cfgDir, '.credentials.json');
}

// ---------------------------------------------------------------- process hygiene

/**
 * Descendants of a pid WE spawned, with their full command lines.
 *
 * Read-only. Nothing is ever selected by name, by a substring, or by port — the ONLY
 * seed is a pid this process recorded at spawn time, and the walk goes downwards from
 * it. That is the fleet rule ("if you did not spawn it, you do not kill it") expressed
 * as code rather than as care.
 */
function descendantsOf(rootPid) {
  if (process.platform !== 'win32') return [];
  let rows = [];
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3',
    ], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
    rows = JSON.parse(out);
    if (!Array.isArray(rows)) rows = [rows];
  } catch { return []; }
  const byParent = new Map();
  for (const r of rows) {
    const k = r.ParentProcessId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of byParent.get(pid) || []) { out.push(c); stack.push(c.ProcessId); }
  }
  return out;
}

/** Is this pid still running? `signal 0` tests without delivering anything. */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------- one arm

/**
 * @param {'A'|'B'} arm
 */
async function runArm(arm, run, opts) {
  const tag = `${arm}${run}-${Date.now().toString(36)}`;
  const cfgDir = path.join(PROBE_PARENT, `cfg-${tag}`);
  const cwd = path.join(PROBE_PARENT, `work-${tag}`);
  const markerDir = path.join(PROBE_PARENT, `markers-${tag}`);

  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# exit-flush probe\n\nGenerated by scripts/rig/probe-exit-flush.js (#191).\n');

  const bats = writeHookBats(markerDir);
  const credsCopy = seedConfigDir(cfgDir, cwd, bats);
  // Hashed AT CREATION rather than reused from preflight: the HOST's own claude may
  // refresh between the two, and that would otherwise read as the child rotating it.
  const credsCopyHash = sha1File(credsCopy);
  liveCredCopies.add(credsCopy);

  const R = {
    arm, run, tag, cfgDir, cwd, markerDir,
    events: [],
    hooks: {},
    trustDialog: false,
    // null = never checked (the copy was gone, or finish() never ran). See finish().
    credsRotated: null,
    readyMs: null,
    turnMs: null,
    exitCode: null,
    exitAwaitedMs: null,
    extraCrNeeded: false,
    survivors: [],
    error: null,
  };
  const t0 = Date.now();
  const note = (s) => { R.events.push({ at: Date.now() - t0, s }); console.log(`  [${arm}${run} +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`); };

  // Marker mtimes are the hook timeline; read once at each checkpoint.
  const readHooks = () => {
    const out = {};
    for (const ev of HOOK_EVENTS) {
      const f = path.join(markerDir, `FIRED-${ev}.txt`);
      if (!fs.existsSync(f)) continue;
      const txt = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      out[ev] = { count: txt.length, mtimeMs: fs.statSync(f).mtimeMs };
    }
    return out;
  };

  // SCRUB THE PARENT'S AGENT ENV, and this is not hygiene — it is the difference
  // between measuring claude and measuring a CHILD of the claude that launched the
  // probe. Run from inside a Claude Code session (which is how anyone will run it),
  // `process.env` carries CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION=1,
  // CLAUDECODE=1, CLAUDE_CODE_MESSAGING_SOCKET (a named pipe into the PARENT session)
  // and CLAUDE_CODE_BRIDGE_SESSION_ID. The first run of this probe inherited all of
  // them and wrote NO TRANSCRIPT AT ALL — a nested/child session persists nothing —
  // so requirement 1 was simply unmeasurable and looked like a claude behaviour.
  // pty-worker.js spawns from the worker's env, which has none of these.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/i.test(k)) continue;      // CLAUDECODE, CLAUDE_CODE_*, CLAUDE_PID, ...
    if (/^WT_/i.test(k)) continue;         // an inherited web-terminal session id/token
    if (/^ANTHROPIC/i.test(k)) continue;   // never let an ambient key pick the auth path
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = cfgDir;
  env.DISABLE_AUTOUPDATER = '1';

  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd, env, encoding: null,
    useConptyDll: true,
  });
  const shellPid = term.pid;
  note(`spawned ${path.basename(SHELL)} pid=${shellPid} cwd=${cwd}`);

  let raw = '';
  let exited = null;
  const ready = createReadyDetector(COMPOSER);
  let readyAt = null;
  let armed = false;   // #147: the scan starts only AFTER the launch command is written

  term.onData((d) => {
    const s = Buffer.isBuffer(d) ? d.toString('utf8') : String(d);
    raw += s;
    if (raw.length > 4 * 1024 * 1024) raw = raw.slice(-2 * 1024 * 1024);
    if (armed && !ready.ready && ready.push(Buffer.from(s, 'utf8'))) readyAt = Date.now();
  });
  term.onExit((e) => { exited = e; note(`PTY EXITED code=${e.exitCode} signal=${e.signal}`); });

  const finish = async (err) => {
    if (err) R.error = String((err && err.message) || err);
    try { term.kill(); } catch { /* already gone */ }
    await sleep(1500);
    const left = descendantsOf(shellPid);
    for (const p of left) {
      // Printed in full before anything is done with it. These are descendants of a pid
      // this function spawned itself, so they are ours to clean up — and nothing else is.
      console.log(`  [${arm}${run}] SURVIVOR pid=${p.ProcessId} ${p.Name} :: ${String(p.CommandLine || '').slice(0, 160)}`);
      R.survivors.push({ pid: p.ProcessId, name: p.Name, cmd: String(p.CommandLine || '').slice(0, 200) });
      try { process.kill(p.ProcessId); } catch { /* already gone */ }
    }
    // THE COPY IS THE ONLY FILE A REFRESH BY THE CHILD CAN MOVE, and it has to be read
    // HERE because the next line destroys it. The child runs with CLAUDE_CONFIG_DIR
    // pointed at cfgDir and never opens the original, which is therefore unchanged by
    // construction whatever it does — so the run-level check on the original can only
    // ever print "unchanged", including in exactly the scenario it exists to catch.
    // null means the copy was gone before it could be hashed: not evidence either way.
    const copyNow = fs.existsSync(credsCopy) ? sha1File(credsCopy) : null;
    // An unreadable hash on EITHER side is not a rotation, and must not be reported as
    // one: a false alarm on a credential warning is how you learn to ignore the real one.
    R.credsRotated = (copyNow === null || copyNow === UNREADABLE || credsCopyHash === UNREADABLE)
      ? null
      : copyNow !== credsCopyHash;
    shred(credsCopy);
    return R;
  };

  try {
    // --- boot the shell, then launch the agent -------------------------------
    await sleep(2500);
    term.write(`${LAUNCH}\r`);
    armed = true;
    note(`launch written: ${LAUNCH}`);

    // --- wait for the composer ----------------------------------------------
    const readyDeadline = Date.now() + 90000;
    while (!ready.ready && Date.now() < readyDeadline && !exited) {
      const sq = squashed(raw);
      if (!R.trustDialog && /Yes,Itrustthisfolder/.test(sq)) {
        R.trustDialog = true;
        note('!! folder-trust dialog appeared despite the seeded trust — answering down+Enter');
        term.write('\x1b[B');
        await sleep(400);
        term.write('\r');
      }
      if (!R.importsDialog && /Allowexternal/i.test(sq)) {
        R.importsDialog = true;
        note('!! external CLAUDE.md imports dialog appeared — answering down+Enter');
        term.write('\x1b[B');
        await sleep(400);
        term.write('\r');
      }
      await sleep(200);
    }
    if (!ready.ready) throw new Error('composer marker never appeared');
    R.readyMs = readyAt - t0;
    note(`composer ready at ${R.readyMs}ms`);

    // THE AGENT'S OWN PID, and the reason this probe needs it: production spawns a
    // SHELL and types the launch command, so claude is a CHILD of bash. `term.onExit`
    // therefore reports when BASH exits — and `/exit` returns claude to its shell,
    // which never exits at all. Waiting on the PTY made a perfectly successful `/exit`
    // read as "did not exit within 60s" on the first run of this probe. The agent's own
    // liveness is the only honest signal for either arm.
    //
    // The pid is found by walking DOWN from a pid this function spawned itself; nothing
    // is ever selected by name across the machine, by a port, or by a command-line
    // substring.
    const claudeProc = descendantsOf(shellPid).find((p) => /^claude(\.exe)?$/i.test(p.Name || ''));
    R.claudePid = claudeProc ? claudeProc.ProcessId : null;
    note(`agent pid=${R.claudePid === null ? 'NOT FOUND' : R.claudePid}`);

    // ABORT RATHER THAN FOLD A SETUP FAILURE INTO A VERDICT. This is the same lesson
    // CLAUDE.md already records for the Codex TOML probe, and here it is worse than a
    // wrong answer — it is a CONFIDENT one, in both arms at once.
    //
    // The pid is matched on the process NAME, so an install that runs the agent under a
    // shim (an npm wrapper is `node.exe`) leaves it null. `alive(null)` is false, so
    // every liveness loop below exits on its first test:
    //
    //   arm A — the wait that exists to PROVE the hard kill reaches the agent returns
    //           immediately, reports "agent died 0ms after it", and has checked nothing.
    //   arm B — the await that makes it a graceful exit returns immediately and
    //           `term.kill()` fires straight after: B silently DEGENERATES INTO A while
    //           reporting an exit time of ~0. That is precisely the #191 trap this probe
    //           was written to avoid, reproduced by the probe itself.
    //
    // Both would be invisible in the output — two plausible tables and no error. Found in
    // review. A run that cannot see the agent has measured nothing, so it must say so.
    if (!R.claudePid) {
      throw new Error(
        'agent process not found under the shell — every liveness check below would '
        + 'pass vacuously and arm B would degenerate into arm A. The pid is matched by '
        + 'name, so a shim install (an npm wrapper runs as node.exe) lands here; widen '
        + 'the matcher rather than letting the run continue.',
      );
    }

    // --- identical real work -------------------------------------------------
    // Registry submit discipline: text, then the CR ALONE after submit.gapMs. An
    // atomic `text\r` at this length is measured NOT to submit (#55).
    await sleep(600);
    term.write(PROMPT);
    await sleep(GAP_MS);
    term.write('\r');
    note(`prompt submitted (${PROMPT.length} chars, CR split by ${GAP_MS}ms)`);

    // Turn complete = the Stop hook fired. Not the screen: it cannot tell a typed
    // line from a submitted one, which is the whole reason this class of bug survives.
    const stopMarker = path.join(markerDir, 'FIRED-Stop.txt');
    const turnDeadline = Date.now() + 240000;
    while (!fs.existsSync(stopMarker) && Date.now() < turnDeadline && !exited) await sleep(400);
    if (!fs.existsSync(stopMarker)) throw new Error('no Stop hook within 240s — the turn never completed');
    R.turnMs = Date.now() - t0;
    note(`turn complete (Stop hook) at ${R.turnMs}ms`);

    // --- quiesce, then snapshot BEFORE the end-action -------------------------
    // The `ai-title` line is generated asynchronously after the first prompt; without a
    // settle it can land inside the teardown window and be misread as a flush.
    //
    // `--dwell` extends the session's LIFETIME without spending another turn. It exists
    // because the first run of this probe found NO transcript jsonl at all in a ~16s
    // session, and "claude writes it on a debounce" and "claude never writes it here"
    // are indistinguishable from one short session. The poll records WHEN the file
    // first appears, which is the number that separates them.
    {
      const until = Date.now() + opts.dwellMs + opts.presettleMs;
      while (Date.now() < until) {
        if (R.transcriptFirstSeenMs == null && findTranscripts(cfgDir).length) {
          R.transcriptFirstSeenMs = Date.now() - t0;
          note(`transcript jsonl first appeared at ${R.transcriptFirstSeenMs}ms`);
        }
        await sleep(1000);
      }
    }
    R.hooksBefore = readHooks();
    R.treeBefore = snapshotTree(cfgDir);
    const tBefore = findTranscripts(cfgDir);
    R.transcriptPath = tBefore.length ? tBefore[0].path : null;
    R.transcriptBefore = R.transcriptPath ? readTranscript(R.transcriptPath) : null;
    R.jsonBefore = fs.readFileSync(path.join(cfgDir, '.claude.json'), 'utf8');
    note(`snapshot BEFORE: ${R.treeBefore.size} files, transcript ${R.transcriptBefore ? R.transcriptBefore.lines + ' lines / ' + R.transcriptBefore.bytes + ' bytes' : '(none found)'}`);

    // --- THE ONLY DIFFERENCE BETWEEN THE ARMS --------------------------------
    const tEnd = Date.now();
    if (arm === 'A') {
      // pty-worker.js killSession: no warning, no signal, `session.term.kill()`. Its
      // `_inputQueue = null` line has no analogue here because nothing is withheld at
      // this point — but that IS the #191 hazard for arm B, see below.
      note('HARD KILL: term.kill()');
      term.kill();
      // Does production's Kill actually reach the AGENT? It kills the shell; claude is
      // a grandchild. If claude outlived it, "hard kill" would be a graceful exit
      // wearing a disguise, and #191's premise would be answered by that alone.
      const killDeadline = Date.now() + 20000;
      while (alive(R.claudePid) && Date.now() < killDeadline) await sleep(200);
      R.agentGoneMs = Date.now() - tEnd;
      R.agentSurvivedKill = alive(R.claudePid);
      note(`agent ${R.agentSurvivedKill ? 'SURVIVED the kill' : `died ${R.agentGoneMs}ms after it`}`);
    } else if (arm === 'C') {
      // THE CONTROL, and what makes the A-vs-B answer trustworthy: terminate the AGENT
      // process itself, with no console-close signal at all. On Windows `process.kill`
      // is TerminateProcess — no handler runs, nothing is flushed. If C writes the same
      // state A does, A's write proves nothing about the teardown; if C writes nothing,
      // A's write can only have come from claude's own shutdown path.
      //
      // The pid is one this function discovered by walking DOWN from a pid it spawned.
      note(`TERMINATE: process.kill(${R.claudePid}) — no console close, no handler`);
      try { process.kill(R.claudePid); } catch (e) { note(`terminate failed: ${e.message}`); }
      const killDeadline = Date.now() + 20000;
      while (alive(R.claudePid) && Date.now() < killDeadline) await sleep(200);
      R.agentGoneMs = Date.now() - tEnd;
      R.agentSurvivedKill = alive(R.claudePid);
      note(`agent ${R.agentSurvivedKill ? 'SURVIVED terminate' : `terminated after ${R.agentGoneMs}ms`}`);
      try { term.kill(); } catch { /* the shell goes too */ }
    } else {
      // The trap #191 itself warns about: writing `/exit` and killing immediately means
      // the CR is still withheld when the PTY dies, so arm B silently degenerates into
      // arm A while looking like it worked. So the CR goes out on the registry's gap and
      // the process is AWAITED.
      note('GRACEFUL: submitting /exit');
      term.write('/exit');
      await sleep(GAP_MS);
      term.write('\r');
      // Waited on the AGENT's pid, not on the PTY: `/exit` drops back to the bash
      // prompt, and bash lives on. Corroborated by the SessionEnd hook marker, which is
      // claude's own on-disk statement that it is shutting down.
      const sessionEndMarker = path.join(markerDir, 'FIRED-SessionEnd.txt');
      const exitDeadline = Date.now() + opts.exitTimeoutMs;
      let nudged = false;
      while (alive(R.claudePid) && Date.now() < exitDeadline) {
        // A slash line opens claude's command menu; if Enter only accepted the
        // completion rather than running it, one more CR settles it. Whether this was
        // needed is REPORTED, because #191's design depends on it.
        if (!nudged && Date.now() - tEnd > 8000) {
          nudged = true;
          R.extraCrNeeded = true;
          note('no exit after 8s — sending one more CR');
          term.write('\r');
        }
        await sleep(200);
      }
      R.exitAwaitedMs = Date.now() - tEnd;
      R.agentSurvivedKill = alive(R.claudePid);
      R.sessionEndSeen = fs.existsSync(sessionEndMarker);
      if (R.agentSurvivedKill) note(`!! /exit did NOT end the agent within ${opts.exitTimeoutMs}ms`);
      else note(`agent exited on its own ${R.exitAwaitedMs}ms after /exit (SessionEnd marker: ${R.sessionEndSeen})`);
      // Dispose the PTY afterwards, exactly as #191 proposes.
      try { term.kill(); } catch { /* already gone */ }
    }
    R.exitCode = exited ? exited.exitCode : null;

    // --- settle, then snapshot AFTER -----------------------------------------
    await sleep(opts.settleMs);
    R.hooksAfter = readHooks();
    R.treeAfter = snapshotTree(cfgDir);
    // A transcript created only at teardown would not be in tBefore at all — so the
    // AFTER list is re-derived rather than re-stat'ing the BEFORE path. "It appeared
    // only at exit" and "it was there all along" are different answers to #191.
    const tAfter = findTranscripts(cfgDir);
    const afterPath = R.transcriptPath || (tAfter.length ? tAfter[0].path : null);
    R.transcriptAfter = afterPath ? readTranscript(afterPath) : null;
    R.transcriptCount = { before: tBefore.length, after: tAfter.length };
    R.transcriptPathsAfter = tAfter.map((t) => t.path);
    R.jsonAfter = fs.readFileSync(path.join(cfgDir, '.claude.json'), 'utf8');
    note(`snapshot AFTER : ${R.treeAfter.size} files, transcript ${R.transcriptAfter ? R.transcriptAfter.lines + ' lines / ' + R.transcriptAfter.bytes + ' bytes' : '(none)'}`);

    R.noteTxt = fs.existsSync(path.join(cwd, 'note.txt'))
      ? fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8').trim().slice(0, 60)
      : null;
    R.screen = opts.dump ? stripAnsi(raw).split('\n').filter((l) => l.trim()).slice(-25).join('\n') : null;
    // The derivation the repo's own SSOT claims (lib/transcript.js claudeProjectDirName)
    // — cross-checked against what actually landed rather than assumed.
    R.derivedProject = claudeProjectDirName(cwd);
    R.actualProject = tAfter.length ? tAfter[0].project : null;

    return await finish(null);
  } catch (e) {
    console.log(`  [${arm}${run}] FAILED: ${e.message}`);
    if (raw) console.log(stripAnsi(raw).split('\n').filter((l) => l.trim()).slice(-18).join('\n'));
    return await finish(e);
  }
}

// ---------------------------------------------------------------- reporting

function reportArm(R) {
  console.log(`\n--- arm ${R.arm} run ${R.run} ------------------------------------------------`);
  if (R.error) { console.log(`  ERROR: ${R.error}`); if (!R.treeAfter) return; }
  console.log(`  cfg          ${R.cfgDir}`);
  console.log(`  ready        ${R.readyMs}ms      turn complete ${R.turnMs}ms`);
  console.log(`  jsonl first seen at ${R.transcriptFirstSeenMs == null ? 'NEVER (while alive)' : R.transcriptFirstSeenMs + 'ms'}`);
  console.log(`  trust dialog ${R.trustDialog}   imports dialog ${!!R.importsDialog}`);
  console.log(`  tool output  note.txt = ${R.noteTxt === null ? '(NOT WRITTEN)' : JSON.stringify(R.noteTxt)}`);
  if (R.arm === 'B') {
    console.log(`  /exit        agent gone=${!R.agentSurvivedKill} after ${R.exitAwaitedMs}ms  extraCrNeeded=${R.extraCrNeeded}  SessionEnd=${R.sessionEndSeen}`);
  } else {
    const how = R.arm === 'C' ? 'terminate  ' : 'hard kill  ';
    console.log(`  ${how}  agent gone=${!R.agentSurvivedKill} after ${R.agentGoneMs}ms  (agent pid ${R.claudePid})`);
  }
  console.log(`  survivors    ${R.survivors.length ? JSON.stringify(R.survivors) : 'none'}`);
  console.log(`  project dir  derived=${R.derivedProject} actual=${R.actualProject} ${R.derivedProject === R.actualProject ? '(match)' : '(MISMATCH)'}`);

  const tb = R.transcriptBefore; const ta = R.transcriptAfter;
  if (tb && ta) {
    console.log(`  transcript   ${tb.lines} lines / ${tb.bytes} B  ->  ${ta.lines} lines / ${ta.bytes} B   (+${ta.lines - tb.lines} lines, +${ta.bytes - tb.bytes} B)`);
    console.log(`    last line before : ${tb.rows.length ? tb.rows[tb.rows.length - 1].type : '(empty)'}`);
    console.log(`    last line after  : ${ta.rows.length ? ta.rows[ta.rows.length - 1].type : '(empty)'}`);
    for (let i = tb.lines; i < ta.lines; i++) {
      console.log(`    NEW LINE ${i}: type=${ta.rows[i].type} role=${ta.rows[i].role}`);
      console.log(`       ${ta.rows[i].preview}`);
    }
  } else {
    console.log(`  transcript   before=${tb ? tb.lines + ' lines' : '(none)'} after=${ta ? ta.lines + ' lines' : '(none)'}`);
  }
  console.log(`  jsonl files  before=${R.transcriptCount ? R.transcriptCount.before : '?'} after=${R.transcriptCount ? R.transcriptCount.after : '?'}  ${(R.transcriptPathsAfter || []).join(' ')}`);

  const d = diffTrees(R.treeBefore, R.treeAfter);
  console.log(`  config tree  +${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed`);
  for (const a of d.added) console.log(`    ADDED   ${a.rel} (${a.size} B)`);
  for (const c of d.changed) console.log(`    CHANGED ${c.rel} (${c.from} -> ${c.to} B)`);
  for (const r of d.removed) console.log(`    REMOVED ${r.rel}`);

  const kd = jsonKeyDiff(R.jsonBefore, R.jsonAfter);
  if (kd && kd.length) {
    console.log('  .claude.json key diff (before -> after the end-action):');
    for (const row of kd) console.log(`    ${row.k}\n        ${row.from}  ->  ${row.to}`);
  } else if (kd) {
    console.log('  .claude.json: byte-identical across the end-action');
  }

  const before = R.hooksBefore || {};
  const after = R.hooksAfter || {};
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  console.log(`  hooks fired  ${names.length ? names.map((n) => `${n}x${(after[n] || before[n]).count}`).join(' ') : '(none)'}`);
  for (const n of names) {
    const b = before[n] ? before[n].count : 0;
    const a = after[n] ? after[n].count : 0;
    if (a > b) console.log(`    ${n}: ${a - b} MORE after the end-action (fired at ${hhmmss(after[n].mtimeMs)})`);
  }
}

function reportCompare(results) {
  // Only the arms actually run get a column: a C-only run must not print an empty
  // A and B beside it, which reads as "measured, and the answer was nothing".
  const present = ['A', 'B', 'C'].filter((a) => results.some((r) => r.arm === a));
  console.log(`\n\n================= ${present.join(' vs ')} ==============================================`);
  const row = (label, fn) => {
    const cells = present
      .map((a) => `${a}: ${results.filter((r) => r.arm === a).map(fn).join(' | ')}`.padEnd(30))
      .join(' ');
    console.log(`  ${label.padEnd(34)} ${cells}`);
  };
  const lines = (r) => (r.transcriptAfter ? r.transcriptAfter.lines : '?');
  const bytes = (r) => (r.transcriptAfter ? r.transcriptAfter.bytes : '?');
  const lastType = (r) => (r.transcriptAfter && r.transcriptAfter.rows.length ? r.transcriptAfter.rows[r.transcriptAfter.rows.length - 1].type : '?');
  const gained = (r) => (r.transcriptBefore && r.transcriptAfter ? r.transcriptAfter.lines - r.transcriptBefore.lines : '?');
  const treeAdds = (r) => (r.treeBefore && r.treeAfter ? diffTrees(r.treeBefore, r.treeAfter).added.length : '?');
  const treeChg = (r) => (r.treeBefore && r.treeAfter ? diffTrees(r.treeBefore, r.treeAfter).changed.length : '?');
  const gracefulFlag = (r) => {
    try {
      const j = JSON.parse(r.jsonAfter);
      const k = Object.keys(j.projects || {}).find((x) => x.replace(/\\/g, '/').toLowerCase() === r.cwd.replace(/\\/g, '/').toLowerCase());
      return k ? String(j.projects[k].lastGracefulShutdown) : '(no entry)';
    } catch { return '?'; }
  };
  row('transcript lines (final)', lines);
  row('transcript bytes (final)', bytes);
  row('lines gained AT teardown', gained);
  row('LAST line type', lastType);
  row('config files added at teardown', treeAdds);
  row('config files changed at teardown', treeChg);
  row('projects[cwd].lastGracefulShutdown', gracefulFlag);
  row('SessionEnd hook fired', (r) => String(!!((r.hooksAfter || {}).SessionEnd)));
  row('Stop hook fired', (r) => String(!!((r.hooksAfter || {}).Stop)));
  row('agent gone after teardown', (r) => String(!r.agentSurvivedKill));
  row('ms for the agent to go', (r) => String(r.arm === 'B' ? r.exitAwaitedMs : r.agentGoneMs));
  row('jsonl first seen (ms)', (r) => String(r.transcriptFirstSeenMs == null ? 'never' : r.transcriptFirstSeenMs));
  row('survivors after teardown', (r) => String(r.survivors.length));
  console.log('==========================================================================');
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const get = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  return {
    runs: parseInt(get('--runs', '2'), 10),
    arms: String(get("--arms", "AB")).toUpperCase().replace(/[^ABC]/g, "").split(""),
    keep: argv.includes('--keep'),
    clean: argv.includes('--clean'),
    dump: argv.includes('--dump'),
    settleMs: parseInt(get('--settle', '8000'), 10),
    presettleMs: parseInt(get('--presettle', '6000'), 10),
    dwellMs: parseInt(get('--dwell', '0'), 10),
    exitTimeoutMs: parseInt(get('--exit-timeout', '60000'), 10),
    minTokenLife: parseInt(get('--min-token-life', '30'), 10),
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.clean) {
    // Only ever the probe's OWN parent, and only the children it names. The default
    // parent is created by this script; a caller-supplied one may hold other things.
    if (!fs.existsSync(PROBE_PARENT)) { console.log(`nothing to clean — ${PROBE_PARENT} does not exist`); return; }
    const MINE = /^(cfg|work|markers)-[ABC]\d+-[0-9a-z]+$/;
    for (const name of fs.readdirSync(PROBE_PARENT)) {
      if (!MINE.test(name)) { console.log(`  keeping ${name} — not created by this probe`); continue; }
      shred(path.join(PROBE_PARENT, name, '.credentials.json'));
      rmrf(path.join(PROBE_PARENT, name));
      console.log(`  removed ${name}`);
    }
    if (!process.env.WT_EXIT_FLUSH_DIR && fs.readdirSync(PROBE_PARENT).length === 0) {
      fs.rmdirSync(PROBE_PARENT);
      console.log(`removed ${PROBE_PARENT}`);
    }
    return;
  }

  // --- preflight -------------------------------------------------------------
  let version = '(unknown)';
  try {
    version = execFileSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) { console.error(`cannot run claude: ${e.message}`); process.exit(2); }

  if (!fs.existsSync(REAL_CREDS)) {
    console.error(`no credentials at ${REAL_CREDS} — an isolated CLAUDE_CONFIG_DIR cannot authenticate`);
    process.exit(2);
  }
  const credsHashBefore = sha1File(REAL_CREDS);
  let minutesLeft = 0;
  try {
    const j = JSON.parse(fs.readFileSync(REAL_CREDS, 'utf8'));
    minutesLeft = ((j.claudeAiOauth.expiresAt - Date.now()) / 60000);
  } catch { minutesLeft = 0; }
  console.log(`claude version        : ${version}`);
  console.log(`access token life     : ${minutesLeft.toFixed(0)} min`);
  if (minutesLeft < opts.minTokenLife) {
    // The whole reason copying credentials is safe here. Below this margin the copy
    // could trigger a refresh, and an OAuth refresh ROTATES the token — the same hazard
    // CLAUDE.md records for ~/.codex/auth.json. Refuse rather than gamble.
    console.error(`REFUSING TO RUN: the access token has ${minutesLeft.toFixed(0)} min left (< ${opts.minTokenLife}).`);
    console.error('A copied credential could be refreshed mid-run, and a refresh rotates the token.');
    process.exit(2);
  }
  console.log(`probe parent          : ${PROBE_PARENT}`);
  console.log(`shell                 : ${SHELL}`);
  console.log(`launch                : ${LAUNCH}`);
  console.log(`composer marker       : ${COMPOSER}  (submit gap ${GAP_MS}ms)`);
  console.log(`arms                  : ${opts.arms.join(',')} x ${opts.runs} run(s)\n`);
  fs.mkdirSync(PROBE_PARENT, { recursive: true });

  const results = [];
  try {
    for (let run = 1; run <= opts.runs; run++) {
      for (const arm of opts.arms) {
        console.log(`\n### arm ${arm}, run ${run} #############################################`);
        results.push(await runArm(arm, run, opts));
      }
    }
  } finally {
    for (const r of results) reportArm(r);
    if (results.length) reportCompare(results);

    // The hazard is a refresh, which ROTATES the token and can get the whole family
    // revoked by reuse-detection. Two DIFFERENT files can show one, and only one of
    // them is the child's:
    //
    //   the COPY     -> the child refreshed. This is the hazard. Checked per arm in
    //                   finish(), because the copy is shredded there.
    //   the ORIGINAL -> the HOST's own claude refreshed while the probe ran. A different
    //                   event, and not the child's doing — but worth printing, because
    //                   the copies then carried a token the host has superseded.
    //
    // Hashing the original and calling it a refresh check was this file's own bug: the
    // child cannot reach that file, so it reads "unchanged" however badly the run went.
    // What actually makes a refresh impossible is the --min-token-life refusal above.
    const rotated = results.filter((r) => r.credsRotated === true);
    const uncheckable = results.filter((r) => r.credsRotated == null);
    const copyVerdict = rotated.length ? rotated.map((r) => r.tag).join(', ') : 'no';
    const unsure = uncheckable.length ? `  (${uncheckable.length} could not be checked)` : '';
    console.log(`\ncredential COPY moved during a run: ${copyVerdict}${unsure}`);
    if (rotated.length) {
      console.log('*** THE CHILD REFRESHED THE COPIED TOKEN. A refresh ROTATES it, so the ***');
      console.log('*** original may now be stale and reuse-detection can revoke the family. ***');
      console.log('*** Check that claude still works; re-login if it does not. This should  ***');
      console.log('*** be unreachable with --min-token-life honoured — raise the margin.    ***');
    }

    const credsHashAfter = sha1File(REAL_CREDS);
    console.log(`the real ~/.claude/.credentials.json moved during this run: ${credsHashBefore !== credsHashAfter}`);
    if (credsHashBefore !== credsHashAfter) {
      console.log('*** The HOST refreshed its own token mid-run (the child cannot write ***');
      console.log('*** this file). Harmless to the host; the copies held a stale token. ***');
    }

    // Isolation audit: did anything reach the REAL config after all?
    try {
      const realJson = JSON.parse(fs.readFileSync(REAL_CLAUDE_JSON, 'utf8'));
      const leaked = Object.keys(realJson.projects || {})
        .filter((k) => k.replace(/\\/g, '/').toLowerCase().includes('wt-exit-flush'));
      console.log(`isolation: ~/.claude.json projects entries under the probe parent: ${leaked.length ? leaked.join(', ') : 'NONE (isolated)'}`);
    } catch { console.log('isolation: could not read ~/.claude.json'); }
    const realProjects = path.join(REAL_CLAUDE_DIR, 'projects');
    try {
      const leakedDirs = fs.readdirSync(realProjects).filter((d) => /wt-exit-flush/i.test(d));
      console.log(`isolation: ~/.claude/projects dirs under the probe parent: ${leakedDirs.length ? leakedDirs.join(', ') : 'NONE (isolated)'}`);
    } catch { /* ignore */ }

    // The credential copies go regardless of --keep. Everything else honours it.
    for (const r of results) shred(path.join(r.cfgDir, '.credentials.json'));
    if (!opts.keep) {
      for (const r of results) { rmrf(r.cfgDir); rmrf(r.cwd); rmrf(r.markerDir); }
      console.log('probe trees removed (pass --keep to inspect them)');
    } else {
      console.log(`probe trees kept under ${PROBE_PARENT} (credentials copies shredded)`);
    }
    // node-pty keeps a handle open after the child is gone, so the event loop never
    // drains and the process sits there forever with every result already printed.
    // The other probes in this directory end the same way, for the same reason.
    setTimeout(() => process.exit(results.some((r) => r.error) ? 1 : 0), 200);
  }
})().catch((e) => { console.error(e); process.exit(3); });
