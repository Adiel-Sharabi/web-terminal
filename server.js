const express = require('express');
const expressWs = require('express-ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { performance } = require('perf_hooks');
const workerClientLib = require('./lib/worker-client');
const { mintDirectToken, verifyDirectToken } = require('./lib/cluster-token');
const { sanitizeReplay } = require('./lib/replay-sanitize');
const { normalizeCwd } = require('./lib/cwd');
const { createBackgroundScanner, notEnded: notEndedTasks, addChildWork, childVerdicts } = require('./lib/background-tasks');
const { execGit, gitSafeArgs, gitSafeEnv } = require('./lib/git-safe');
const { resolveBin: resolveListingBin } = require('./lib/background-listing');
const { createBackgroundListing } = require('./lib/background-listing-runner');
const { createThreadedExec } = require('./lib/background-listing-exec');
const gitFreshness = require('./lib/git-freshness');
const { readBuildId } = require('./lib/build-id');
const notifyPush = require('./lib/notify-push');
const transcript = require('./lib/transcript');
const processTree = require('./lib/process-tree');
const callerSession = require('./lib/caller-session');
const slowLog = require('./lib/slow-log');
const speech = require('./lib/speech');
const agentsLib = require('./lib/agents');
const commandsLib = require('./lib/commands');
const { getAdapter } = agentsLib;
const { rollUpUsage, METRICS_TTL_MS } = require('./lib/usage-rollup');
const resourcesLib = require('./lib/resources');
const machineProfile = require('./lib/machine-profile');
const { createLeaseBroker } = require('./lib/lease-broker');
const { waitingFor: waitingForRule } = require('./lib/waiting-for');
const taskListLib = require('./lib/task-list');
const briefLib = require('./lib/session-brief');
const sessionReasonLib = require('./lib/session-reason');
const handoffLib = require('./lib/handoff');
const checkInLib = require('./lib/check-in'); // #443 - check in on a stale self-wait
const checkInPrecheck = require('./lib/check-in-precheck'); // #540 - a cheap model reads the tail first
const workItems = require('./lib/work-items'); // #413 - work-item resume: the rules
const workItemLog = require('./lib/work-item-log');
const workItemHook = require('./lib/work-item-hook');
const contextBudgetLib = require('./lib/context-budget');
const maintLib = require('./lib/maintenance');
const usageLimit = require('./lib/usage-limit');
// #190 — imported for ONE thing: the default of `autoAnswerBlockingPrompt`, so this
// endpoint cannot report a setting the worker does not have (#240's exact defect).
const blockingPrompt = require('./lib/blocking-prompt');
const notificationShape = require('./lib/notification-shape');
const peerFetchLog = require('./lib/peer-fetch-log');
const peerTokens = require('./lib/peer-tokens'); // #415 - token lifetime, renewal, grace, expiry warning
const { isDirectLocalRequest } = require('./lib/local-request');
const deviceOps = require('./lib/device-ops');
const answerPace = require('./lib/answer-pace');
const usageLog = require('./lib/usage-log'); // #425 - skip reasons, session cost, viewer time
const reconnectBuffer = require('./lib/reconnect-buffer');
// #146 — the pure smallest-active-viewer-wins rule for one PTY with many viewers.
const terminalSize = require('./lib/terminal-size');
// #351 - the pure rule for closing agent-started sessions nobody came back to.
const spawnReaper = require('./lib/spawn-reaper');
const closeoutLib = require('./lib/closeout'); // #469 - R5: close-out, then close or mark ready
const { createSpawnStore, goalOf: spawnGoalOf } = require('./lib/spawn-store');
// #466 - the supervisor, phase 1: wait targets, the sessions journal, the gated prompt
// route and the cluster work graph. Hot-reload only: nothing in the worker loads them.
const waitTargetLib = require('./lib/wait-target');
const journalLib = require('./lib/session-journal');
const supervisorLib = require('./lib/supervisor');
const replacementLib = require('./lib/replacement');
const ansiLib = require('./lib/ansi');
const { isWtHook } = require('./scripts/install-hooks');
const supCases = require('./lib/supervisor-cases'); // #468 cases, verbs, cards
const modelFlag = require('./lib/model-flag'); // #533 --model per task (one owner with the dispatcher's model)
const { SUPERVISOR_PROMPT_TAG } = require('./lib/user-turn'); // #468 the dispatcher's first prompt
const { createCirclingScanner } = require('./lib/circling'); // #468 R9
const safePrompt = require('./lib/safe-prompt');
const composerDraft = require('./lib/composer-draft'); // #479
// #467 - phase 2: quiet hours (nights, Shabbat, Yom Tov). Hot-reload only.
const quietLib = require('./lib/quiet-hours');
const leasesLib = require('./lib/leases');
const trackerMeta = require('./lib/tracker-meta'); // #502 - a work item's details, from its tracker
const projectsLib = require('./lib/projects'); // #503 - projects and areas
const { mcRefusal } = require('./lib/mc-authority'); // #501 - who answers /api/mc/*
const mcSubjects = require('./lib/mc-subjects'); // #504 - one work item across every session and machine
const mcStage = require('./lib/mc-stage'); // #505 - the progress-stage order and evidence rule
const mcStateLib = require('./lib/mc-state'); // #505 - Mission Control's persisted state (stage history)
const mcNeeds = require('./lib/mc-needs'); // #506 - Answer now vs My to-do, ranked by what it blocks
const { createPromptEpisodes } = require('./lib/mc-episodes'); // #506 - a prompt on screen keeps one card id
const mcAnalyst = require('./lib/mc-analyst'); // #511 - Ask, a read-only Analyst
const mcBinding = require('./lib/mc-binding'); // #512 - a session bound to a project and subjects at birth
const mcStart = require('./lib/mc-start'); // #512 - Start work: the request, the name and brief, the machine
const mcLines = require('./lib/mc-lines'); // #523 - lines of work: which line a work item is on
const mcQuestions = require('./lib/mc-questions'); // #510 - questions with context on demand
const recap = require('./lib/recap');
// #383 - the model-written summary of one inbox wait. Hot-reload only: nothing in the worker loads it.
const inboxDigest = require('./lib/inbox-digest');
// #389 - this machine's Claude login and the switch between saved accounts. Hot-reload only.
const claudeAccount = require('./lib/claude-account');
const autoSwitchLib = require('./lib/account-autoswitch');
const { DIRS: SCRATCH_DIRS } = require('./scripts/scratch-dirs');
const { parseStatusPayload, mergeStatus, hasReading } = require('./lib/metrics-claude');
const fcm = require('./lib/fcm');

const SERVER_VERSION = '1.133.2'; // The RELEASE number: it moves only when the owner cuts a release, never per change. A build is named by the commit hash + date /api/version serves (lib/build-id.js).

// --- Optional latency instrumentation (opt-in via WT_LATENCY_DEBUG=1) -----
// Event-loop lag monitor: interval is 10ms; anything ≥ 50ms slip is a stall.
// Slow-op wrapper: call sites tag sync/async blocks and we log any > 30ms.
const _LATENCY_DEBUG = process.env.WT_LATENCY_DEBUG === '1';
if (_LATENCY_DEBUG) {
  let _lagLast = performance.now();
  const _lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - _lagLast - 10;
    if (lag > 50) {
      const mem = process.memoryUsage();
      console.log(`[latency-lag] ${new Date().toISOString()} stall=${lag.toFixed(0)}ms heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`);
    }
    _lagLast = performance.now();
  }, 10);
  if (typeof _lagTimer.unref === 'function') _lagTimer.unref();
}
function _slowOp(name, fn) {
  if (!_LATENCY_DEBUG) return fn;
  return async function _wrapped(...args) {
    const t0 = performance.now();
    try { return await fn.apply(this, args); }
    finally {
      const dur = performance.now() - t0;
      if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} ${name} dur=${dur.toFixed(0)}ms`);
    }
  };
}
// --- /api/sessions phase timing (ALWAYS ON, logs only when slow) ----------
// This is the route clients time out on: it is the only session route that goes
// through the worker RPC, so when it goes slow a peer is reported UNREACHABLE
// while /api/version still answers in 20ms and every cheap health check passes.
// On 2026-09-22 it sat at 17-28s for a stretch and NOTHING in any log said which
// of its phases was responsible - the worker RPC, the bounded transcript reads,
// or the process-tree snapshot, which spawns a PowerShell and is the one
// unbounded call in the handler.
//
// Deliberately NOT behind WT_LATENCY_DEBUG. That flag is read at startup, so
// arming it costs a COLD RESTART - which both destroys the state being
// investigated and has to be done BEFORE an intermittent fault, i.e. never. An
// instrument nobody can arm in time is not an instrument. The cost when nothing
// is slow is four performance.now() calls and one comparison.
// The threshold and the throttle are PURE and live in lib/slow-log.js, with
// their own specs - both of this helper's failure modes (a throttle that pins,
// a comparison that swallows NaN) look exactly like "nothing was slow" from out
// here, which is the answer a reader is already inclined to believe.
const SESSIONS_SLOW_MS = 5000;
const SESSIONS_SLOW_LOG_GAP_MS = 30000;
let _sessionsSlowLoggedAt = 0;
function _logSlowSessions(phases, totalMs) {
  const now = Date.now();
  if (!slowLog.shouldLogSlow({
    totalMs, thresholdMs: SESSIONS_SLOW_MS, lastLoggedAt: _sessionsSlowLoggedAt,
    now, gapMs: SESSIONS_SLOW_LOG_GAP_MS,
  })) return;
  // Throttled because a box in this state serves several polls a second and the
  // synchronous log write would itself become part of the problem.
  _sessionsSlowLoggedAt = now;
  console.log('[slow-sessions] ' + slowLog.formatSlowPhases(phases, totalMs));
}

// Stale status auto-correction now lives in pty-worker.js.

// --- Config: config.json > env vars > defaults ---
// Use separate config file during tests to avoid corrupting production config.
//
// `WT_CONFIG_FILE` redirects it outright, and it exists for the same reason
// `WT_CLUSTER_TOKENS_FILE` and `WT_CLAUDE_METRICS_FILE` do: a test that has to drive a
// destructive config path needs a file of its own, and REDIRECTING the path is stronger
// than backing the real one up - an interrupted run never reaches its restore, but it can
// never open a file it was not pointed at. #264's `/api/setup` case cannot be reached any
// other way: the route is gated on `needsPasswordChange()`, so it opens only on a server
// whose PASS is the default, which the suite's own server is not and must not become.
// `config.test.json` is no help there either, because the suite's server is already
// holding it.
//
// ALL THREE SUPERVISED PROCESSES READ THE SAME VARIABLE — here, `pty-worker.js` (its own
// CONFIG_FILE, ~:91) and `monitor.js` (its health-check port read). Three processes
// deriving one path independently is exactly the drift this repo keeps paying for, and an
// override honoured by only some of them would not isolate a test, it would split one live
// setting across the tree. They inherit the environment from whoever spawned them, so
// setting it once reaches all three.
//
// THE SCOPE IS THE SUPERVISED TRIO, AND THE PREDICATE IS "RESOLVES A CONFIG PATH".
//
// STATE THE PREDICATE, NOT THE GREP - because this paragraph got the count wrong TWICE
// before it got it right, which is the defect this file elevates to a code bug. The first
// draft said a grep "finds exactly one more site"; the second said `git ls-files '*.js'`
// for `'config.json'` and "here is all of it", which is false for that command as written
// - it returns eight lines across seven files. Two of them merely NAME the string and
// resolve nothing (`tests/check-no-secrets.spec.js:142`, a gitignore fixture listing the
// filename, and a `toContain('config.json')` inside a comment in
// `tests/issue257-config-merge-base-unreadable.spec.js:93`). Under the predicate that
// actually matters - sites that RESOLVE a config path - there are six, and here they are:
//
//   monitor.js:448              - the third supervised process. HONOURS the override.
//   cluster-monitor.js:45       - DELIBERATELY NOT. A standalone diagnostic a human runs
//                                 against the live box; it has no WT_TEST branch either,
//                                 because reading the REAL config is its whole job.
//   scripts/rig/rig.js:91       - WRITES a config into the rig's own isolated tree.
//   tests/test-helpers.js:81,92 - read the real config for `claudeHome` only (#177).
//   tests/global-teardown.js:5  - restores the real config after a run.
//
// So: three processes resolve the LIVE config path and all three honour it; every other
// site either writes elsewhere or is reading production on purpose.
const CONFIG_FILE = process.env.WT_CONFIG_FILE
  || (process.env.WT_TEST ? path.join(__dirname, 'config.test.json') : path.join(__dirname, 'config.json'));
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'config.default.json');

// #257 - ABSENT and UNREADABLE are different answers, and collapsing them is what let a
// PUT quietly go back to replacing the file.
//
// `readConfig()` answered `{}` for both: for a config.json that is not there (a
// legitimate first run) and for one that is there but will not parse (truncated,
// half-written, mid-edit). #242 made the PUT merge over `readConfig()`, so on a parse
// error the merge base was `{}` and `Object.assign({}, sanitized)` wrote a file holding
// only the keys the request body carried - the exact pre-#242 replace, silently, at the
// one moment `cluster` and `publicUrl` most needed preserving. Both paths returned 200,
// so no caller could tell.
//
// This is the one owner of "ABSENT or UNREADABLE?" - not, as this comment claimed until
// review of #261, the one owner of "what does config.json say". THREE other sites parse
// CONFIG_FILE directly and each swallows a parse error on purpose: the startup load,
// `_refreshLiveConfig` (which keeps the last good cache) and GET /api/config (which serves
// defaults). Those are read paths where degrading is right. The distinction below matters
// to a path that WRITES, and routing the readers through here is a separate change with
// its own blast radius.
//
// THE STARTUP LOAD IS NOT SYMMETRIC, and saying "it falls back to config.default.json"
// flat would be wrong in exactly the case this function exists for. It falls back when
// CONFIG_FILE is ABSENT. When it is UNREADABLE the parse throws inside the first `if`, the
// `else if` is never evaluated, `config` stays `{}`, and every value becomes the code
// literal - `PASS` included, which is how a corrupt file drops the server to the default
// password AT ITS NEXT START and opens the unauthenticated /api/setup route. Not "a
// running server": `PASS` is assigned once here and reassigned only by the auto-hash and
// the setup route, so nothing re-reads it from disk while the process lives. That is #264,
// filed separately; it is named here because this is the comment a reader lands on first.
//
// `readConfig()` keeps its signature for the callers that only want the object; a caller
// whose CORRECTNESS depends on the difference asks for the result instead.
//
// EVERY WRITE PATH NOW ASKS FOR THE RESULT, and the count is measured rather than
// guessed. `PUT /api/config` took the guard in #257; `POST /api/setup` and
// `POST /api/cluster/register` took it in #264. That leaves exactly ONE `readConfig()`
// caller that reads in order to write: the startup password auto-hash.
//
// IT NEEDS NO GUARD, and the reason is structural rather than lucky. Its own condition is
// `!DEFAULT_PASSWORDS.includes(PASS)`, and an unreadable config leaves `PASS` on the
// `'admin'` literal - so the one state that would make the read dangerous is the one state
// that cannot enter the block. The only way in is a plaintext `config.password`, which
// means the file parsed moments earlier. Every other caller reads to SERVE, where `{}` is
// a thinner answer but not a destructive one.
//
// CITED BY NAME, NOT BY LINE, on purpose: the first draft of this comment gave line
// numbers, and every subsequent edit above it - including the one that corrected the
// sentence above - moved them. A citation that rots faster than the claim it supports is
// worse than none, because it reads as precision.
function readConfigResult() {
  if (!fs.existsSync(CONFIG_FILE)) return { ok: true, absent: true, config: {} };
  try {
    return { ok: true, absent: false, config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) {
    return { ok: false, absent: false, config: {}, error: e.message };
  }
}
function readConfig() { return readConfigResult().config; }
let _claudeHome = null;
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  _claudeHome = null; // re-detect on next use
  _liveConfigCache = cfg; _liveConfigTime = Date.now(); // update cache
}
let config = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else if (fs.existsSync(DEFAULT_CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8'));
  }
} catch (e) { console.error('Failed to load config:', e.message); }

const PORT = parseInt(process.env.WT_PORT || config.port || '7681');
let _USER = process.env.WT_USER || config.user || 'admin';
let PASS = process.env.WT_PASS || config.password || 'admin';
// The shell a session's PTY is spawned as — ONE definition of the fallback. pty-worker.js
// reads the same key with the same default, and #152's tree-root guard has to agree with
// what the worker ACTUALLY spawns: a second literal that drifts would make every session
// report unknown, silently and everywhere.
const DEFAULT_SHELL = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
const SHELL = process.env.WT_SHELL || config.shell || DEFAULT_SHELL;
// The LIVE read, matching pty-worker.js's `liveConfig('shell', ...)`. SHELL above is
// resolved once at startup on purpose (it is a restart-key and /api/exec's interpreter);
// a guard on what the worker is spawning RIGHT NOW has to follow a changed setting, or a
// session started after the change reads as unknown until the server is restarted.
function spawnShellName() { return process.env.WT_SHELL || liveConfig('shell', DEFAULT_SHELL); }
function getServerName() { return liveConfig('serverName', os.hostname()); }

// #315 - this machine's colour, so every client can tell at a glance which machine a
// session lives on. DECLARED BY THE SERVER, never assigned by a client from its own
// list order (that gives one machine two colours on two devices). Config `serverColor`
// (#rrggbb); unset means a neutral slate - an honest "no colour chosen" rather than a
// hash that would collide with a status or work-item colour.
const SERVER_COLOR_DEFAULT = '#8E9AB4';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function validServerColor(c) { return typeof c === 'string' && HEX_COLOR_RE.test(c) ? c : null; }
// #413 - config `machineCapabilities` (lib/work-items.js), or null when it is malformed.
function localMachineCapabilities() { return workItems.machineCapabilities(liveConfig('machineCapabilities', null)).capabilities; }
function getServerColor() { return validServerColor(liveConfig('serverColor', null)) || SERVER_COLOR_DEFAULT; }
const _peerColorCache = new Map(); // peer url -> last colour it declared

// Live-reloadable settings (cached, refreshed every 5s to avoid sync I/O stalls)
let _liveConfigCache = null;
let _liveConfigTime = 0;
const LIVE_CONFIG_TTL = 5000; // 5 seconds

function _refreshLiveConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      _liveConfigCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  _liveConfigTime = Date.now();
}

function liveConfig(key, fallback) {
  if (!_liveConfigCache || Date.now() - _liveConfigTime > LIVE_CONFIG_TTL) {
    _refreshLiveConfig();
  }
  if (_liveConfigCache && _liveConfigCache[key] !== undefined) return _liveConfigCache[key];
  return fallback;
}
function getDefaultCwd() { return process.env.WT_CWD || liveConfig('defaultCwd', 'C:\\dev'); }
function getScanFolders() { return liveConfig('scanFolders', [getDefaultCwd()]); }
function getDefaultCommand() {
  let cmd = liveConfig('defaultCommand', '');
  if (!cmd) {
    try { cmd = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8')).defaultCommand || ''; } catch {}
  }
  return cmd;
}
function getScrollbackReplayLimit() { return parseInt(liveConfig('scrollbackReplayLimit', 32768)) || 32768; }

function buildSafeEnv() {
  return config.passAllEnv ? Object.assign({}, process.env, { TERM: 'xterm-256color' }) : {
    TERM: 'xterm-256color',
    HOME: process.env.USERPROFILE || os.homedir(),
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LANG: process.env.LANG || 'en_US.UTF-8',
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    ProgramFiles: process.env.ProgramFiles,
    'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };
}
// Kept for backward compat in startup code
const DEFAULT_CWD = getDefaultCwd();
// Session + scrollback persistence paths are now owned by pty-worker.js.
const CLIPBOARD_DIR = path.join(__dirname, 'clipboard-images');
// #90 — dropped files land here (kept apart from clipboard-images: these are
// arbitrary user files, not screenshots, and the name should say so).
const DROPPED_DIR = path.join(__dirname, 'dropped-files');

/// The stored name for an uploaded drop.
///
/// The name arrives in a CLIENT-SUPPLIED HEADER and is then joined onto a
/// server path, so it is untrusted input on a path-traversal route. Only a
/// basename survives, and only from a conservative charset — that kills `..`,
/// both separators, a `C:` drive prefix and NUL in one step rather than
/// blacklisting them one at a time. Leading dots are stripped so a drop cannot
/// create a hidden file, the length is bounded, and a name that sanitises away
/// to nothing still gets a usable one. A timestamp prefix (added by the caller)
/// keeps two drops of the same name from clobbering each other.
function safeDropName(raw) {
  const base = String(raw == null ? '' : raw).split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || 'file';
}

/// A free path in DROPPED_DIR for [name], keeping the readable `<ts>-<name>`
/// shape. The timestamp alone is NOT enough: two drops in the same millisecond
/// (one multi-file drop is exactly that) would produce the same path and the
/// second would silently overwrite the first, so the agent would be handed two
/// paths naming one file.
function freeDropPath(name) {
  const base = path.join(DROPPED_DIR, `${Date.now()}-${name}`);
  if (!fs.existsSync(base)) return base;
  const ext = path.extname(name);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}
function detectClaudeHome() {
  // 1. Explicit config
  const configured = liveConfig('claudeHome', '');
  if (configured) return configured;
  // 2. Current user profile
  const profile = process.env.USERPROFILE || os.homedir();
  if (fs.existsSync(path.join(profile, '.claude'))) return profile;
  // 3. Scan C:\Users for a profile with .claude (handles scheduled task / Session 0)
  try {
    const usersDir = 'C:\\Users';
    for (const d of fs.readdirSync(usersDir)) {
      if (d === 'Public' || d === 'Default' || d === 'Default User' || d === 'All Users') continue;
      const candidate = path.join(usersDir, d);
      if (fs.existsSync(path.join(candidate, '.claude'))) return candidate;
    }
  } catch {}
  return profile;
}
// The ONE home directory every agent's transcripts hang off. Detection is Claude's
// (config override, then the user profile, then a C:\Users scan for the Session-0
// case); Codex shares it because both agents live under the same user profile.
function transcriptHome() {
  if (!_claudeHome) _claudeHome = detectClaudeHome();
  return _claudeHome;
}
function getClaudeProjectsDir() {
  return path.join(transcriptHome(), ...getAdapter('claude').transcriptDir);
}
// The transcript roots a hook-supplied or derived path may live under, one per agent,
// taken from the provider registry so a new agent needs no change here. Anything
// outside every root is never read.
function getTranscriptRoots() {
  return agentsLib.AGENT_IDS.map((id) => ({
    agent: id,
    dir: path.join(transcriptHome(), ...getAdapter(id).transcriptDir),
  }));
}
// Which agent owns an already-validated transcript path (i.e. which root contains it).
// Defaults to claude so an unrecognised path keeps today's parsing behaviour.
function agentForTranscriptPath(tpath) {
  for (const { agent, dir } of getTranscriptRoots()) {
    let root;
    try { root = fs.realpathSync(dir); } catch { root = dir; }
    if (transcript.isAllowedTranscriptPath(tpath, root)) return agent;
  }
  return 'claude';
}
// M1: sanitize a hook-supplied transcript_path before we ever trust it. Any hook
// can set transcript_path, and /attention + the ntfy detail then read + expose
// that file — so realpath it (resolves symlinks + '..'), then require a .jsonl
// strictly under the Claude projects root. Anything else returns '' (ignored —
// never throws into the hook). The pure containment/extension decision lives in
// lib/transcript.js (isAllowedTranscriptPath) and is unit-tested there.
function safeTranscriptPath(p) {
  if (!p || typeof p !== 'string') return '';
  try {
    const resolved = fs.realpathSync(p);
    // Allowed when it is a .jsonl strictly inside ANY agent's transcript root. Each
    // root is checked independently with the same strict containment predicate, so
    // adding Codex widens WHICH files may be read, never HOW the check is made.
    for (const { dir } of getTranscriptRoots()) {
      let root;
      try { root = fs.realpathSync(dir); }
      catch { root = dir; } // root may not exist yet (agent never run here)
      if (transcript.isAllowedTranscriptPath(resolved, root)) return resolved;
    }
    return '';
  } catch { return ''; } // missing file / bad path → ignore
}

// G5 persistence sub-gap mitigation. _nstate(id).transcriptPath is in-memory, so a
// server restart loses it until the next hook fires. When a transcript request
// arrives with no stashed path, derive one from the session's persisted
// claudeSessionId + cwd (same cwd→project-dir encoding the claude-sessions scanner
// uses). The candidate is run back through safeTranscriptPath — the identical
// .jsonl-strictly-under-the-projects-root trust chain — so derivation can never
// widen what a request may read. Returns '' on any miss (no session, no
// claudeSessionId yet, file absent, or path rejected).
async function deriveTranscriptPath(id) {
  return (await deriveTranscript(id)).path;
}

// Resolve a session's transcript through the agent providers: the session's own agent
// is tried first, then the rest, so an explicit choice wins while a session whose agent
// was never recorded (the user typed `codex` at a plain shell prompt) is still
// discovered. Every candidate goes through safeTranscriptPath, so a provider can only
// widen WHICH files are read, never how the containment gate is applied.
// Returns { path, agent } — path '' on any miss.
// --- Codex conversation ownership (scripts/codex-notify.js) ----------------------
//
// WHICH conversation belongs to WHICH session, reported by the session's own Codex.
// This is the exact answer, and the only one that holds when several Codex sessions
// share a working directory — see scripts/codex-notify.js for why process ancestry and
// lifecycle hooks were both rejected against the real machine.
//
// Persisted because it is learned only when a turn COMPLETES: without a file, a server
// restart would drop every mapping and silently fall back to cwd guessing until each
// session happened to finish another turn.
const CODEX_OWNERSHIP_FILE = path.join(__dirname, 'codex-sessions.json');
const _codexOwnership = new Map(); // web-terminal session id -> codex conversation id

function loadCodexOwnership() {
  try {
    const raw = JSON.parse(fs.readFileSync(CODEX_OWNERSHIP_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) {
      if (typeof v === 'string') _codexOwnership.set(k, v);
    }
  } catch { /* absent/corrupt → start empty; the next completed turn re-reports */ }
}
let _codexOwnershipWrite = null;
function saveCodexOwnershipSoon() {
  if (_codexOwnershipWrite) return;
  _codexOwnershipWrite = setTimeout(() => {
    _codexOwnershipWrite = null;
    try {
      fs.writeFileSync(CODEX_OWNERSHIP_FILE, JSON.stringify(Object.fromEntries(_codexOwnership)));
    } catch (e) { console.error('codex ownership write failed:', e.message); }
  }, 1000);
  if (typeof _codexOwnershipWrite.unref === 'function') _codexOwnershipWrite.unref();
}
loadCodexOwnership();

// Every conversation claimed by a session OTHER than `id`.
//
// A claim is proof of ownership: it came from that session's own agent, through its own
// PTY environment. So the conversation is off-limits to everyone else, and a session with
// no claim of its own shows nothing rather than borrowing a neighbour's.
function claimedConversationsExcept(id) {
  const out = new Set();
  for (const [sid, cid] of _codexOwnership) if (sid !== id && cid) out.add(cid);
  return out;
}

// When this session's OWN agent process started, or null if it cannot be told.
//
// The session's PTY is a shell; the agent runs as a descendant of it. Finding that
// descendant is what makes two Codex sessions in ONE folder distinguishable — each
// codex creates exactly one rollout at startup, stamped with its start time.
//
// Soft by construction: no pid, no declared process name, a snapshot that could not be
// taken, or an agent that has already exited all yield null, and null means "fall back
// to the previous behaviour" rather than an error or an empty lens.
//
// #280: never awaited, because this runs inside GET /api/sessions and the snapshot is a
// PowerShell spawn that can hang. Returns { startMs, provisional } - the rule, including
// when an answer is only provisional, lives in processTree.agentStartFromSnapshot.
function agentProcessStartMs(s) {
  try {
    const exeName = agentsLib.processNameFor(s && s.agent);
    if (!exeName || !s.pid) return { startMs: null, provisional: false };
    return processTree.agentStartFromSnapshot(s.pid, exeName);
  } catch { return { startMs: null, provisional: false }; }
}

async function deriveTranscript(id) {
  try {
    const s = await workerClient.rpc('getSession', { id });
    if (!s || !s.cwd) return { path: '', agent: agentsLib.DEFAULT_AGENT };
    // Claude's provider needs the conversation id the worker discovered for the cwd.
    // Codex needs something else entirely: cwd is not an identity for it, so the
    // session's OWN agent process start time is what separates two Codex sessions
    // sharing a folder (lib/codex-match.js). Null when it cannot be determined, which
    // simply falls back to the historical newest-in-cwd rule.
    const started = agentProcessStartMs(s);
    const session = {
      cwd: s.cwd,
      agentSessionId: s.claudeSessionId || null,
      // The exact answer when the session's own Codex has reported it; the provider
      // prefers it over any cwd-based guess.
      conversationId: _codexOwnership.get(id) || null,
      // Conversations owned by OTHER sessions, so a session without its own reported id
      // is never handed a neighbour's by mtime.
      claimedIds: claimedConversationsExcept(id),
      processStartMs: started.startMs,
    };
    // An agent recorded on the session is an explicit user choice — honour it and do
    // NOT fall through to another provider. Only a session with no recorded agent
    // (plain shell) gets cross-provider discovery.
    const explicit = agentsLib.isKnownAgent(s.agent);
    const preferred = explicit ? s.agent : agentsLib.DEFAULT_AGENT;
    const resolved = await agentsLib.resolveTranscriptFor(session, preferred, transcriptIoFor, safeTranscriptPath, { discover: !explicit });
    return { ...resolved, provisional: started.provisional };
  } catch { return { path: '', agent: agentsLib.DEFAULT_AGENT }; }
}

// The rooted file I/O a provider's resolveTranscript() may use. Providers never touch
// `fs` themselves, which keeps them pure enough to unit-test with a fake io.
function transcriptIoFor(provider) {
  const root = path.join(transcriptHome(), ...provider.transcriptDir);
  return {
    root,
    join: path.join,
    // Every *.jsonl under the root, newest-first callers sort themselves.
    listRollouts: () => {
      const out = [];
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
            try { out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs }); } catch {}
          }
        }
      };
      walk(root);
      return out;
    },
    readFirstLine: (p) => {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(65536); // a session_meta line carries base_instructions
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const text = buf.slice(0, n).toString('utf8');
        const nl = text.indexOf('\n');
        return nl >= 0 ? text.slice(0, nl) : text;
      } finally { fs.closeSync(fd); }
    },
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    // The first file under the root with this EXACT basename, or ''. Claude's layout is
    // <projects>/<encoded-cwd>/<conversation-id>.jsonl and the id is a UUID, so a
    // basename match identifies one conversation with no ambiguity — which is what makes
    // it safe where "newest in this cwd" is not. Short-circuits on the first hit and only
    // runs when the cwd derivation missed.
    findByBasename: (name) => {
      let found = '';
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (found) return;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name === name) { found = p; return; }
        }
      };
      walk(root);
      return found;
    },
  };
}

// Resolve a session's transcript path: the in-memory stash (set + validated by the
// http-hook) first, then a validated derivation (stashed back so later reads skip
// it). '' on any miss. SSOT for the transcript-read routes (/transcript, /subagent,
// /pending-question) so the .jsonl-under-projects-root trust chain lives in ONE place.
// How long a DISCOVERED transcript path may be reused before it is re-checked. Only
// applies to agents whose path is not a derivation (Codex). Re-deriving walks the newest
// rollouts and reads a head from each, so this must not be zero — but it must not be
// forever either, which is exactly the bug it fixes.
const DISCOVERED_TRANSCRIPT_TTL_MS = 10000;
// #280: a path resolved against no process snapshot, or one past its TTL, is held this
// long instead. Not zero: re-deriving walks the whole rollout folder, and on a box whose
// snapshot is failing that would run on every poll.
const PROVISIONAL_TRANSCRIPT_TTL_MS = 2000;

async function resolveSessionTranscriptPath(id) {
  const st = _notifyState.get(id) || {};
  let tpath = st.transcriptPath || '';
  // A cached path is only trustworthy when the agent's path is a DERIVATION. For an
  // agent whose transcript is DISCOVERED ("newest rollout matching this cwd"), the
  // correct answer changes whenever the agent starts a new one — Codex does that on
  // every run — while nothing about the web-terminal session changes to invalidate it.
  //
  // Observed on Office (2026-07-21): the Codex chat lens served a 2026-07-14 rollout
  // with seven newer ones for the same cwd on disk. The chat had been opened before
  // that day's runs, so it pinned whatever was newest THEN and froze — the terminal
  // was live and correct the whole time, which is what made it look like a render bug.
  // Claude never showed this because its path is a derivation AND its hook re-stashes
  // it on every event; Codex has neither.
  if (tpath && !agentsLib.transcriptPathIsStable(st.transcriptAgent) &&
      Date.now() - (st.transcriptAt || 0) > (st.transcriptTtlMs || DISCOVERED_TRANSCRIPT_TTL_MS)) {
    tpath = '';
  }
  if (!tpath) {
    const derived = await deriveTranscript(id);
    tpath = derived.path;
    if (tpath) {
      const s = _nstate(id);
      s.transcriptPath = tpath;
      s.transcriptAgent = derived.agent;
      s.transcriptAt = Date.now();
      s.transcriptTtlMs = derived.provisional ? PROVISIONAL_TRANSCRIPT_TTL_MS : DISCOVERED_TRANSCRIPT_TTL_MS;
    }
  }
  return tpath;
}

// --- subagent trace: a session's spawned-subagent transcripts -----------------
// Claude Code stores each spawned subagent's own transcript in a sibling dir of
// the main <sessionId>.jsonl:  <...>/<sessionId>/subagents/agent-<agentId>.jsonl
// (+ an agent-<agentId>.meta.json sidecar). These three helpers turn that on-disk
// layout into a Task-tool_use → subagent-file index the /transcript stub and the
// /subagent drill endpoint share. All I/O is best-effort — a missing dir or a bad
// sidecar just yields no trace, never an error (the flat Task card still renders).
function subagentDirForTranscript(tpath) {
  // tpath = <projectsDir>/<projectDir>/<sessionId>.jsonl → sibling <sessionId>/subagents
  return path.join(path.dirname(tpath), path.basename(tpath, '.jsonl'), 'subagents');
}

// Map a Task tool_use id → { file, agentType, description } by reading every
// agent-*.meta.json sidecar in a session's subagents dir. The agent .jsonl path is
// built from the real dir entry name (agent-<id>.jsonl), NEVER from a request value,
// so a caller-supplied toolUseId can only ever be a map key — no path traversal.
function buildSubagentIndex(subDir) {
  const map = new Map();
  let names;
  try { names = fs.readdirSync(subDir); } catch { return map; } // no subagents → empty
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue;
    let meta;
    try { meta = transcript.parseAgentMeta(fs.readFileSync(path.join(subDir, name), 'utf8')); }
    catch { continue; }
    if (!meta) continue;
    const agentId = name.slice('agent-'.length, name.length - '.meta.json'.length);
    if (!agentId) continue;
    map.set(meta.toolUseId, {
      file: path.join(subDir, `agent-${agentId}.jsonl`),
      agentType: meta.agentType,
      description: meta.description,
    });
  }
  return map;
}

// The set of finished (resolved) tool_use ids from a transcript's last 256KB — the
// "running" signal for subagent stubs: a Task whose id is NOT resolved is in flight.
// Reads only the tail (a Task's tool_result lands right after its subagent ends), so
// it's cheap regardless of transcript size. Returns an empty set on any read error.
function resolvedIdsTail(tpath) {
  try { return transcript.collectResolvedIds(transcriptTailText(tpath)); } catch { return new Set(); }
}

// A transcript's last 256KB from its first whole line. THROWS on a failed read (#441):
// a caller that remembers what it has read must be able to tell "read, nothing there"
// from "not read".
function transcriptTailText(tpath) {
  const size = fs.statSync(tpath).size;
  const start = Math.max(0, size - 262144); // 256KB tail
  const len = size - start;
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(tpath, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8');
  if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
  return text;
}

// Overridable for the SAME reason as WT_CLAUDE_METRICS_FILE and WT_EXEC_AUDIT_FILE,
// and with more at stake: this file holds a live bearer token for every peer in the
// cluster. A test that needs a cluster entry (#204's proxy-buffer regression test
// needs one pointing at a dead port) must never write the real one, and a
// backup/restore around the test is not enough - a crashed or SIGTERM'd run skips
// the restore, which is exactly how a suite eats a credential file. Redirecting the
// path makes it unreachable instead of merely unlikely.
const CLUSTER_TOKENS_FILE = process.env.WT_CLUSTER_TOKENS_FILE || path.join(__dirname, 'cluster-tokens.json');
const CLAUDE_SESSION_NAMES_FILE = path.join(__dirname, 'claude-session-names.json');

function loadClaudeSessionNames() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SESSION_NAMES_FILE, 'utf8')); } catch { return {}; }
}
function saveClaudeSessionNames(names) {
  fs.writeFileSync(CLAUDE_SESSION_NAMES_FILE, JSON.stringify(names, null, 2));
}

// (Claude-session-from-dir detection lives in pty-worker.js, the process that
// owns sessions; server.js resolves transcripts by cwd via deriveTranscriptPath
// + the shared transcript.claudeProjectDirName encoder.)

/** Extract Claude session ID from a command string (--resume flag) */
function extractClaudeSessionIdFromCmd(cmd) {
  if (!cmd) return null;
  const match = cmd.match(/--resume\s+([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

// --- Password helpers ---
const DEFAULT_PASSWORDS = ['admin'];

function needsPasswordChange() {
  return DEFAULT_PASSWORDS.includes(PASS);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `$scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored.startsWith('$scrypt$')) return password === stored;
  const parts = stored.split('$');
  const salt = parts[2];
  const hash = parts[3];
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
  } catch (e) { return false; }
}

// --- Auto-hash plaintext password on startup ---
// Skip persisting to config.json when password came from env var (e.g. test runs)
if (PASS && !DEFAULT_PASSWORDS.includes(PASS) && !PASS.startsWith('$scrypt$')) {
  const hashed = hashPassword(PASS);
  if (process.env.WT_PASS) {
    PASS = hashed;
    console.log('Password auto-hashed (env var, not persisted to config)');
  } else {
    const cfg = readConfig();
    cfg.password = hashed;
    try {
      writeConfig(cfg);
      PASS = hashed;
      console.log('Password auto-hashed in config.json');
    } catch (e) { console.error('Failed to auto-hash password:', e.message); }
  }
}

// --- WebSocket input caps (#201) — ONE invariant expressed at TWO layers ---------
//
// The pair below and the companion's `_inputBufferHardCap`
// (`ai-terminal/lib/api/api_client.dart`) are a single rule; moving one alone breaks
// it. Each of the three sites names the other two. The rule:
//
//   NOTHING THE OFFLINE INPUT BUFFER CAN HOLD WITHIN ITS CEILING MAY BE REFUSED AT
//   THE WIRE.
//
// The companion buffers input written while the socket is down, bounded at 256 KB
// total, and #200 made `_flushInput` send ONE FRAME PER BUFFERED WRITE — so no write
// it holds within that ceiling can exceed 256 KB. `WS_INPUT_MAX` is therefore the
// same number in the same unit, and the seam #201 was filed about closes by
// construction. (A single write LARGER than the ceiling is a different case: the
// buffer already cannot promise it, and the wire still reports it on `inputDropped`.)
//
// WHY THESE NUMBERS. The app cap was 65536 from commit a96e7ba (2026-03-23,
// "Security hardening"), one bullet in a checklist beside other round numbers, with
// no measurement and never revisited — an INHERITED DEFAULT, and the tightest limit
// on the whole path (lib/ipc.js allows 16 MB; pty-worker.js caps nothing). These two
// are deliberate.
//
// UNITS — the trap. `WS_INPUT_MAX` is compared against `msg.length`, which is UTF-16
// CODE UNITS, not bytes (so is the companion's `data.length`, which is why the two
// are directly comparable). `maxPayload` counts real UTF-8 BYTES. The conversion:
//
//   262,144 code units x 3 bytes = 786,432 bytes
//
// 3 is the worst case for one code unit: a 3-byte BMP character (CJK, most symbols).
// An emoji is 4 UTF-8 bytes across 2 code units — only 2x — so 3x is the ceiling.
// Hence any frame over 786,432 bytes CANNOT pass `WS_INPUT_MAX` whatever it holds,
// and `maxPayload` at 4 MiB sits ~5.3x above that point.
//
// WHY THAT GAP IS WIDE RATHER THAN SNUG. `ws` answers an oversize frame by CLOSING
// the socket (1009) before any application handler runs, so the app cannot send the
// friendly `inputDropped` notice for it. A snug `maxPayload` would convert "your
// input was refused, here is its size" into "your session dropped". The gap is the
// zone where an accidental oversend is still reported honestly; past 4 MiB it is
// abuse, not a paste.
//
// AND A 1009 CANNOT BECOME A RECONNECT LOOP, which is the failure that would make
// this worse than the silent drop it replaces. Two reasons, both read off the
// companion rather than assumed:
//
//   1. A BUFFERED write is flushed ONCE, never flushed-until-acked. `_flushInput`
//      (api_client.dart) dequeues each write immediately after `socket.add(next)`
//      returns, and `add` is a synchronous LOCAL enqueue onto the channel sink: it
//      cannot observe a remote refusal and does not throw on size. So an oversized
//      buffered write is gone from the queue before the 1009 ever arrives, and the
//      retry path (catch -> return, leaving the remainder buffered) never fires on
//      size.
//   2. A LIVE write is `_socket!.add(data)` in `sendInput` - fire-and-forget, never
//      re-queued - so a closed socket loses that one oversend once.
//
// NOT a reason, though it reads like one: the offline buffer's 256 KB
// `_inputBufferHardCap` does NOT keep an oversized write out of the buffer. Its
// eviction loop is `while (over && _inputWrites.length > 1)`, so a LONE write larger
// than the whole ceiling survives and is flushed. Reason 1 is what holds, and the
// distinction matters: a future change that made the flush retry-until-acked would
// reintroduce the loop while that ceiling still read as protective.
//
// What >4 MiB DOES cost is a silent loss: the transport closes before the app can
// send its `inputDropped` notice, and any writes already dequeued behind the
// offending one in the same flush go with it. Below 4 MiB every refusal is still
// reported honestly, which is why the gap is wide.
//
// #204 — AND THE COMPANION NO LONGER GOES THERE. Its `sendInput` now refuses a write
// over the app cap locally and reports it on the same `inputDropped` channel, so
// nothing that client sends can reach `maxPayload` at all: a refusal by the APP keeps
// the socket and the session, a refusal by the TRANSPORT costs the connection, and it
// is the app's own cap that decides which one happens. That makes the band above
// unreachable from the companion rather than merely defended against.
//
// #206 — AND NEITHER DOES app.html ANY MORE. This block used to record the gap as still
// live, because that file had no single input send path — a dozen scattered
// `ws.send(...)` sites, the browser paste among them — and the check had nowhere to live.
//
// NOT "both clients", THOUGH — there was a THIRD page, and it was the worst off of the
// three: `terminal.html`, the legacy terminal-only view. Four ungated input sends (a
// paste among them) AND it discarded the server's own `inputDropped` frame, having no
// notice UI to render one in. So there a >256KB paste was refused by the server and
// reported to nobody, and a >4MiB paste closed the socket with nobody told why. Caught in
// review, after this comment had briefly claimed the band was closed for every client.
//
// #218 — CLOSED BY UNSERVING IT, not by gating it. `/s/:id` now redirects to `/app/:id`,
// so the page is unreachable and its ungated sends cannot be reached either. Gating it
// would have meant building a notice UI on a page nothing links to, and would have made a
// second diverging copy of the input path more worth keeping. That is also why
// `check-shared-constants.js` still gates THREE copies of this number rather than four —
// and why `tests/legacy-route-redirect.spec.js` asserts against the SOURCE that no route
// serves the file: routing it again is what would reopen the band, and no behavioural
// test can see a route added next year.
//
// The premise turned out to be half wrong, which is worth keeping: `sendInput` had been
// the coalescing path for typing and for the compose bar all along. Exactly four sites
// wrote past it (the image-path paste, the mobile toolbar key, the long-press Paste, the
// tap-to-move arrow repeat), so the fix was a funnel — `sendPtyInput` wrapping
// `ws.send` — and not the new mechanism this comment implied it would need. Each
// caller's FRAMING is untouched: #55/#44 make a submit one frame on purpose, and #87's
// images-only submit needs its paste close and its bare CR to reach the wire as separate
// writes a measured gap apart.
//
// `scripts/check-shared-constants.js` now gates all three copies of this number.
const WS_INPUT_MAX = 256 * 1024;         // per frame, UTF-16 code units (app cap)
const WS_MAX_PAYLOAD = 4 * 1024 * 1024;  // per message, UTF-8 bytes (transport cap)

const app = express();
// `maxPayload` is the bound that actually BOUNDS. `ws` assembles a whole message
// before `handleMessage` ever sees it (ws/lib/receiver.js), so the app cap below
// rejects a frame that has ALREADY been buffered in full: it is a coherence check,
// not a memory guard. Unset, `ws` defaults to 100 MB per message — so this line, not
// the app cap, is the DoS reduction #201 delivers.
const wsInstance = expressWs(app, null, {
  wsOptions: { perMessageDeflate: false, maxPayload: WS_MAX_PAYLOAD }
});

// #152 — this server's own machine-wide CPU/memory sampler (the per-server slice only;
// see lib/resources.js for the tick-delta rule and why it must not be a single read).
// Ticks on its own timer, independent of any request — sampling must not ride the
// cluster sidebar poll (#152 hint 5). Seeded once immediately so `_prev` is warm; the
// first REAL cpuPct reading (a genuine delta) lands on the timer's first fire.
const _resourceSampler = new resourcesLib.Sampler();
_resourceSampler.tick();
setInterval(() => _resourceSampler.tick(), resourcesLib.SAMPLE_INTERVAL_MS).unref();

// --- WebSocket keepalive: ping every 30s, kill after 2 missed pings (tolerates background tabs) ---
const WS_PING_INTERVAL = 30000;
setInterval(() => {
  const wss = wsInstance.getWss();
  for (const ws of wss.clients) {
    if (ws._wtAlive === false) {
      // Allow one missed ping — browsers throttle background tabs to ~60s
      ws._wtMissed = (ws._wtMissed || 0) + 1;
      if (ws._wtMissed >= 3) {
        ws.terminate();
        continue;
      }
    } else {
      ws._wtMissed = 0;
    }
    ws._wtAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, WS_PING_INTERVAL);

// --- Session manager: all PTY state now lives in pty-worker.js (see lib/worker-client.js). ---
// server.js holds only notifyClients (browser notification WS set) and a per-session
// Map of WebSocket clients currently attached to each session id.
const notifyClients = new Set();

// Map<sessionId, Set<ws>> — which browser WebSockets are subscribed to each session.
// Needed for exclusive-viewer kick logic and for fanning out PTY data events from the worker.
const sessionClients = new Map();
function getSessionClients(id) {
  let set = sessionClients.get(id);
  if (!set) { set = new Set(); sessionClients.set(id, set); }
  return set;
}

// #351 - sockets that are connected to a session but not yet attached to it (the worker attach
// is in flight; on a slow worker that is seconds). They are in no session set yet, so without
// this the spawn reaper could not see a viewer who has arrived and declared itself active.
const attachingSockets = new Map();
function setAttaching(id, ws, on) {
  let set = attachingSockets.get(id);
  if (on) {
    if (!set) { set = new Set(); attachingSockets.set(id, set); }
    set.add(ws);
  } else if (set) {
    set.delete(ws);
    if (!set.size) attachingSockets.delete(id);
  }
}

// #146 — the size each session's PTY is currently running at, as far as THIS server
// knows. Kept so a recomputation that lands on the same answer costs no RPC: every active
// viewer re-sends its size on reconnect and on each relayout, and the common case by far
// is a single viewer repeating itself.
const _ptySize = new Map();

/**
 * Re-derive one session's PTY size from every socket attached to it and push it to the
 * worker if it moved. The rule — smallest ACTIVE viewer wins — and the reasoning
 * behind it live in lib/terminal-size.js; this is only where it meets the socket list.
 */
function applyNegotiatedSize(id, { nudge = false } = {}) {
  const set = sessionClients.get(id);
  if (!set || set.size === 0) { _ptySize.delete(id); return; }
  const next = terminalSize.negotiateSize(
    [...set].map((c) => ({ cols: c._wtCols, rows: c._wtRows, background: !!c._wtBackground })),
  );
  // null means nobody attached has an opinion (a REST client, a socket that never sent a
  // resize). Leave the PTY as it is rather than impose a default on a live agent.
  if (!next) return;
  if (!terminalSize.sizeChanged(_ptySize.get(id), next)) {
    // #146 — the size did not move, so a viewer that just arrived gets no SIGWINCH
    // and the TUI never repaints for it. That is what app.html's own nudgeRedraw()
    // exists to force, by flicking rows by 1 — and negotiation DEFEATS it, because a
    // viewer that is not the minimum cannot move the answer, so both halves of its
    // flick collapse to the same value. Found in review. So the nudge is delivered
    // HERE instead, at the negotiated size, where it still works.
    if (nudge && next.rows > 1) {
      workerClient.rpc('resizeSession', { id, cols: next.cols, rows: next.rows - 1 })
        .then(() => workerClient.rpc('resizeSession', { id, cols: next.cols, rows: next.rows }))
        .catch(() => { _ptySize.delete(id); });
    }
    return;
  }
  // Recorded only once the worker has ACCEPTED it, and forgotten if it has not. Found
  // in review: writing the cache optimistically meant a rejected resize (a blocked
  // worker event loop is a condition this fleet has actually hit) left us believing a
  // size the PTY never took — and every later identical relayout was then swallowed
  // by the dedupe, so the viewer stayed wrapped for the rest of the session. That is
  // #146's own symptom, reintroduced by #146's fix.
  workerClient.rpc('resizeSession', { id, cols: next.cols, rows: next.rows })
    .then(() => { _ptySize.set(id, next); })
    .catch(() => { _ptySize.delete(id); });
}

// Map<sessionId, () => void> — active PTY_OUT dispose handles (one per session,
// regardless of how many browser WS clients are attached).
const ptyOutDisposers = new Map();

function ensurePtyOutSubscription(id) {
  if (ptyOutDisposers.has(id)) return;
  // Browser xterm.js expects WS text frames with UTF-8 string payload. Raw
  // Buffers arrive as Blobs in the browser which xterm cannot render.
  //
  // Per-session streaming decoder: when a Claude Code redraw pushes bytes
  // through IPC in chunks, a chunk boundary can fall inside a multi-byte
  // UTF-8 codepoint (e.g., box-drawing `╭` is 3 bytes). A stateless
  // buf.toString('utf8') per chunk replaces the partial bytes with U+FFFD
  // and corrupts the next chunk's orphan continuation bytes — so Claude's
  // prompt-box corners disappear and the UI ends up rendered in the middle
  // of the viewport. TextDecoder with { stream: true } keeps incomplete
  // sequences pending across calls, so codepoints split at chunk boundaries
  // are delivered intact on the following chunk.
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  const dispose = workerClient.onPtyOut(id, (buf) => {
    const set = sessionClients.get(id);
    if (!set || set.size === 0) return;
    const str = decoder.decode(buf, { stream: true });
    if (!str) return;
    for (const client of set) {
      try { client.send(str); } catch {}
    }
  });
  ptyOutDisposers.set(id, dispose);
}

function releasePtyOutSubscription(id) {
  const set = sessionClients.get(id);
  if (set && set.size > 0) return; // still has clients
  const dispose = ptyOutDisposers.get(id);
  if (dispose) {
    try { dispose(); } catch {}
    ptyOutDisposers.delete(id);
  }
}

try { if (!fs.existsSync(CLIPBOARD_DIR)) fs.mkdirSync(CLIPBOARD_DIR); } catch (e) {}

// --- Worker client setup --------------------------------------------------
const WORKER_PIPE_PATH = process.env.WT_WORKER_PIPE || (
  process.platform === 'win32'
    ? '\\\\.\\pipe\\web-terminal-pty'
    : '/tmp/web-terminal-pty.sock'
);
const workerClient = workerClientLib.create();

// Optionally spawn the worker ourselves (controlled by WT_SPAWN_WORKER=1).
// In production, monitor.js spawns the worker; for tests we spawn it here.
let _spawnedWorker = null;
function maybeSpawnWorker() {
  if (!process.env.WT_SPAWN_WORKER) return;
  const workerPath = path.join(__dirname, 'pty-worker.js');
  const child = spawn(process.execPath, [workerPath], {
    env: {
      ...process.env,
      WT_WORKER_PIPE: WORKER_PIPE_PATH,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  _spawnedWorker = child;
  child.on('exit', (code, sig) => {
    console.error(`[${new Date().toISOString()}] pty-worker exited (${code}/${sig}) — exiting server so monitor restarts both`);
    process.exit(1);
  });
}
maybeSpawnWorker();

// Forward worker-pushed events to browser clients.
// Binary PTY output: per-session subscription is set up in the WS attach path.
// (Legacy ptyData JSON event was removed in Phase 4.)

// --- ntfy push notifications ----------------------------------------------
// Per-session level (off/important/all, default important) stored server-side
// so the push decision — which happens here, when a hook event arrives — can
// read it. All server-side + a gitignored prefs file → hot-reloadable, no
// worker change, no new npm dependency (ntfy is a plain HTTPS POST).
const NOTIFY_PREFS_FILE = path.join(__dirname, 'notify-prefs.json');
let _notifyPrefs = null, _notifyPrefsAt = 0;
function loadNotifyPrefs() {
  if (!_notifyPrefs || Date.now() - _notifyPrefsAt > 5000) {
    try { _notifyPrefs = fs.existsSync(NOTIFY_PREFS_FILE) ? JSON.parse(fs.readFileSync(NOTIFY_PREFS_FILE, 'utf8')) : {}; }
    catch { _notifyPrefs = {}; }
    _notifyPrefsAt = Date.now();
  }
  return _notifyPrefs;
}
function getNotifyLevel(id) { return notifyPush.normalizeLevel(loadNotifyPrefs()[id]); }
function setNotifyLevel(id, level) {
  const lv = notifyPush.normalizeLevel(level);
  const prefs = loadNotifyPrefs();
  if (lv === notifyPush.DEFAULT_LEVEL) delete prefs[id]; else prefs[id] = lv; // store only overrides
  try { fs.writeFileSync(NOTIFY_PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch (e) { console.error('notify-prefs write failed:', e.message); }
  _notifyPrefs = prefs; _notifyPrefsAt = Date.now();
  return lv;
}
function pruneNotifyPref(id) {
  const prefs = loadNotifyPrefs();
  if (prefs[id]) { delete prefs[id]; try { fs.writeFileSync(NOTIFY_PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {} }
}

// --- Per-session 5h auto-resume opt-out (#137) -----------------------------
// Same shape and the same reasoning as notifyLevel above: server-side + a small
// gitignored prefs file, so the control is hot-reloadable and needs NO worker
// protocol change. It is stored as an OPT-OUT (presence == disabled) because the
// feature is ON by default — so the file stays empty until someone actually turns
// a session off, and a lost/rotated file fails back to the default rather than to
// silence.
//
// How a disabled session reaches the worker, which is the part worth reading:
// server.js simply pushes a NULL resetAt for it (armResetTimerFromMetrics). The
// worker's existing setFiveHResetAt handler already treats null as "cancel", so
// the opt-out works through a path that predates it — no new RPC, and it takes
// effect against a worker running older code.
const AUTO_RESUME_PREFS_FILE = path.join(__dirname, 'auto-resume-prefs.json');
let _autoResumePrefs = null, _autoResumePrefsAt = 0;
function loadAutoResumePrefs() {
  if (!_autoResumePrefs || Date.now() - _autoResumePrefsAt > 5000) {
    try { _autoResumePrefs = fs.existsSync(AUTO_RESUME_PREFS_FILE) ? JSON.parse(fs.readFileSync(AUTO_RESUME_PREFS_FILE, 'utf8')) : {}; }
    catch { _autoResumePrefs = {}; }
    _autoResumePrefsAt = Date.now();
  }
  return _autoResumePrefs;
}
/** Default ON (#137) — only an explicit `false` in the file disables a session. */
function getAutoResumeEnabled(id) {
  return loadAutoResumePrefs()[id] !== false;
}
function setAutoResumeEnabled(id, enabled) {
  const on = enabled !== false;
  const prefs = loadAutoResumePrefs();
  if (on) delete prefs[id]; else prefs[id] = false; // store only overrides
  try { fs.writeFileSync(AUTO_RESUME_PREFS_FILE, JSON.stringify(prefs, null, 2)); }
  catch (e) { console.error('auto-resume-prefs write failed:', e.message); }
  _autoResumePrefs = prefs; _autoResumePrefsAt = Date.now();
  return on;
}
function pruneAutoResumePref(id) {
  const prefs = loadAutoResumePrefs();
  if (prefs[id] !== undefined) {
    delete prefs[id];
    try { fs.writeFileSync(AUTO_RESUME_PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
    _autoResumePrefs = prefs; _autoResumePrefsAt = Date.now();
  }
}

// --- Favorites (#60) -------------------------------------------------------
// A favorite is a PROPERTY OF A SESSION, so it lives on the server that OWNS the
// session — exactly like notifyLevel above, and for the same reason: one truth,
// every device reads it. Same proven shape: a small gitignored JSON file + a
// GET/PATCH pair behind auth, surfaced as fields on the session lists.
//
// The file is `{ "<sessionId>": <rank> }` — PRESENCE is the flag, the value is
// the session's position in the pinned group. The group's ORDER is therefore
// DERIVED, never stored centrally: a client sorts the union of every server's
// favorites by (favoriteRank, id). That is what makes this work across a cluster
// with no "home server" — a peer holds its own sessions' pins, and a peer that
// is down simply contributes nothing to the union (it never wipes it).
const FAVORITES_FILE = path.join(__dirname, 'favorites.json');
let _favorites = null, _favoritesAt = 0;
function loadFavorites() {
  if (!_favorites || Date.now() - _favoritesAt > 5000) {
    try { _favorites = fs.existsSync(FAVORITES_FILE) ? JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')) : {}; }
    catch { _favorites = {}; }
    _favoritesAt = Date.now();
  }
  return _favorites;
}
function writeFavorites(favs) {
  try { fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favs, null, 2)); }
  catch (e) { console.error('favorites write failed:', e.message); }
  _favorites = favs; _favoritesAt = Date.now();
}
/** Rank of a favorited session, or null when it isn't favorited. */
function getFavoriteRank(id) {
  const v = loadFavorites()[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** The two fields every session list carries — derived from ONE map, so the
 *  flag and the rank can never disagree. */
function favoriteFields(id) {
  const rank = getFavoriteRank(id);
  return { favorite: rank !== null, favoriteRank: rank };
}
/** The rank a NEWLY pinned session gets: a monotonic wall-clock timestamp.
 *
 *  This is the ONE place a new pin's position is decided, and it deliberately needs
 *  NO knowledge of what any other server holds. An "index" rank (max + 1) can only
 *  ever be computed from a PARTIAL view — no server holds another server's sessions,
 *  and a client can only see the peers that are up — so a pin made while a peer is
 *  offline reuses a rank that peer already holds, and the pinned group silently
 *  rearranges when it reconnects. A timestamp needs no coordination: pins are
 *  globally ordered by WHEN they were made, and two servers can only pick the same
 *  value inside the same millisecond (where the (rank, id) tiebreak still makes the
 *  order deterministic). Math.max keeps it strictly increasing on this server even
 *  when two pins land in the same millisecond.
 */
function nextFavoriteRank(favs) {
  const maxExisting = Object.values(favs).reduce(
    (m, v) => (typeof v === 'number' && Number.isFinite(v) && v > m ? v : m), 0);
  return Math.max(Date.now(), maxExisting + 1);
}
function setFavorite(id, favorite, rank) {
  const favs = loadFavorites();
  if (!favorite) {
    if (Object.prototype.hasOwnProperty.call(favs, id)) { delete favs[id]; writeFavorites(favs); }
    return null;
  }
  // An explicit rank is only ever sent by a DRAG-REORDER (the one operation that
  // means "put it exactly here"). A plain star sends no rank and gets the timestamp
  // above — so no client has to know, or guess, what the rest of the cluster holds.
  const next = typeof rank === 'number' && Number.isFinite(rank)
    ? Math.trunc(rank)
    : nextFavoriteRank(favs);
  if (favs[id] !== next) { favs[id] = next; writeFavorites(favs); }
  return next;
}
function pruneFavorite(id) {
  const favs = loadFavorites();
  if (Object.prototype.hasOwnProperty.call(favs, id)) { delete favs[id]; writeFavorites(favs); }
}

// --- Agent-started sessions that nobody came back to (#351) -----------------
// The RULES are in lib/spawn-reaper.js (who started a session, and when it may be closed); the
// book-keeping - the verdict file, the pending classify window, pruning - is lib/spawn-store.js.
// This is only where they meet the sockets and the config. Server-side only: no worker
// change, so it hot-reloads.
//
// A session created by POST /api/sessions here is PENDING (memory only) until its classify
// window passes or an active viewer attaches. Pending is deliberately NOT persisted: a restart
// inside the window leaves the session with no verdict (`unknown`), which is never closed.
const SPAWNED_FILE = process.env.WT_SPAWNED_SESSIONS_FILE || path.join(__dirname, 'spawned-sessions.json');
// Test-only knobs, read HERE and nowhere else (ignored outside WT_TEST): the classify
// window, and a shorter idle threshold for the suite. The idle one is NOT set for the whole
// suite server - a 5-minute sweep with a 2-second threshold would reap other specs'
// sessions - so tests pass it to the test trigger instead (POST /api/test/spawn-reaper-sweep).
const SPAWN_TEST = process.env.WT_TEST ? {
  classifyMs: Number(process.env.WT_SPAWN_CLASSIFY_MS) > 0 ? Number(process.env.WT_SPAWN_CLASSIFY_MS) : null,
  idleMs: Number(process.env.WT_SPAWN_IDLE_MS) > 0 ? Number(process.env.WT_SPAWN_IDLE_MS) : null,
} : { classifyMs: null, idleMs: null };
const SPAWN_CLASSIFY_MS = SPAWN_TEST.classifyMs || spawnReaper.CLASSIFY_MS;
function spawnReaperCfg(idleMsOverride) {
  return spawnReaper.reaperConfig(liveConfig('spawnedSessionIdleCloseHours', spawnReaper.DEFAULT_IDLE_HOURS), idleMsOverride || SPAWN_TEST.idleMs);
}
const spawnStore = createSpawnStore({
  file: SPAWNED_FILE,
  classifyMs: SPAWN_CLASSIFY_MS,
  isId: (id) => _HOOK_UUID_RE.test(id), // evaluated at call time: the regex is declared further down
});

function ntfyConfig() { return notifyPush.ntfyTarget(liveConfig('ntfy', null)); }
// Tests capture pushes instead of hitting the network.
const _NTFY_SINK = process.env.WT_NTFY_TEST ? [] : null;
// The ONE ntfy HTTP path: the session-event pushes (deliverPush) and the account-switch
// notice (#483) both post through here. [target] is { server, topic } (notifyPush.ntfyTarget)
// or null; under WT_NTFY_TEST [sinkEntry] is captured instead and nothing is sent.
async function postNtfy(target, msg, sinkEntry) {
  if (_NTFY_SINK) { _NTFY_SINK.push(sinkEntry); return; }
  if (!target) return;
  try {
    await fetch(target.server, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: target.topic, title: msg.title, message: msg.message, priority: msg.priority, tags: msg.tags, click: msg.click }),
    });
  } catch (e) { console.error('ntfy push failed:', e.message); }
}

// --- FCM transport + device registry (G1/G2) ------------------------------
// Content-free data-only wake messages (see COMPANION-APP-DESIGN.md). The pure
// message/JWT/token-cache logic lives in lib/fcm.js; server.js owns the registry
// file, the service-account read, and the fire-and-forget dispatch.
// `WT_PUSH_DEVICES_FILE` redirects the registry, the WT_API_TOKENS_FILE idiom: the suite and
// the servers a spec spawns register devices of their own, never into production's list.
const PUSH_DEVICES_FILE = process.env.WT_PUSH_DEVICES_FILE || path.join(__dirname, 'push-devices.json');
// Tests capture FCM sends instead of hitting the network.
const _FCM_SINK = process.env.WT_FCM_TEST ? [] : null;

// Which transport(s) to use. BACK-COMPAT: absent `push` config (and no env
// override) behaves EXACTLY as today — ntfy only, from the `ntfy` config key.
// 'fcm' disables ntfy; 'both' sends both. WT_PUSH_PROVIDER overrides (tests).
// Precedence/validation is pure logic in lib/fcm.js (unit-tested); this is the
// thin I/O wrapper that reads env + live config.
function pushProvider() {
  const p = liveConfig('push', null);
  return fcm.resolvePushProvider({ env: process.env.WT_PUSH_PROVIDER, configProvider: p && p.provider });
}

// Gitignored device registry: [{token, deviceName, platform, registeredAt}].
// Same cache-with-TTL pattern as loadApiTokens/loadNotifyPrefs.
let _pushDevicesCache = null, _pushDevicesTime = 0;
function loadPushDevices() {
  if (!_pushDevicesCache || Date.now() - _pushDevicesTime > LIVE_CONFIG_TTL) {
    try {
      _pushDevicesCache = fs.existsSync(PUSH_DEVICES_FILE) ? JSON.parse(fs.readFileSync(PUSH_DEVICES_FILE, 'utf8')) : [];
      if (!Array.isArray(_pushDevicesCache)) _pushDevicesCache = [];
    } catch { _pushDevicesCache = []; }
    _pushDevicesTime = Date.now();
  }
  return _pushDevicesCache;
}
function savePushDevices(devices) {
  fs.writeFileSync(PUSH_DEVICES_FILE, JSON.stringify(devices, null, 2), 'utf8');
  _pushDevicesCache = devices; _pushDevicesTime = Date.now();
}
function pruneDevice(token) {
  const devices = loadPushDevices();
  const idx = devices.findIndex(d => d.token === token);
  if (idx !== -1) { devices.splice(idx, 1); try { savePushDevices(devices); } catch {} }
}

// FCM is "configured" when a service account is set (production) OR the test sink
// is active. Drives the 'fcm' capability flag and lazy client creation.
// Capability honesty (code-review #6): this advertises that FCM is *configured*,
// not that the client is live-healthy. We deliberately do NOT flip it off on a
// service-account load failure — getFcmClient() now backs off and re-attempts the
// build (self-healing within CLIENT_BUILD_BACKOFF_MS) instead of latching dead, so
// a transient failure is at most a ~60s window, and flapping the capability on
// transient I/O would be noisier and less truthful than "config present".
function fcmConfigured() {
  if (_FCM_SINK) return true;
  const p = liveConfig('push', null);
  return !!(p && p.fcm && p.fcm.serviceAccountPath);
}
// Lazily load the service account (absolute path, outside the repo) and build a
// client. Cached on success. A load failure does NOT latch FCM dead until the
// next restart: it records an "errored until" deadline and backs off for
// CLIENT_BUILD_BACKOFF_MS (mirrors the token-exchange negative cache), then
// re-attempts — so a transiently locked / half-written SA file self-heals.
// Key material is never logged (F4: fixed string + e.code/e.name only; a
// JSON.parse SyntaxError message can echo file-content snippets). Returns null in
// sink mode (server captures directly).
let _fcmClient = null, _fcmClientErrUntil = 0;
function getFcmClient() {
  if (_FCM_SINK) return null;
  if (_fcmClient) return _fcmClient;
  const p = liveConfig('push', null);
  const saPath = p && p.fcm && p.fcm.serviceAccountPath;
  if (!saPath) return null;
  // Still inside the post-failure backoff window → don't re-attempt the load yet.
  if (!fcm.shouldRetryClientBuild(_fcmClientErrUntil, Date.now())) return null;
  try {
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    _fcmClient = fcm.createFcmClient({ serviceAccount: sa });
    _fcmClientErrUntil = 0; // clear any prior backoff on success
    return _fcmClient;
  } catch (e) {
    _fcmClientErrUntil = Date.now() + fcm.CLIENT_BUILD_BACKOFF_MS; // retry after backoff
    console.error('FCM service account load failed:', e.code || e.name); // never e.message (may embed key material)
    return null;
  }
}

// Fire a content-free FCM wake to every registered device for one session event.
// Fire-and-forget: never throws into pushNotify. Prunes tokens FCM reports dead.
async function fcmDispatch(kind, { id, click, serverName }) {
  if (!fcm.providerSendsFcm(pushProvider())) return;
  const devices = loadPushDevices();
  if (!devices.length) return;
  const ts = Date.now();
  const client = getFcmClient(); // null in sink mode
  for (const dev of devices.slice()) {
    const body = fcm.buildFcmMessage(kind, {
      serverName: serverName || getServerName(), sessionId: id, ts, deepLink: click || '', token: dev.token,
    });
    if (_FCM_SINK) { _FCM_SINK.push({ token: dev.token, ...body.message }); continue; }
    if (!client) continue;
    try {
      const r = await client.send(body);
      if (!r.ok && fcm.shouldPruneOnError(r.errorCode)) pruneDevice(dev.token);
    } catch (e) { console.error('FCM send failed:', e.message); }
  }
}

// Deep-link click URL for a session, or undefined when no publicUrl is set.
// Shared by the ntfy push, the FCM wake, and the G3 'clear' path.
function sessionClickUrl(id) {
  const pub = liveConfig('publicUrl', null);
  return pub ? `${String(pub).replace(/\/+$/, '')}/app/${encodeURIComponent(id)}` : undefined;
}

// Send a push for one session event, gated by that session's level (unless
// force=true, for the manual test endpoint). The attention record is written
// UNCONDITIONALLY (before the gate) — only the actual push delivery is gated.
async function pushNotify(kind, { id, name, reason, force } = {}) {
  // G3 clear: a resolution, not a fresh alert. Handled BEFORE the level gate so
  // it works even for a session set to 'off' (there may be a delivered
  // notification to dismiss). Flip the recorded attention to cleared so
  // GET /api/sessions/:id/attention reflects it (and a companion app can stop
  // nagging). ntfy can't recall a delivered push, so there's nothing to send on
  // that transport; FCM uses the collapse_key'd 'clear' to auto-dismiss. Never
  // records a new 'clear' attention.
  if (kind === 'clear') {
    const att = _nstate(id).lastAttention;
    if (att) att.cleared = true;
    // FCM: a real dismissal — the collapse_key'd 'clear' supersedes the earlier
    // push on the device. No-op for ntfy (can't recall). fcmDispatch self-gates
    // on the provider. Fire-and-forget.
    fcmDispatch('clear', { id, click: sessionClickUrl(id) })
      .catch(e => console.error('FCM clear dispatch failed:', e.message));
    return;
  }
  // Record what needs attention so a companion app / voice layer can pull the
  // real content privately over the LAN via GET /api/sessions/:id/attention,
  // rather than trusting it to the push relay. Recorded UNCONDITIONALLY — a muted
  // ('off') session, or an 'idle' below the 'important' threshold, still needs
  // its state queryable even though no push is sent. cleared flips true once the
  // state resolves (see the statusChanged / apiError handlers, G3).
  _nstate(id).lastAttention = notifyPush.makeAttention(kind, { reason, name });
  // Level gate: below-threshold / muted sessions record attention but send nothing.
  if (!force && !notifyPush.shouldPush(kind, getNotifyLevel(id))) return;
  // #467 - quiet hours (nights, Shabbat, Yom Tov): HELD, never dropped. The latest per
  // session is kept with the attention record it raised; quietFlush sends ONE push for
  // whatever is still unresolved when quiet hours end. The manual test push is never held.
  if (!force && notifyPush.QUIET_HOLDABLE.includes(kind) && quietNow().quiet) {
    _quietHeld.set(id, { id, kind, name, reason, att: _nstate(id).lastAttention, at: Date.now() });
    return;
  }
  await deliverPush(kind, { id, name, reason });
}

// The transport half of a push: ntfy and/or FCM, as configured. [serverName] and [click]
// default to this server and the session's own page; the supervisor (#467) passes another
// server's, for a session that lives there. Only a session of THIS server has a transcript
// here to quote.
async function deliverPush(kind, { id, name, reason, serverName = null, click = undefined } = {}) {
  const provider = pushProvider();
  const local = !serverName || serverName === getServerName();
  if (click === undefined) click = sessionClickUrl(id);
  // ntfy (a plain HTTPS POST): build + send only when this provider sends ntfy —
  // in fcm-only mode we skip the config read, the transcript read, and the
  // message build entirely.
  if (fcm.providerSendsNtfy(provider)) {
    const cfg = ntfyConfig();
    // Quote Claude's last message (from its transcript) so the push shows *what*
    // Claude said/asked. Set ntfy.includeContent=false to keep sensitive content
    // OFF the push relay (e.g. public ntfy.sh) — a companion app then fetches it
    // over the private network via /attention instead. Default (true) keeps
    // today's behavior. NOTE: this feeds ONLY the ntfy detail; /attention does
    // its own independent transcript read, so that path is unaffected here.
    const includeContent = (liveConfig('ntfy', {}) || {}).includeContent !== false;
    const detail = includeContent && local ? transcript.lastAssistantText(_nstate(id).transcriptPath) : '';
    const msg = notifyPush.buildNtfyMessage(kind, { sessionName: name, serverName: serverName || getServerName(), reason, click, detail });
    await postNtfy(cfg, msg, { kind, id, ...msg });
  }
  // FCM: content-free wake to every registered device (fire-and-forget). Gated
  // here so fcm-absent (ntfy-only) mode skips the device load + async hop.
  if (fcm.providerSendsFcm(provider)) {
    fcmDispatch(kind, { id, click, serverName: serverName || getServerName() }).catch(e => console.error('FCM dispatch failed:', e.message));
  }
}

// --- #467 Quiet hours ----------------------------------------------------------------------
// Every server holds its own pushes (lib/quiet-hours.js is the clock rule, config
// `supervisor.quietHours`). Under WT_TEST only, WT_QUIET_FORCE=1|0 pins the answer so a spec
// can hold a push and then release it without waiting for the night.
function quietNow(now = Date.now()) {
  if (process.env.WT_TEST === '1' && (process.env.WT_QUIET_FORCE === '1' || process.env.WT_QUIET_FORCE === '0')) {
    const forced = _quietForced === null ? process.env.WT_QUIET_FORCE === '1' : _quietForced;
    return forced ? { quiet: true, since: now, until: now + 60000, why: ['test'] } : { quiet: false, since: null, until: null, why: [] };
  }
  const sup = liveConfig('supervisor', null);
  return quietLib.quietAt(now, quietLib.quietConfig(sup && typeof sup === 'object' ? sup.quietHours : undefined));
}
let _quietForced = null; // WT_TEST only: POST /api/test/quiet flips it
const _quietHeld = new Map(); // id -> { id, kind, name, reason, att, at }
// Quiet hours over: one push for what is still unresolved (its attention record is the one
// the held push raised, and it is not cleared). Nothing left -> nothing sent.
function quietFlush() {
  if (!_quietHeld.size || quietNow().quiet) return;
  const items = [..._quietHeld.values()].filter((h) => {
    const a = _nstate(h.id).lastAttention;
    return a && a === h.att && !a.cleared;
  });
  _quietHeld.clear();
  const sum = notifyPush.heldSummary(items);
  if (!sum) return;
  deliverPush(sum.kind, { id: sum.id, name: sum.name, reason: sum.reason })
    .catch((e) => console.error('notify(quiet summary) failed:', e.message));
}
const _quietTicker = setInterval(quietFlush, process.env.WT_TEST === '1' ? 1000 : 30000);
if (_quietTicker.unref) _quietTicker.unref();

// Anti-flood timers per session. Approval pushes immediately (debounced); an
// API error only pushes if it hasn't cleared ~25s later (so quick auto-recovery
// blips stay silent); idle only pushes if it stays idle ~2 min (settled), and
// only when the session is on the "all" level.
const _notifyState = new Map(); // id -> { idleTimer, apiErrTimer, apiErrCooldownUntil, lastApprovalAt, lastAttention, transcriptPath, transcriptAgent, transcriptAt }
const _NOTIFY_IDLE_MS = process.env.WT_NOTIFY_FAST ? 300 : 120000;
const _NOTIFY_APIERR_MS = process.env.WT_NOTIFY_FAST ? 200 : 25000;
const _NOTIFY_APPROVAL_DEBOUNCE_MS = 60000;
const _NOTIFY_APIERR_COOLDOWN_MS = 300000;
function _nstate(id) { let s = _notifyState.get(id); if (!s) { s = {}; _notifyState.set(id, s); } return s; }

workerClient.on('statusChanged', ({ id, status, notifyType, notifyMsg }) => {
  if (id && status) noteComposerStatus(id, status); // #479 - noteComposerInput reads it
  // ntfy: any move away from idle cancels a pending settled-idle push.
  if (status && status !== 'idle') {
    const st = _notifyState.get(id);
    if (st && st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
  }
  // G3: an approval resolves when the session moves off 'waiting'. Flip the
  // recorded attention to cleared and emit a 'clear' push so a companion app can
  // auto-dismiss the approval notification. Placed before the early-return path
  // below since the resolving status change usually carries no notifyType.
  {
    const att = _notifyState.get(id)?.lastAttention;
    if (notifyPush.statusClearsApproval(status, att)) pushNotify('clear', { id, name: att.name });
  }
  // Fan out to notifyClients (browser notify WS subscribers)
  // sessionName is retrieved lazily via session list RPC? Instead, pull name from
  // notifyMsg (which carries it) or skip when not set.
  if (!notifyType && !notifyMsg) {
    // Status change without notification; still broadcast to notifyClients for UI.
    const payload = JSON.stringify({
      notification: { type: 'status', message: '', session: '', sessionId: id, status }
    });
    for (const client of notifyClients) { try { client.send(payload); } catch {} }
    return;
  }
  const payload = JSON.stringify({
    notification: { type: notifyType || 'status', message: notifyMsg || '', session: '', sessionId: id, status }
  });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }

  // ntfy push gating.
  try {
    const { name, reason } = notifyPush.splitNotifyMsg(notifyMsg);
    if (notifyType === 'approval_needed') {
      const st = _nstate(id); const now = Date.now();
      if (!st.lastApprovalAt || now - st.lastApprovalAt > _NOTIFY_APPROVAL_DEBOUNCE_MS) {
        st.lastApprovalAt = now;
        pushNotify('approval', { id, name, reason });
      }
    } else if (notifyType === 'idle' && getNotifyLevel(id) === 'all') {
      // Only push if it STAYS idle AND the terminal goes quiet — a mid-task
      // pause shouldn't ping, and neither should an idle Claude prompt that sits
      // above a still-running background build / in-flight subagent. Those keep
      // emitting PTY output (bumping the worker's lastActivity), so at fire time
      // we re-check the output clock: if output landed within the debounce
      // window the session isn't finished — re-arm and wait for a genuine quiet
      // period. A non-idle statusChanged still cancels via the clear above.
      // Same output-clock signal #37 gave correctStaleStatus (SSOT).
      const st = _nstate(id);
      if (st.idleTimer) clearTimeout(st.idleTimer);
      const fireIdle = async () => {
        st.idleTimer = null;
        try {
          const s = await workerClient.rpc('getSession', { id });
          if (s && s.lastActivity && (Date.now() - s.lastActivity) < _NOTIFY_IDLE_MS) {
            st.idleTimer = setTimeout(fireIdle, _NOTIFY_IDLE_MS); // still busy — wait for quiet
            if (st.idleTimer.unref) st.idleTimer.unref();
            return;
          }
        } catch { /* worker unreachable — fall through and push (best-effort) */ }
        pushNotify('idle', { id, name, reason });
      };
      st.idleTimer = setTimeout(fireIdle, _NOTIFY_IDLE_MS);
      if (st.idleTimer.unref) st.idleTimer.unref();
    }
  } catch (e) { console.error('notify(status) failed:', e.message); }
});

// API-error detection from the worker. Fan out to notify clients so the UI can
// highlight the session (and pop a browser notification on first detection).
// `cleared` flips the highlight off; `autoContinue`/`action` are progress-only
// (sent as type 'status' so they don't spawn a browser notification per retry).
workerClient.on('apiError', ({ id, name, apiError, text, transient, cleared, autoContinue, action, replayText }) => {
  const isInitialDetect = apiError === true && !autoContinue && !cleared;
  const type = isInitialDetect ? 'api_error' : 'status';
  // The notification title already carries the session name, so the body is
  // just the error line.
  const message = isInitialDetect ? (text || 'API error') : '';
  const payload = JSON.stringify({
    notification: {
      type, message, session: name || '', sessionId: id,
      apiError: !!apiError, apiErrorText: apiError ? (text || '') : '',
      transient: !!transient, autoContinue: autoContinue || 0, action: action || '', replayText: replayText || '',
    }
  });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }

  // ntfy push gating: only alert if the error is STUCK — i.e. it hasn't cleared
  // ~25s after detection (so quick auto-recovery blips stay silent). Cleared
  // cancels a pending alert.
  try {
    const st = _nstate(id);
    if (cleared) {
      if (st.apiErrTimer) { clearTimeout(st.apiErrTimer); st.apiErrTimer = null; }
      // G3: a stuck API error that already pushed and has now recovered resolves
      // the attention — emit a 'clear' so the companion app can auto-dismiss it.
      const att = st.lastAttention;
      if (notifyPush.apiRecoveryClearsError(att)) pushNotify('clear', { id, name: att.name });
    } else if (isInitialDetect) {
      const now = Date.now();
      if (!st.apiErrTimer && (!st.apiErrCooldownUntil || now > st.apiErrCooldownUntil)) {
        const reason = text ? `API error — ${String(text).slice(0, 140)}` : 'API error (session stuck)';
        st.apiErrTimer = setTimeout(() => {
          st.apiErrTimer = null;
          st.apiErrCooldownUntil = Date.now() + _NOTIFY_APIERR_COOLDOWN_MS;
          pushNotify('apierror', { id, name, reason });
        }, _NOTIFY_APIERR_MS);
        if (st.apiErrTimer.unref) st.apiErrTimer.unref();
      }
    }
  } catch (e) { console.error('notify(apiError) failed:', e.message); }
});

// #69 — the worker's 5h-reset auto-resume timer fired. Deliberately NOT folded into
// the apiError channel above: this session never had an API error (markApiError/
// isClaudeSession never ran), so reusing that event would misreport the episode and
// could even feed the escalation-ladder attempt counter. Same submit path
// (submitLine('continue')) in pty-worker.js, separate — and much simpler — notify
// path: no debounce/cooldown ladder, just one push per fire (it's already one-shot
// per reset window at the source).
workerClient.on('autoResume', ({ id, name, resetAt }) => {
  const payload = JSON.stringify({
    notification: { type: 'auto_resume', message: '', session: name || '', sessionId: id, resetAt: resetAt ?? null }
  });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
  const reason = `Resumed after the 5h usage limit reset${resetAt ? ' at ' + new Date(resetAt).toLocaleTimeString() : ''}`;
  pushNotify('autoresume', { id, name, reason }).catch((e) => console.error('notify(autoResume) failed:', e.message));
});

// #65 — unified "compacting" indicator (user's own /compact via the PreCompact
// hook, or our API-error auto-recovery /compact — both set the same worker-side
// field, see pty-worker.js setCompacting/clearCompacting). Purely transient UI
// state for the chat lens's "Compacting conversation…" indicator, fanned out to
// the live /ws/notify sockets on both set and clear. No FCM push — unlike
// apiError above this never needs to wake a backgrounded phone.
workerClient.on('compacting', ({ id, compacting, since }) => {
  const payload = JSON.stringify({ type: 'compacting', id, compacting: !!compacting, since: since ?? null });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
});

// #147 — the agent's composer is up, so a prompt sent now reaches the agent rather
// than the shell it was still booting in front of. Pushed rather than polled
// because the whole point is to UNBLOCK a compose bar the user is already typing
// into: a poll interval here is a submit that stays refused for no reason. Like
// 'compacting' and unlike 'apiError' it never wakes a backgrounded phone — nobody
// needs a push to say a session they are not looking at finished starting.
workerClient.on('agentReady', ({ id }) => {
  const payload = JSON.stringify({ type: 'agentReady', id, agentReady: true });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
});

// #190 — a recognised startup selector is on screen (or has just gone). Pushed for
// exactly the reason 'agentReady' is: the user is sitting in front of a compose bar
// that has silently stopped accepting submits, and the difference between "starting"
// and "answer the question in the Terminal" is the whole fix. It rides the poll too
// (see the session shape below) so a client that opens or reconnects mid-block
// starts from the truth rather than from the default.
workerClient.on('blockedPrompt', ({ id, blockedPrompt }) => {
  const payload = JSON.stringify({ type: 'blockedPrompt', id, blockedPrompt: blockedPrompt ?? null });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
});

// #179 — a prompt was written to the PTY and the agent never showed any sign of
// having taken it. The worker owns that judgement (it is the only component that knows
// when the submit CR actually went out); this is only the relay.
//
// Pushed and NOT persisted onto the session shape on purpose: it is a one-shot fact
// about a keystroke, and a client that connects later has no draft to restore.
//
// It is BROADCAST, though — the worker never learns which connection sent a PTY_IN
// frame, so the event names no originator and every attached device is told. What keeps
// that invisible is entirely client-side: each client answers only for a submit whose
// text and timestamp it still holds. Found in review; stated here so the next reader
// does not mistake the broadcast for an addressed message. Like 'agentReady' and
// 'compacting', it never wakes a backgrounded phone.
workerClient.on('submitUnconfirmed', ({ id, at }) => {
  const payload = JSON.stringify({ type: 'submitUnconfirmed', id, at: at ?? null });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
  // #359 - a restart hold's wrap-up prompt that did not land is typed again.
  try { maintUpdate((h) => maintLib.noteUnconfirmed(h, id)); } catch (e) { console.error(`maintenance: ${e.message}`); }
  noteComposerUnconfirmed(id); // #479 - the person's words may still be in the box
});

workerClient.on('sessionExited', ({ id, claudeSessionId }) => {
  journalClosed(id); // #466 - first: the lines below forget who started it and why it ended
  // ntfy: drop any pending timers + stored level for the dead session.
  const nst = _notifyState.get(id);
  if (nst) { if (nst.idleTimer) clearTimeout(nst.idleTimer); if (nst.apiErrTimer) clearTimeout(nst.apiErrTimer); _notifyState.delete(id); }
  unwatchPendingQuestion(id); // #423 (function declaration, hoisted)
  pruneNotifyPref(id);
  pruneFavorite(id);   // #60: a dead session leaves no pin behind
  forgetComposer(id);  // #479: nor a draft (function declaration, hoisted)
  // #504 - who opened it, read before the line below forgets: its closed record keeps it,
  // so Mission Control still groups a finished child under its run.
  const spawnAtExit = spawnStore.field(id);
  spawnStore.forget(id);   // #351: nor a verdict on who started it
  // #412: and no lease - closed, reaped or crashed, the holder is gone. (try: the broker is
  // created further down this file; an exit can only arrive once the module has loaded.)
  // A session closed by its own hand-off (#340/#345) passes its leases to the successor, which
  // carries on the work - read before closeBrief below drops the record.
  try {
    const h = (briefStore().sessions[id] || {}).handoff;
    const successor = h && h.successorId && ['closing', 'kept'].includes(h.state) ? h.successorId : null;
    leaseBroker.onSessionExited(id, successor);
  } catch (e) { console.error(`[leases] ${e.message}`); }
  pruneAutoResumePref(id); // #137: and no auto-resume opt-out either
  closeBrief(id, undefined, claudeSessionId, { spawn: spawnAtExit }); // #298/#337: the dashboard keeps a record for a week, reopenable
  const set = sessionClients.get(id);
  if (set) {
    for (const client of set) {
      try { client.send('\r\n\x1b[31m[Session ended]\x1b[0m\r\n'); client.close(4000, 'Session ended'); } catch {}
    }
    sessionClients.delete(id);
  }
  const dispose = ptyOutDisposers.get(id);
  if (dispose) {
    try { dispose(); } catch {}
    ptyOutDisposers.delete(id);
  }
  // Issue #11: drop the cached idBytes entry so long-running servers don't
  // accumulate entries for dead sessions.
  try { workerClient.forgetSession(id); } catch {}
});

workerClient.onExit(() => {
  console.error(`[${new Date().toISOString()}] Worker IPC disconnected — server exiting so monitor restarts`);
  process.exit(1);
});

// --- Auth helpers ---
// Persist session secret so cookies survive server restarts
const SESSION_SECRET_FILE = path.join(__dirname, '.session-secret');
const SESSION_SECRET = (() => {
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) return fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
  } catch (e) {}
  const secret = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SESSION_SECRET_FILE, secret, 'utf8'); } catch (e) {}
  return secret;
})();

// H1: per-process hook token. Written to .hook-token in the same dir so
// claude-hook.js / claude-hook.sh (which live alongside) can read it. The
// token is regenerated on each fresh startup if the file is missing. Unix
// chmod 0600; Windows has no equivalent.
const HOOK_TOKEN_FILE = path.join(__dirname, '.hook-token');
const HOOK_TOKEN = (() => {
  try {
    if (fs.existsSync(HOOK_TOKEN_FILE)) {
      const existing = fs.readFileSync(HOOK_TOKEN_FILE, 'utf8').trim();
      if (existing && existing.length >= 32) return existing;
    }
  } catch (e) {}
  const tok = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(HOOK_TOKEN_FILE, tok, 'utf8');
    if (process.platform !== 'win32') {
      try { fs.chmodSync(HOOK_TOKEN_FILE, 0o600); } catch {}
    }
  } catch (e) {}
  return tok;
})();
const HOOK_TOKEN_BUF = Buffer.from(HOOK_TOKEN, 'utf8');

// Localhost-only callers may skip the hook token. On Windows .hook-token is
// world-readable (no chmod 0600 equivalent), so H1's protection against
// same-host processes was never real there; requiring the token still forces
// a worker-restart cycle to inject WT_HOOK_TOKEN into existing PTY env,
// which drops every running Claude session. Accepting loopback traffic
// closes that gap without weakening the wire-level protection against
// non-localhost callers.
//
// #297: "loopback" is NOT "this host" here. tailscale serve reverse-proxies every
// tailnet caller onto 127.0.0.1, so the socket address alone opened every route below
// to the whole tailnet. lib/local-request.js owns the rule: loopback AND no proxy
// forwarding headers.
function isLocalhostReq(req) {
  return isDirectLocalRequest(req);
}

function verifyHookToken(headerVal) {
  if (!headerVal || typeof headerVal !== 'string') return false;
  const got = Buffer.from(headerVal, 'utf8');
  if (got.length !== HOOK_TOKEN_BUF.length) return false;
  try {
    return crypto.timingSafeEqual(got, HOOK_TOKEN_BUF);
  } catch (e) { return false; }
}
const COOKIE_NAME = 'wt_session';
const COOKIE_MAX_AGE = 90 * 24 * 60 * 60 * 1000; // 90 days

function checkCredentials(user, pass) {
  if (!user || !pass) return false;
  try {
    const userMatch = crypto.timingSafeEqual(
      crypto.createHash('sha256').update(user).digest(),
      crypto.createHash('sha256').update(_USER).digest()
    );
    const passMatch = PASS.startsWith('$scrypt$')
      ? verifyPassword(pass, PASS)
      : crypto.timingSafeEqual(
          crypto.createHash('sha256').update(pass).digest(),
          crypto.createHash('sha256').update(PASS).digest()
        );
    return userMatch && passMatch;
  } catch (e) { return false; }
}

function makeSessionToken(user) {
  const payload = `${user}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

function verifySessionToken(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.substring(0, dot);
  const sig = token.substring(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(Buffer.from(payload, 'base64').toString()).digest('hex');
  let hmacOk = false;
  try {
    hmacOk = crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) { return false; }
  if (!hmacOk) return false;
  // M1: enforce server-side cookie expiry. Payload is `user:timestampMs`.
  // Reject if timestamp is older than COOKIE_MAX_AGE, or unparseable (fail closed).
  try {
    const decoded = Buffer.from(payload, 'base64').toString();
    const colon = decoded.lastIndexOf(':');
    if (colon === -1) return false;
    const ts = Number(decoded.substring(colon + 1));
    if (!Number.isFinite(ts) || ts <= 0) return false;
    if (Date.now() - ts > COOKIE_MAX_AGE) return false;
  } catch (e) { return false; }
  return true;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function setAuthCookie(res, user) {
  const token = makeSessionToken(user);
  res.set('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE / 1000}`);
}

function authenticateWs(ws, req, opts) {
  const cookies = parseCookies(req.headers.cookie);
  // Try cookie auth first, then Bearer token
  if (verifySessionToken(cookies[COOKIE_NAME])) return true;
  // Check for token in query string (express-ws may use req.query or req.url)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = req.query?.token || url.searchParams.get('token');
  if (token && verifyApiToken(token)) return true;
  // Issue #20 direct terminal: accept a short-lived signed token bound to this
  // session id. HMAC key is any of our api-tokens (the peer that minted it
  // used the token we issued to them as the shared secret).
  if (opts && opts.expectedSid) {
    const dt = req.query?.dt || url.searchParams.get('dt');
    if (dt) {
      const apiTokens = loadApiTokens();
      const candidates = Object.keys(apiTokens).filter(k => !peerTokens.isExpired(apiTokens[k], Date.now()));
      const vr = verifyDirectToken(dt, candidates);
      if (vr.valid && vr.payload && vr.payload.sid === opts.expectedSid) {
        // Authenticated as vr.payload.user — attach for downstream use.
        ws._wtUser = vr.payload.user;
        ws._wtAuthMode = 'direct';
        return true;
      }
      // Specific close codes so the client can tell expired vs wrong:
      //   4003 = direct token expired (client should refresh session list)
      //   4004 = direct token invalid (wrong sig / sid mismatch / malformed)
      if (vr.expired) {
        try { ws.close(4003, 'Direct token expired'); } catch {}
      } else {
        try { ws.close(4004, 'Direct token invalid'); } catch {}
      }
      return false;
    }
  }
  ws.close(1008, 'Unauthorized');
  return false;
}

// --- API Token auth (for cluster inter-server communication) ---
//
// `WT_API_TOKENS_FILE` redirects the store outright, for the same reason as
// `WT_CLUSTER_TOKENS_FILE` above and `WT_CONFIG_FILE`: every entry in this file is a
// LIVE bearer credential with full API access, and the Playwright server minted into
// the production store on every run (#272 follow-up: hundreds of `exec-test`,
// `client:companion:test-device` and `client:evilscript` entries, none ever revoked).
// Redirecting the path makes the real file unreachable from a test rather than
// merely cleaned up after one — an interrupted run never reaches a cleanup.
//
// THIS IS THE ONLY PROCESS THAT RESOLVES THE STORE. `pty-worker.js` and `monitor.js`
// never read it, and `lib/cluster-token.js` takes its keys as an argument. The two
// root `smoke-test-*.js` scripts write a token straight into the store of the server
// they drive, so they honour the same variable — an override read by the server and
// not by its smoke test would split one setting across the pair.
const API_TOKENS_FILE = process.env.WT_API_TOKENS_FILE || path.join(__dirname, 'api-tokens.json');

let _apiTokensCache = null, _apiTokensTime = 0;
function loadApiTokens() {
  if (!_apiTokensCache || Date.now() - _apiTokensTime > LIVE_CONFIG_TTL) {
    try {
      if (fs.existsSync(API_TOKENS_FILE)) _apiTokensCache = JSON.parse(fs.readFileSync(API_TOKENS_FILE, 'utf8'));
      else _apiTokensCache = {};
    } catch (e) { _apiTokensCache = {}; }
    _apiTokensTime = Date.now();
  }
  return _apiTokensCache;
}

function saveApiTokens(tokens) {
  fs.writeFileSync(API_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  _apiTokensCache = tokens; _apiTokensTime = Date.now(); // update cache immediately
}

function verifyApiToken(token) {
  const tokens = loadApiTokens();
  const entry = tokens[token];
  if (!entry) return false;
  if (peerTokens.isExpired(entry, Date.now())) {
    delete tokens[token];
    saveApiTokens(tokens);
    return false;
  }
  return true;
}

// The lifetime (90 days) and the entry shape are lib/peer-tokens.js's - #415 renews them.
function createApiToken(label) {
  const tokens = loadApiTokens();
  const token = peerTokens.mintToken(tokens, label, Date.now());
  saveApiTokens(tokens);
  return token;
}

/// #415 - the bearer token the caller authenticated with, from the Authorization header
/// only (never a cookie session, never ?token= in a URL): renewal and expiry are about the
/// credential the caller is holding, so a request not made with one has nothing to ask.
function presentedBearer(req) {
  const h = req.headers.authorization;
  if (!req._wtAuth || req._wtAuth.mode !== 'bearer' || !h || !h.startsWith('Bearer ')) return null;
  const token = h.substring(7);
  return req._wtAuth.identity === `bearer:${token}` ? token : null;
}

// --- Cluster: remote server management ---
let _clusterTokensCache = null, _clusterTokensTime = 0;
function loadClusterTokens() {
  if (!_clusterTokensCache || Date.now() - _clusterTokensTime > LIVE_CONFIG_TTL) {
    try {
      if (fs.existsSync(CLUSTER_TOKENS_FILE)) _clusterTokensCache = JSON.parse(fs.readFileSync(CLUSTER_TOKENS_FILE, 'utf8'));
      else _clusterTokensCache = {};
    } catch (e) { _clusterTokensCache = {}; }
    _clusterTokensTime = Date.now();
  }
  return _clusterTokensCache;
}

/// #415 - the renewer's read-modify-write must see what another writer (POST
/// /api/cluster/auth, scripts/cluster-relink.js) put in the file, not a 5 s cached copy.
function loadClusterTokensFresh() {
  _clusterTokensCache = null;
  return loadClusterTokens();
}

function saveClusterTokens(tokens) {
  fs.writeFileSync(CLUSTER_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  _clusterTokensCache = tokens; _clusterTokensTime = Date.now();
}

// Read cluster config (uses cached liveConfig)
function getClusterConfig() {
  return liveConfig('cluster', []);
}

// --- Login page ---
const LOGIN_PAGE = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Terminal — Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;
    display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
  .login{background:#16213e;border:1px solid #0f3460;border-radius:12px;padding:32px;
    width:360px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,0.5)}
  h1{color:#00d4aa;font-size:22px;margin-bottom:20px;text-align:center}
  label{display:block;color:#888;font-size:12px;margin-bottom:4px;margin-top:14px}
  input{width:100%;background:#1a1a2e;color:#e0e0e0;border:1px solid #0f3460;
    padding:10px 14px;border-radius:6px;font-size:15px}
  input:focus{border-color:#00d4aa;outline:none}
  .btn{width:100%;margin-top:20px;padding:12px;border:none;border-radius:6px;
    background:#00d4aa;color:#1a1a2e;font-size:16px;font-weight:600;cursor:pointer}
  .btn:hover{opacity:0.9}
  .error{color:#e94560;font-size:13px;margin-top:10px;display:none;text-align:center}
</style>
</head><body>
<div class="login">
  <h1>Web Terminal</h1>
  <form method="POST" action="/login">
    <label>Username</label>
    <input name="user" required autocomplete="username" autofocus>
    <label>Password</label>
    <input name="password" type="password" required autocomplete="current-password">
    <div id="error" class="error">ERRMSG</div>
    <button type="submit" class="btn">Sign in</button>
  </form>
</div>
</body></html>`;

// --- Rate limiting ---
const loginAttempts = new Map(); // ip -> { count, firstAttempt }
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60 * 1000;  // 60 seconds
const RATE_LIMIT_BLOCK = parseInt(process.env.WT_RATE_LIMIT_BLOCK) || 5 * 60 * 1000; // 5 minutes

function isRateLimited(ip) {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() - record.firstAttempt > RATE_LIMIT_BLOCK) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= RATE_LIMIT_MAX;
}

function recordFailedLogin(ip) {
  const record = loginAttempts.get(ip);
  if (!record || Date.now() - record.firstAttempt > RATE_LIMIT_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    record.count++;
  }
}

function clearLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of loginAttempts) {
    if (now - record.firstAttempt > RATE_LIMIT_BLOCK) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

// --- PWA static assets (before auth) ---
app.get('/manifest.json', (req, res) => {
  const name = getServerName();
  res.json({
    name: `Terminal — ${name}`,
    short_name: name,
    description: 'Browser-based terminal with multi-server session management',
    start_url: '/app',
    display: 'standalone',
    background_color: '#1e1e1e',
    theme_color: '#16213e',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]
  });
});
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/icon.svg', (req, res) => res.sendFile(path.join(__dirname, 'icon.svg')));

// --- Security headers ---
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data:");
  next();
});

// --- Public routes (before auth middleware) ---
app.get('/login', (req, res) => {
  // If already logged in, redirect to lobby
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[COOKIE_NAME]) && !needsPasswordChange()) {
    return res.redirect('/');
  }
  res.send(LOGIN_PAGE.replace('ERRMSG', ''));
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).send(LOGIN_PAGE.replace('display:none', 'display:block').replace('ERRMSG', 'Too many failed attempts. Try again in a few minutes.'));
  }
  const { user, password } = req.body || {};
  if (checkCredentials(user, password)) {
    clearLoginAttempts(ip);
    setAuthCookie(res, user);
    return res.redirect('/');
  }
  recordFailedLogin(ip);
  res.status(401).send(LOGIN_PAGE.replace('display:none', 'display:block').replace('ERRMSG', 'Invalid username or password'));
});

app.get('/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// --- API: auth token creation (before auth middleware — validates credentials itself) ---
app.post('/api/auth/token', express.json({ limit: '16kb' }), (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts' });
  }
  const { user, password, label } = req.body || {};
  if (!checkCredentials(user, password)) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  clearLoginAttempts(ip);
  const token = createApiToken(label || 'cluster');
  res.json({ ok: true, token });
});

// --- Claude hook endpoint (before auth middleware) ---
// H1: gated by X-WT-Hook-Token header (per-process secret in .hook-token).
// The token is generated on startup; hook senders (claude-hook.js /
// claude-hook.sh) read it from the same file.
// Supports two modes:
// 1. POST /api/session/:id/hook with {event} body (from command hooks)
// 2. POST /api/hook with X-WT-Session-ID header (from HTTP hooks, no subprocess)
// Claude Code hook payloads include the full tool_input / tool_response, which
// can exceed 16kb easily (e.g. Bash output, file reads). Bumped to 256kb to
// stop the steady drip of PayloadTooLargeError in error.log without
// accepting unbounded payloads.
//
// --- Hook event transform layer ---
// Claude's raw events alone produce noisy status: every Notification subtype
// (permission_prompt, idle_prompt, auth_success, elicitation_dialog, push_notification) maps to the
// same hook_event_name. That demux is all this layer does now — it decides which
// event the worker sees, never what the status becomes:
//   - Notification: read the payload `message` to decide
//       permission text  → PermissionRequest (waiting)
//       idle text        → Notification     (idle, after Claude's own 60s)
//       anything else    → dropped (don't flip status)
//   - every other event is forwarded verbatim.
//
// #61 — the idle DEBOUNCE and the SubagentStop drop both used to live here, and
// both were wrong for the same reason: this layer does not know what the worker
// knows. It held a Stop for HOOK_STOP_DEBOUNCE_MS and cancelled it on any working
// event — but a SUBAGENT's PreToolUse/PostToolUse posts under the PARENT's session
// id, so with background subagents running, the parent's genuine Stop was thrown
// away here and the worker never saw it. Meanwhile SubagentStop was dropped
// outright, so nothing could count what was still in flight. Both decisions now
// belong to the worker, which owns status and can count subagents (pty-worker.js
// armIdle / handleHook). One component decides idle; this one only names events.
let _hookSeqCounter = 0;
// Same regex the worker uses to reject non-UUID session ids. Mirrored here so
// processHookEvent can return a clean "session not found" for an id the worker
// would never accept anyway.
const _HOOK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #194 Gap 1 — the notifications nobody has ever seen.
//
// An unrecognised `Notification` is discarded, and until now discarded in
// SILENCE, so the set of messages Claude actually sends could not be known from
// this fleet's logs in either direction. The rule and the redaction live in
// `lib/notification-shape.js`; this map is the only state, and it is what keeps
// the log bounded: one line per distinct shape, then one per hundred repeats.
//
// Capped, because the keys come from an external payload. An unbounded map keyed
// on someone else's string is a slow leak, and the whole point of this counter
// is to survive being wrong about how often the path fires.
const _NOTIFICATION_SHAPE_MAX = 200;
const _dropLogState = notificationShape.newDropState();

function _logDroppedNotification(body) {
  // BOTH fields are external input, and both are bounded before they are written
  // down or used as a map key. An early cut bounded only the message and
  // interpolated the matcher raw — `/api/hook` accepts a 256 kB body, so that was
  // an unbounded write per occurrence AND an unbounded map key.
  const matcher = notificationShape.redactMatcher(notificationShape.matcherOf(body));
  const msg = notificationShape.redactNotificationMessage(body?.message);
  const stamp = new Date().toISOString();
  // NO DECISION HERE, deliberately. Both of this change's serious bugs lived in
  // the counting logic while it was inline in this file, where `server.js`
  // exporting nothing put it beyond reach of a test.
  const d = notificationShape.noteDrop(_dropLogState, `${matcher}|${msg}`, _NOTIFICATION_SHAPE_MAX);
  if (d.action === 'log') {
    console.error(
      `[${stamp}] hook Notification UNRECOGNISED (seen ${d.n}): `
      + `matcher=${JSON.stringify(matcher)} msg=${JSON.stringify(msg)}`,
    );
  } else if (d.action === 'full') {
    console.error(
      `[${stamp}] hook Notification shape table FULL at ${_NOTIFICATION_SHAPE_MAX} `
      + 'distinct shapes — NEW shapes are counted but no longer logged individually',
    );
  } else if (d.action === 'tally') {
    console.error(
      `[${stamp}] hook Notification: ${d.uncountable} events with NEW shapes since `
      + 'the table filled (not individually logged)',
    );
  }
}

// --- #423 a question the user REJECTED fires no hook ------------------------------
// "Chat about this" turns the AskUserQuestion down instead of answering it. MEASURED on
// claude 2.1.319 (2026-11-08, isolated rig, 6 runs): the rejected tool_result
// (is_error, toolDenialKind "user-rejected") is in the transcript within ~10 ms of the
// key, and NO hook follows it - no PostToolUse, no PostToolUseFailure. The next hook is
// the main agent's next tool, or Stop 27-38 s later after a text-only reply. Until then
// the pendingQuestion below stood, so every card that reads it (inbox, board, a freshly
// opened session screen) offered a question whose keys would land in a working Claude.
//
// The fix reads the one record that does exist: the transcript. PreToolUse carries the
// real `tool_use_id` (equal to the transcript tool_use id, 6/6), so the question is over
// when a tool_result for THAT id is written - matched by id only, never by text, so an
// identical re-ask is never cleared by the old answer. Without a real id or a
// transcript path nothing here runs and the question clears exactly as before.
//
// Clearing goes through processHookEvent as the PostToolUse Claude did not send - the
// same clear and the same worker signal an ordinary answer produces (questionPending
// false, status 'working': Claude IS replying), so no rule is copied and pty-worker.js
// is unchanged. Checked on a 1 s timer while a question is pending (one stat when the
// file has not moved, so it clears with no viewer polling), and at every read of the
// question: /pending-question, the digest, and the rows' waitingFor.
//
// #441 - Esc on the question in the terminal ALSO rejects it with no hook, and then the
// turn is OVER. MEASURED on claude 2.1.319 (2026-11-09, isolated rig, run hooks captured,
// 3 Esc runs: compact single, side-by-side, multi-select): no hook at all after the Esc,
// not even the idle Notification in 57-75 s; the result line's `toolUseResult` is the plain
// "User rejected tool use", then "[Request interrupted by user for tool use]" ~8 ms later.
// A Chat (5 runs) writes an "Error: ..." string there and Claude replies, Stop 2.2-2.6 s
// later. So a plain rejection is cleared as the PostToolUse AND the Stop Claude did not
// send: the PostToolUse drops the question flag and leaves 'waiting' at once (a Stop
// alone would hold 'waiting' - with no question, a "permission" - through the worker's
// idle debounce), the Stop idles it through the same funnel as a real one. Before, it
// read 'working' until the 5-minute stale rule.
const QUESTION_WATCH_MS = 1000;
// Claude's ids are `toolu_<base62>`; anything else is not used. It is only ever compared
// with transcript ids, never used as a path or written anywhere.
const _TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const _questionWatch = new Map(); // session id -> { question, toolUseId, tpath, size, mtimeMs, timer }

function unwatchPendingQuestion(id) {
  const w = _questionWatch.get(id);
  if (!w) return;
  clearInterval(w.timer);
  _questionWatch.delete(id);
}

// `tpath` is the session's stashed transcript path, already through safeTranscriptPath.
function watchPendingQuestion(id, question, toolUseId, tpath) {
  unwatchPendingQuestion(id);
  if (typeof toolUseId !== 'string' || !_TOOL_USE_ID_RE.test(toolUseId)) return;
  if (typeof tpath !== 'string' || !tpath) return;
  const timer = setInterval(() => {
    try { checkPendingQuestion(id); } catch (e) { console.error(`question watch failed: ${e.message}`); }
  }, QUESTION_WATCH_MS);
  if (timer.unref) timer.unref();
  _questionWatch.set(id, { question, toolUseId, tpath, size: -1, mtimeMs: -1, timer });
}

/** THE owner of "is the captured question still pending" (#423). Clears it when the
 *  transcript holds a tool_result for its real id. Synchronous on purpose: the check
 *  and the clear happen in one tick, so no hook can slip between them and be undone.
 *  `resolvedNow`: this call cleared it, so a worker status read BEFORE the call is the
 *  question's 'waiting' and says nothing any more. */
function checkPendingQuestion(id) {
  const ns = _notifyState.get(id);
  const question = (ns && ns.pendingQuestion) || null;
  const w = _questionWatch.get(id);
  if (!w) return { question, resolvedNow: false };
  if (!question || w.question !== question) {
    unwatchPendingQuestion(id);
    return { question, resolvedNow: false };
  }
  let st;
  try { st = fs.statSync(w.tpath); } catch { return { question, resolvedNow: false }; }
  if (st.size === w.size && st.mtimeMs === w.mtimeMs) return { question, resolvedNow: false };
  let outcome;
  // #441 - remembered only once READ: a failed read (EBUSY while Claude writes) must not
  // mark this size and mtime as seen, or nothing looks again until the next write.
  try { outcome = transcript.toolResultOutcome(transcriptTailText(w.tpath), w.toolUseId); }
  catch { return { question, resolvedNow: false }; }
  w.size = st.size;
  w.mtimeMs = st.mtimeMs;
  if (!outcome) return { question, resolvedNow: false };
  console.log(`[${new Date().toISOString()}] question ${String(id).slice(0, 8)}: tool_result for ${w.toolUseId} `
    + `in transcript, no PostToolUse yet - cleared${outcome.interrupted ? ' (Esc: the turn ended)' : ''}`);
  // Only what was seen: an ordinary answer's own PostToolUse can still be on its way.
  // Each runs synchronously up to its worker RPC, so they reach the worker in this order;
  // the first clears pendingQuestion and unwatches.
  const clear = (event, body) => processHookEvent(id, event, undefined, body)
    .catch((e) => console.error(`question clear for ${String(id).slice(0, 8)} failed: ${e.message}`));
  clear('PostToolUse', { tool_name: 'AskUserQuestion' });
  if (outcome.interrupted) clear('Stop', {});
  return { question: null, resolvedNow: true };
}

/** #441 - every watched question settled, for a caller about to read the worker's
 *  statuses: the read then sees the clear, so a row never pairs the question's
 *  'waiting' with no question (as /digest already does for one session). */
function settlePendingQuestions() {
  for (const id of [..._questionWatch.keys()]) checkPendingQuestion(id);
}

// Returns { status } like the worker RPC. Resolves immediately for a dropped
// event so the calling HTTP handler can reply.
async function processHookEvent(id, rawEvent, claudeSessionId, body) {
  if (!id || !rawEvent) return { status: 'unchanged', skipped: 'no id/event' };

  // Reject invalid session ids before any state allocation or debounce
  // scheduling so callers get a real 404 instead of a fire-and-forget 200,
  // and a flood of bogus ids can't grow _hookState. The worker uses the
  // same regex, so anything that fails here would have failed at the worker.
  if (!_HOOK_UUID_RE.test(id)) {
    throw new Error('session not found');
  }

  const seq = ++_hookSeqCounter;

  // Remember where this session's Claude transcript lives so a later push can
  // quote its last message. Every http-hook payload carries transcript_path;
  // stash it before any early return. Cleaned up on sessionExited with the rest
  // of the notify-state. M1: validate it (realpath'd .jsonl under the Claude
  // projects root) before trusting it — an unvalidated path would let a hook
  // steer /attention + the ntfy detail at any file on disk.
  if (body && typeof body.transcript_path === 'string' && body.transcript_path) {
    const safe = safeTranscriptPath(body.transcript_path);
    if (safe) _nstate(id).transcriptPath = safe;
  }

  // #19: track a LIVE interactive question. Claude writes the AskUserQuestion
  // tool_use to the transcript only once it's ANSWERED, so the transcript can't
  // reveal a prompt while it's on screen. The PreToolUse hook carries the full
  // questions up front — stash them so the app can render the overlay while the
  // prompt is pending; clear on PostToolUse (answered), a new user turn, Stop,
  // or the next (different) tool — but only when that tool is the MAIN agent's,
  // never a subagent's running beside the question (#236).
  const _tool = body && body.tool_name;
  // #61 — `agent_id` is present iff Claude raised this event INSIDE a subagent
  // (verified against the real hook stream: SubagentStart/SubagentStop and a
  // subagent's own PreToolUse/PostToolUse carry it; the main agent's events —
  // Stop, UserPromptSubmit, and its own tool calls — never do). The worker needs
  // it to tell "the main agent resumed" from "a subagent is calling a tool", so
  // it is passed straight through to the RPC below; the worker owns what it MEANS.
  //
  // It is read HERE, above the question block, rather than beside that RPC, because
  // the rule immediately below needs the same distinction and did not have it: #236.
  const agentId = (body && typeof body.agent_id === 'string' && body.agent_id) ? body.agent_id : undefined;
  // #236 — a SUBAGENT's tool call is not evidence about the MAIN agent's question.
  // The `PreToolUse` clause below reads "a different tool started, so the prior question
  // is resolved" — true of a strictly SEQUENTIAL single agent, and false the moment a
  // subagent runs beside it. `!agentId` is the whole fix.
  //
  // MEASURED on adiel-Home 2026-09-07, in this repo's own session: the main agent
  // dispatched a subagent at 09:48:12.687 and asked an AskUserQuestion at 09:48:20.539,
  // answered at 09:49:02.107. Nothing ran in the MAIN transcript in between — but the
  // subagent's (<session>/subagents/agent-*.jsonl, every line isSidechain) ran Bash at
  // 09:48:25.527, and the worker logged `waiting -> working (PreToolUse)` 19ms later.
  // Reading the two transcripts against the log is what makes it provable; the log names
  // the event but not whose it was.
  //
  // The REPORTED incident, on adiel-0ffice twelve minutes earlier, has the same log shape
  // and is NOT proven to be the same cause: its hook body was never captured, so nobody
  // has seen whether that PreToolUse carried agent_id. What IS measured is the bound on
  // the alternative, on adiel-Home: of 923 transcripts, 93 of the 94 assistant messages
  // that issue an AskUserQuestion issue it ALONE. The one exception is a batch of
  // [Bash, AskUserQuestion] whose Bash was emitted at 11:31:41.142 and had RETURNED by
  // 11:31:41.334 — 2.1s before the question block existed at 11:31:43.453 — so it ran
  // serially and no PreToolUse of its could follow the question.
  //
  // Two things that measurement is NOT. It is not "never batched": grouping by JSONL LINE
  // says zero, because Claude Code writes each content block on its own line, and the
  // positive control gives that away — grouped by message.id, 4,755 of 40,024 tool-using
  // messages are batched. And it does not establish that a turn is suspended while a tool
  // call is outstanding; that same case DISPROVES it, since the Bash ran while the message
  // was still streaming. What is left unmeasured is a question-FIRST batch
  // ([AskUserQuestion, X], 0 of 94 observed): whether the executor would start X before
  // the question resolves is INFERRED from Claude Code's serial handling of tools that are
  // not concurrency-safe, not measured. Office's own subagents/ directory would settle
  // Office outright and is the cheaper answer than closing that gap.
  //
  // Both of the chat lens's signals read one of the two halves this cleared, so they went
  // dark together: `waitingFor` (#79) needs status 'waiting' AND a captured question, and
  // the overlay's /pending-question falls back to a transcript that BY DESIGN cannot hold
  // an unanswered one. ON THIS PATH the worker needs no matching guard — its status is
  // `questionPending ? 'waiting' : 'working'`, so leaving the flag alone (#98's tri-state)
  // keeps the session 'waiting' and off the 5-minute clock that had been demoting it to
  // idle while the prompt was still on screen. (#230 has since removed the longer
  // horizon that stood behind it too: a blocked-on-user session is not timed out at all.)
  // Only this path: a held idle Notification released by SubagentStop reaches armIdle
  // with no such check — that was #239, fixed separately in the worker.
  //
  // Gated on the EVENT's agent, not on the question's. Recording who ASKED would be the
  // more general rule, and it would be a generalisation of a case that has never occurred:
  // 0 of 775 subagent transcripts here contain an AskUserQuestion. If one ever does, the
  // only thing that stops resolving it is its OWN sibling tool calls: its PostToolUse still
  // answers it, and so do the main agent's next tool, UserPromptSubmit and Stop. Only a
  // LOST PostToolUse (a hot reload in the window) leaves it standing until the turn's Stop
  // — one event later, in the direction that SHOWS a question rather than hides one.
  // #98 — TRI-STATE, and the third state is the whole point: `undefined` means
  // "this event says nothing about a question", which is NOT the same as "there
  // is no question". Only the two branches below actually learn something, so
  // only they speak. Everything else (a Notification, another tool's PostToolUse,
  // SubagentStop…) leaves the worker's flag alone. See the send site.
  let questionSignal;
  if (rawEvent === 'PreToolUse' && _tool === 'AskUserQuestion') {
    const questions = transcript.shapeQuestions(body.tool_input);
    if (questions.length) {
      const question = { toolUseId: `hook-${id}-${seq}`, questions };
      _nstate(id).pendingQuestion = question;
      // #423 - the real id and the transcript let a rejection, which fires no hook, clear it.
      watchPendingQuestion(id, question, body.tool_use_id, _nstate(id).transcriptPath);
      questionSignal = true;
    }
  } else if (
    (rawEvent === 'PostToolUse' && _tool === 'AskUserQuestion') ||
    // a different tool started — prior question resolved, but only when the tool is
    // the MAIN agent's own: a subagent's runs BESIDE the question, not after it (#236)
    (rawEvent === 'PreToolUse' && !agentId) ||
    rawEvent === 'UserPromptSubmit' ||
    rawEvent === 'Stop'
  ) {
    const ns = _notifyState.get(id);
    if (ns && ns.pendingQuestion) ns.pendingQuestion = null;
    unwatchPendingQuestion(id);
    // Say `false` even when this process held no question: everything that reaches
    // here resolves one by definition — a subagent's PreToolUse no longer does, and no
    // longer reaches — so this is real evidence, not the absence of it. It is
    // what still clears a worker flag set before a hot reload — e.g. the user
    // answered in the terminal while this server.js was being replaced.
    questionSignal = false;
  }

  // #73 — fold the agent's task list as its tool calls complete. PostToolUse is the only
  // event that carries the RESULT, and for Claude the result is the only place a task's
  // id exists (`Task #7 created successfully: …`) — the tool INPUT never names it.
  //
  // Why the fold lives here rather than in the worker, unlike status (#61) or compaction
  // (#65): this is DERIVED, REPAIRABLE state, not an authority. A hot reload loses it,
  // and the very next TaskList result — which Claude is told to call after finishing a
  // task — replaces the whole list authoritatively. Keeping it beside `pendingQuestion`
  // in the same per-session notify-state costs no worker protocol change and no cold
  // restart. If it ever grows a job the worker must arbitrate (driving a dot, firing a
  // push), it belongs in the worker and this comment is the reason to move it.
  if (rawEvent === 'PostToolUse' && body) {
    try {
      const delta = agentsLib.parseTaskDelta(null, body.tool_name, body.tool_input, body.tool_response);
      if (delta) {
        const ns = _nstate(id);
        ns.taskList = taskListLib.foldTaskEvent(ns.taskList, delta);
      }
    } catch { /* a task-list parse must never break status delivery */ }
  }

  let event = rawEvent;

  if (event === 'Notification') {
    const kind = notificationShape.classifyNotification(body);
    if (kind === notificationShape.NOTIFICATION_KINDS.PERMISSION) { event = 'PermissionRequest'; }
    else if (kind === notificationShape.NOTIFICATION_KINDS.IDLE)  { event = 'Notification'; }
    else {
      // Behaviour is UNCHANGED for both remaining kinds — they were dropped
      // before and are dropped now, and the response body still says exactly
      // what it always said. The only new thing is that an UNKNOWN one leaves a
      // trace. Deciding what to do with it comes after the data, not before.
      if (kind === notificationShape.NOTIFICATION_KINDS.UNKNOWN) _logDroppedNotification(body);
      return { status: 'unchanged', skipped: 'notification-other' };
    }
  }

  // Forward the user's prompt on UserPromptSubmit so the worker can replay it
  // during API-error /compact recovery. (Claude's hook payload carries `prompt`.)
  const prompt = (event === 'UserPromptSubmit' && body && typeof body.prompt === 'string')
    ? body.prompt : undefined;
  // #79 — hand the worker the bare FACT that a question is on screen, which it has
  // no other way to learn: this layer is the only one that sees the AskUserQuestion
  // payload (just parsed, above), and the worker is the one that owns status. It
  // matters because such a session is 'working' yet emits no hook and no PTY output
  // while it waits, so both of correctStaleStatus's clocks go stale and the dot went
  // calm green on the one session that owed an answer. Only the bare signal crosses
  // the boundary — this layer still decides no status, and the worker parses no payload.
  //
  // #98 — this MUST stay a tri-state. It was `!!(_notifyState.get(id) || {}).pendingQuestion`,
  // which can never produce "I don't know": `!!undefined` is `false`, so every event
  // this layer knows nothing about still asserted "no question is on screen". That
  // defeated the worker's own safety rule three lines below its comment saying an
  // absent value must leave the flag alone — the producer could not produce absence.
  //
  // It bit exactly where that comment predicted. `_notifyState` is in-memory here, so
  // a server.js hot reload empties it while the worker keeps the session. Claude then
  // fires an idle `Notification` while the question is still on screen, that Notification
  // carried `questionPending: false`, the worker cleared `blockedOnUser`, and
  // correctStaleStatus's 5-minute rule turned the dot calm GREEN on the one session that
  // owed an answer. Observed on Office-Tests 2026-08-04, whose server.js had restarted
  // three minutes after its worker. `undefined` is dropped by JSON, so the field simply
  // does not arrive and the worker keeps what it had.
  return workerClient.rpc('hookEvent',
    { id, event, claudeSessionId, prompt, agentId, questionPending: questionSignal });
}

// --- #298 sessions dashboard: one BRIEF per session -----------------------------
// lib/session-brief.js owns every rule (what a report may hold, what counts as a work
// item having moved, when the report is stale, when a Stop is blocked); this block owns
// the store, the hook wiring and the routes. Same file-backed shape as favorites.json.
//
// Server-side, not in the worker, for the reason #73's task fold is: the brief is
// DERIVED, REPAIRABLE state that drives no status dot and fires no push, so it costs no
// worker protocol change and no cold restart, and it hot-reloads.
const SESSION_BRIEFS_FILE = process.env.WT_SESSION_BRIEFS_FILE || path.join(__dirname, 'session-briefs.json');
const REPORT_COMMAND = briefLib.reportCommand(path.join(__dirname, 'scripts', 'wt-report.js'));
let _briefs = null;
let _briefSaveTimer = null;
// Ids that came from DISK. A session that ended while server.js was down never fires
// sessionExited here, so the first session list after load closes whichever of these is
// no longer in it. Only these: an entry created after load belongs to a session the
// worker had just accepted a hook for, and a list fetched a moment earlier must not
// close it.
let _briefsLoadedIds = null;
function reconcileBriefs(liveIds) {
  briefStore();
  if (!_briefsLoadedIds) return;
  const live = new Set(liveIds);
  // Stamped with when it was LAST SEEN, not now: it ended while nothing was watching,
  // and "closed just now" would be false and buy it a fresh day on the strip.
  for (const id of _briefsLoadedIds) {
    // #413 - `lost`: its work on its items ended at an unknown point, unwatched.
    if (!live.has(id)) {
      journalClosed(id, { lost: true, at: briefLib.lastSeen(briefStore().sessions[id]) || undefined }); // #466
      closeBrief(id, briefLib.lastSeen(briefStore().sessions[id]) || undefined, undefined, { lost: true });
    }
  }
  _briefsLoadedIds = null;
}
function briefStore() {
  if (!_briefs) {
    let raw = null;
    try { raw = fs.readFileSync(SESSION_BRIEFS_FILE, 'utf8'); } catch { /* absent: a first run */ }
    try {
      const j = raw === null ? {} : JSON.parse(raw);
      const sessions = (j && typeof j.sessions === 'object' && j.sessions) || {};
      // "Doing now" is a live fact; after a restart it would be a stale claim.
      for (const e of Object.values(sessions)) if (e) e.now = null;
      _briefs = { sessions, closed: Array.isArray(j && j.closed) ? j.closed : [] };
    } catch (e) {
      // UNREADABLE is not ABSENT (#257's lesson): move it aside instead of letting the
      // next debounced save replace it with an empty store.
      const aside = `${SESSION_BRIEFS_FILE}.corrupt-${Date.now()}`;
      try { fs.renameSync(SESSION_BRIEFS_FILE, aside); } catch { /* best effort */ }
      console.error(`session-briefs unreadable (${e.message}); moved to ${path.basename(aside)}`);
      _briefs = { sessions: {}, closed: [] };
    }
    _briefsLoadedIds = new Set(Object.keys(_briefs.sessions));
  }
  return _briefs;
}
function saveBriefsSoon() {
  if (_briefSaveTimer) return;
  _briefSaveTimer = setTimeout(() => {
    _briefSaveTimer = null;
    try {
      const tmp = `${SESSION_BRIEFS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(_briefs));
      fs.renameSync(tmp, SESSION_BRIEFS_FILE);
    } catch (e) { console.error('session-briefs write failed:', e.message); }
  }, 1000);
  if (_briefSaveTimer.unref) _briefSaveTimer.unref();
}
function getBriefEntry(id) { return briefStore().sessions[id] || null; }
function setBriefEntry(id, entry) {
  briefStore().sessions[id] = entry;
  saveBriefsSoon();
  invalidateClusterSessionsCache();
}
function dashboardConfig() {
  const c = liveConfig('dashboard', null);
  return c && typeof c === 'object' ? c : {};
}

// Where a session's work items live, from its repo's `origin` - so an item can be a
// link. Cached per cwd and refreshed in the background: a session row must never
// wait on git (#280's lesson about anything that spawns on the poll path).
const _originCache = new Map(); // cwd -> { at, origin }
const ORIGIN_TTL_MS = 10 * 60 * 1000;
function originForCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const hit = _originCache.get(cwd);
  if (!hit || Date.now() - hit.at > ORIGIN_TTL_MS) {
    _originCache.set(cwd, { at: Date.now(), origin: hit ? hit.origin : null });
    if (fs.existsSync(cwd)) {
      execGit(['-C', cwd, 'remote', 'get-url', 'origin'], { timeoutMs: 3000 })
        .then((url) => { _originCache.set(cwd, { at: Date.now(), origin: briefLib.parseOrigin(url) }); })
        .catch(() => {});
    }
  }
  return (_originCache.get(cwd) || {}).origin || null;
}

/** The `brief` field on a session row. ONE helper for BOTH shapers (/api/sessions and
 *  the local branch of the cluster merge) — four fields have already been forgotten in
 *  one of the two; tests/session-brief-routes.spec.js pins that both call this. */
/** #313 - stamp `reason` on shaped session rows. Both shapers call this AFTER the row
 *  is built, so the rule reads exactly the published fields (status, waitingFor,
 *  usageLimit, backgroundTasks, brief) and nothing a peer's row would lack.
 *  #340 - and `handoff` (lib/handoff.js), after `reason`, which it reads. Same helper
 *  for the same reason: both shapers already call it, so neither can forget the field. */
function addSessionReasons(rows) {
  // #443 - a live child session (#374 parentId) is live work for its parent, joined here
  // because only the whole list knows a session's children; the reason and the hand-off
  // rule below then read it like any other entry in backgroundTasks.
  addChildWork(rows);
  const now = Date.now();
  const cfg = handoffLib.handoffConfig(liveConfig('handoff', null));
  const ciCfg = checkInCfg();
  for (const r of rows) {
    r.reason = sessionReasonLib.sessionReason(r);
    r.handoff = handoffLib.handoffCandidate(r, { now, cfg, supported: agentsLib.handsOff(r.agent) });
    // #443 - the last check-in and what came back, while its idle period lasts.
    r.checkIn = checkInLib.checkInField(r, { now, cfg: ciCfg, supported: agentsLib.checksIn(r.agent) });
  }
  return rows;
}

function sessionBriefField(s) {
  const e = getBriefEntry(s.id);
  if (!e) return null;
  if (!e.artifactsScanned) backfillBriefArtifacts(s.id);
  if (s.name && e.name !== s.name) e.name = s.name; // for the closed list; not worth a write
  // #337 - and what reopening it needs once it has closed (briefLib.resumeOf). Same
  // terms as the name: kept on the entry, written with the next save.
  const launch = { autoCommand: s.autoCommand || '', agent: s.agent || null, claudeSessionId: s.claudeSessionId || null, cwd: s.cwd || null };
  if (!e.launch || JSON.stringify(e.launch) !== JSON.stringify(launch)) e.launch = launch;
  return {
    ...briefLib.buildBrief(e, {
      reporting: briefLib.reportingEnabled(e, dashboardConfig()), origin: originForCwd(e.cwd),
    }),
    // #340 - the hand-off in progress, or how the last one ended (lib/handoff.js).
    handoff: handoffLib.publicRun(e.handoff),
    // #443 - the last check-in typed into it, and the person's off switch for them.
    checkIn: checkInLib.publicRecord(e.checkIn),
    checkInOff: Boolean(e.checkInOff),
  };
}

/** A session ended: keep a one-line record for the dashboard's "closed" strip and drop
 *  its live entry. Runs from sessionExited, which every way a session ends goes through.
 *  #337 - the record also carries what a Reopen needs (cwd, agent, conversation, and the
 *  resume command when there is one); [conversationId] is the worker's answer at exit. */
/** #504 - the part of a session's `spawn` its closed record keeps: `{spawn: {parentId,
 *  replaces, createdAt}}`, or nothing when it had no parent and replaced nobody. */
function closedSpawnField(sp) {
  if (!sp || (!sp.parentId && !(Array.isArray(sp.replaces) && sp.replaces.length))) return {};
  return { spawn: { parentId: sp.parentId || null, replaces: Array.isArray(sp.replaces) ? sp.replaces.slice() : [], createdAt: Number.isFinite(sp.createdAt) ? sp.createdAt : null } };
}
function closeBrief(id, at, conversationId, { lost = false, spawn } = {}) {
  const store = briefStore();
  const e = store.sessions[id];
  const killedHow = _killedHow.get(id);
  _killedHow.delete(id);
  if (!e) return;
  const b = briefLib.buildBrief(e, { reporting: false, origin: originForCwd(e.cwd) });
  const resume = briefLib.resumeOf(e.launch, { conversationId, hookCwd: e.cwd });
  // #345 - a run whose session ended under it (killed by hand, crashed) still gets an
  // outcome line. `closing` already logged `closed` when it killed the session itself.
  if (handoffLib.isActive(e.handoff) && e.handoff.state !== 'closing') logHandoff('exited', id, e.handoff);
  // #340 - where its work went, when it was handed off.
  const handedOffTo = e.handoff && e.handoff.successorId && ['closing', 'kept'].includes(e.handoff.state)
    ? { id: e.handoff.successorId, name: e.handoff.successorName || null } : null;
  store.closed = briefLib.closeSession(store.closed, {
    id, name: e.name || null, items: b.items, headline: b.headline, did: b.did, artifacts: b.artifacts,
    // #523 - the line of work it reported, so a finished session keeps its items on it.
    ...(b.line ? { line: b.line } : {}),
    ...resume, ...(at ? { at } : {}),
    ...(handedOffTo ? { handedOffTo } : {}),
    // #504 - its parent and the ids it replaced, when it had any (lib/mc-tree.js).
    ...closedSpawnField(spawn !== undefined ? spawn : spawnStore.field(id)),
  }, Date.now());
  // #413 - every item it was on: an event line, and the configured command. After the
  // closed record, so nothing here can cost the dashboard its record; never throws.
  workItemsCheckpoint(id, e, workItems.endEvent({ lost, handoffState: e.handoff && e.handoff.state, killedHow }), {
    at: at || Date.now(),
    extra: { cwd: resume.cwd, resumeCommand: resume.resumeCommand, handedOffTo,
      handoffBriefFile: handedOffTo ? e.handoff.briefFile : null },
  });
  delete store.sessions[id];
  saveBriefsSoon();
}

// --- #413 Work-item resume ------------------------------------------------------------
// The rules are lib/work-items.js; this is the I/O. At every point a session's work on an
// item ends or is handed on - closeBrief above (every exit) and the hand-off verdict - one
// event line per item goes to the log, and the configured `workItemHook` command (absent =
// off) is run once per item with the payload on stdin, queued, never awaited.
const WORK_ITEMS_LOG_FILE = process.env.WT_WORK_ITEMS_LOG_FILE || path.join(__dirname, 'logs', 'work-items.jsonl');
const _workItemQueue = workItemHook.createQueue();
// How a kill THIS server asked for was meant, set just before the kill RPC: the exit event
// that follows cannot tell a person's close from a crash on its own.
const _killedHow = new Map();
let _workItemHookError = null;
function workItemHookCfg() {
  const c = workItems.hookConfig(liveConfig('workItemHook', null));
  // A malformed config is refused (off), and said once - not on every close.
  if (c.error && c.error !== _workItemHookError) console.error(`[work-items] ${c.error} - the command is OFF`);
  _workItemHookError = c.error;
  return c;
}
function appendWorkItemEvents(lines) {
  try { workItemLog.appendLines(WORK_ITEMS_LOG_FILE, lines); } catch (err) {
    console.error(`[work-items] event log write failed: ${err.message}`);
  }
}
// --- #466 The sessions journal ------------------------------------------------------------
// One line per lifecycle event of THIS server's sessions (lib/session-journal.js shapes them):
// opened, hand-off, closed and why. The supervisor on the lease authority merges every
// server's file (GET /api/journal), so a session that lived less than a minute is still seen.
const SESSIONS_JOURNAL_FILE = process.env.WT_SESSIONS_JOURNAL_FILE || path.join(__dirname, 'logs', 'sessions-journal.jsonl');
function journalAppend(line) {
  try { workItemLog.appendLines(SESSIONS_JOURNAL_FILE, [line], { maxBytes: journalLib.MAX_BYTES }); } catch (err) {
    console.error(`[journal] write failed: ${err.message}`);
  }
}
/** The `closed` line for [id]: why it ended (lib/work-items.js endEvent, the rule the work-item
 *  log uses), who started it (#351, read before the spawn store forgets it) and what it last
 *  reported. Reads only; never consumes the kill reason closeBrief reads after it. */
function journalClosed(id, { lost = false, at } = {}) {
  try {
    const e = briefStore().sessions[id] || null;
    const h = e && e.handoff;
    const why = workItems.endEvent({ lost, handoffState: h && h.state, killedHow: _killedHow.get(id) });
    const meta = spawnStore.metaOf(id);
    const brief = e ? briefLib.buildBrief(e, { reporting: briefLib.reportingEnabled(e, dashboardConfig()), origin: originForCwd(e.cwd) }) : null;
    const successorId = h && h.successorId && ['closing', 'kept'].includes(h.state) ? h.successorId : null;
    journalAppend(journalLib.closedRecord({ id, at: Date.now(), endedAt: at, why, name: e && e.name, brief, by: meta && meta.by, successorId }));
  } catch (err) { console.error(`[journal] closed ${id}: ${err.message}`); }
}

/** One event line and one command run per work item of [entry]'s brief. */
function workItemsCheckpoint(id, entry, reason, { at = Date.now(), extra = {} } = {}) {
  try {
    const e = entry || {};
    const brief = briefLib.buildBrief(e, { reporting: briefLib.reportingEnabled(e, dashboardConfig()), origin: originForCwd(e.cwd) });
    if (!brief.items.length) return;
    const machine = getServerName();
    const sessionName = e.name || null;
    appendWorkItemEvents(brief.items.map((item) => workItems.eventRecord({ event: reason, item, sessionId: id, sessionName, machine, brief, at, extra })));
    const cfg = workItemHookCfg();
    if (!cfg.enabled) return;
    for (const item of brief.items) {
      const payload = workItems.cardPayload({ reason, item, sessionId: id, sessionName, machine, report: e.reported || null, brief, at, extra });
      _workItemQueue.enqueue(cfg, payload).then((r) => {
        if (!r.ok && !r.skipped) console.error(`[work-items] ${reason} ${item.ref} (${id}): the command failed - ${r.error}`);
      });
    }
  } catch (err) { console.error(`[work-items] ${reason} (${id}): ${err.message}`); }
}
/** An agent's report: an event line for each item NEW to the session or whose state changed. */
function workItemsReported(id, prevItems, entry) {
  try {
    const changed = workItems.reportedChanges(prevItems, entry.reported && entry.reported.items);
    if (!changed.length) return;
    const origin = originForCwd(entry.cwd);
    const brief = briefLib.buildBrief(entry, { reporting: true, origin });
    const machine = getServerName();
    appendWorkItemEvents(changed.map((it) => workItems.eventRecord({ event: 'reported', item: { ...it, key: briefLib.globalKey(it.ref, origin) },
      sessionId: id, sessionName: entry.name || null, machine, brief, at: Date.now() })));
  } catch (err) { console.error(`[work-items] report (${id}): ${err.message}`); }
}
/** The hand-off brief an item's newest hand-off named, while it is still on disk. Only a
 *  file in HANDOFF_DIR with the server's own name pattern is ever read. */
function workItemHandoffBrief(view) {
  const ev = [...((view && view.events) || [])].reverse().find((l) => typeof l.handoffBriefFile === 'string');
  if (!ev) return null;
  const file = path.resolve(ev.handoffBriefFile);
  if (path.dirname(file) !== path.resolve(HANDOFF_DIR) || !/^handoff-[0-9a-f-]+\.md$/i.test(path.basename(file))) return null;
  try {
    const buf = fs.readFileSync(file);
    return { file: ev.handoffBriefFile, text: buf.subarray(0, workItems.HANDOFF_BRIEF_MAX).toString('utf8'), truncated: buf.length > workItems.HANDOFF_BRIEF_MAX };
  } catch { return { file: ev.handoffBriefFile, text: null, gone: true }; }
}
function localWorkItemView(key) {
  const view = workItems.workItemView(workItemLog.readLines(WORK_ITEMS_LOG_FILE), key);
  return { ...view, machine: getServerName(), handoffBrief: workItemHandoffBrief(view) };
}
/** This server's view merged with every peer's (each asked WITHOUT fan-out, so no loop).
 *  A peer that cannot be asked is named in `unreachable`, never silently left out. */
async function clusterWorkItemView(key) {
  const local = localWorkItemView(key);
  const tokens = loadClusterTokens();
  const publicUrl = liveConfig('publicUrl', null);
  const peers = (getClusterConfig() || []).filter((s) => s && s.url && (!publicUrl || s.url !== publicUrl));
  const unreachable = [];
  const remote = await Promise.all(peers.map(async (s) => {
    const t = tokens[s.url];
    if (!t || !t.token) { unreachable.push(s.name || s.url); return null; }
    try {
      const r = await clusterFetch(`${s.url}/api/work-items/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${t.token}` }, timeout: 3000 });
      const v = r.ok ? workItems.peerView(JSON.parse(r.body), key) : null;
      if (!v) unreachable.push(s.name || s.url);
      return v;
    } catch { unreachable.push(s.name || s.url); return null; }
  }));
  const views = [local, ...remote.filter(Boolean)];
  const merged = workItems.mergeViews(key, views);
  // The brief of the NEWEST event that names one, from the machine that holds that file.
  const named = [...merged.events].reverse().find((l) => typeof l.handoffBriefFile === 'string');
  const owner = named && views.find((v) => v.handoffBrief && v.handoffBrief.file === named.handoffBriefFile);
  const handoffBrief = owner ? owner.handoffBrief : null;
  return { ...merged, handoffBrief, unreachable, text: workItems.resumeText(merged, { handoffBrief, unreachable }) };
}
function workItemKeyOr400(req, res) {
  const key = workItems.parseRefParam(req.params.ref);
  if (!key) res.status(400).json({ error: 'not a work-item ref (ado:123, #123 or owner/repo#123)' });
  return key;
}

/** Fold a hook into the session's brief. Called only AFTER the worker accepted the
 *  event, so a hook for a session that does not exist never creates an entry. */
function foldBriefHook(id, event, body) {
  const prev = getBriefEntry(id);
  const now = Date.now();
  rememberBounded(_lastHookAt, id, now); // #470 - a hook is proof of life: no older snapshot outvotes it
  // #443 - then the check-in (delivery, and its answer at that turn's Stop), on the SAME
  // clock, after the brief: it reads this hook's turnAt, stoppedAt and reported wait.
  const next = checkInLib.noteHook(briefLib.foldHook(prev, event, body, now), event, body, now);
  if (next !== prev) setBriefEntry(id, next);
  const ci = next && next.checkIn;
  if (ci && Number.isFinite(ci.endedAt) && !(prev && prev.checkIn && Number.isFinite(prev.checkIn.endedAt))) {
    logCheckIn('answered', id, ci, { name: next.name || null, tookMs: ci.endedAt - ci.sentAt });
  }
  if (event === 'Stop') refreshBriefDid(id);
}

/** #329 - artifacts a session published BEFORE the hooks were watching for them, read
 *  once from its transcript. Asynchronous and streamed (a transcript can run to tens of
 *  MB); the result is MERGED into whatever the entry holds by then, so a hook that lands
 *  mid-scan is not overwritten. Marked scanned even when nothing is found or there is no
 *  transcript, so it never runs twice for one entry. */
const _artifactScans = new Set();
function backfillBriefArtifacts(id) {
  if (_artifactScans.has(id)) return;
  _artifactScans.add(id);
  (async () => {
    const found = [];
    try {
      const tpath = (_notifyState.get(id) || {}).transcriptPath || await resolveSessionTranscriptPath(id);
      if (tpath && fs.existsSync(tpath)) {
        const rl = require('readline').createInterface({ input: fs.createReadStream(tpath, { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const line of rl) {
          const a = briefLib.artifactFromTranscriptLine(line);
          if (a) found.push(a);
        }
      }
    } catch { /* an unreadable transcript just means nothing to backfill */ }
    const e = getBriefEntry(id);
    if (e) setBriefEntry(id, { ...e, artifacts: briefLib.mergeArtifacts(e.artifacts, found), artifactsScanned: true });
  })().finally(() => _artifactScans.delete(id));
}

/** After a turn ends, its TL;DR becomes the "did" line. Read once per Stop, never on
 *  the poll; a short delay lets the final message land in the transcript first. */
function refreshBriefDid(id) {
  setTimeout(async () => {
    try {
      const tpath = (_notifyState.get(id) || {}).transcriptPath || await resolveSessionTranscriptPath(id);
      if (!tpath) return;
      // RAW summary, not the read-aloud form: this line is read, and the speech form
      // loses underscores, hyphens and backticks from identifiers (#383).
      const { raw, reply } = speechFromTranscriptPath(tpath);
      const did = briefLib.clipWords(raw, briefLib.LIMITS.did);
      const e = getBriefEntry(id);
      if (!e) return;
      const now = Date.now();
      let next = e;
      if (did && (!e.did || e.did.text !== did)) next = { ...next, did: { text: did, at: now } };
      // #526 - the same read, for a question the reply puts to the owner that no list holds. Only
      // for a session that reports (there is a board it could be missing from), and only while no
      // newer turn has begun: that turn's prompt already ended whatever the old reply asked.
      if (briefLib.reportingEnabled(e, dashboardConfig()) && !(e.turnAt > e.stoppedAt)) {
        next = briefLib.applyPossibleAsk(next, reply, now);
      }
      if (next !== e) setBriefEntry(id, next);
    } catch { /* a missing or unreadable transcript leaves the last "did" in place */ }
  }, 1500);
}

/** What the dashboard asks of THIS hook: a context note on UserPromptSubmit, or a block
 *  on a Stop whose report the hooks have proved wrong. */
function dashboardHookAnswer(id, event, body) {
  if (event !== 'UserPromptSubmit' && event !== 'Stop') return {};
  const e = getBriefEntry(id);
  if (!e || !briefLib.reportingEnabled(e, dashboardConfig())) return {};
  if (event === 'Stop') {
    const now = Date.now();
    const origin = originForCwd(e.cwd);
    const reason = briefLib.stopBlockReason(e, body, now, REPORT_COMMAND, origin);
    if (!reason) return {};
    const missed = briefLib.unreportedTouches(e, origin);
    const evidence = missed.length ? Math.max(...missed.map((t) => t.at || 0)) : 0;
    setBriefEntry(id, { ...e, lastBlockAt: now, lastBlockEvidence: evidence });
    return { block: reason };
  }
  return { context: briefLib.instructionText(e, REPORT_COMMAND, originForCwd(e.cwd)) };
}

/** The JSON a hook route answers with. Claude reads `hookSpecificOutput` and `decision`
 *  from an http hook's body exactly as from a command hook's stdout (measured:
 *  scripts/rig/probe-http-hook-output.js); the `ok`/`status` keys beside them void nothing. */
//
// `honoured`: does THIS caller act on the answer? Claude's http hooks (/api/hook, what
// scripts/install-hooks.js installs) do. The legacy command hook (claude-hook.js, posting
// to /api/session/:id/hook) is fire-and-forget: it never relays the body, so a block
// there would be swallowed - Claude stops anyway, and the worker, never told, leaves the
// dot amber until the 5-minute stale clock. So that route gets neither a block nor a note.
async function answerHook(id, event, claudeSessionId, body, honoured) {
  if (!_HOOK_UUID_RE.test(String(id))) throw new Error('session not found');
  noteAgentSession(id, claudeSessionId); // #425 - lets a cost line name the session (only a validated id)
  // A blocked Stop is NOT a stop: Claude carries on, so the worker must not see it — it
  // would flip the dot to idle and fire an idle push mid-turn. The Stop that follows
  // (stop_hook_active) is never blocked, and is forwarded as usual.
  const pre = honoured && event === 'Stop' ? dashboardHookAnswer(id, event, body) : {};
  if (pre.block) return { ok: true, decision: 'block', reason: pre.block };
  const statusBefore = await composerStatusBefore(id); // #479 - before this hook moves it
  const result = await processHookEvent(id, event, claudeSessionId, body);
  try { foldBriefHook(id, event, body); } catch (e) { console.error(`brief fold failed: ${e.message}`); }
  try { maintNoteHook(id, event, body); } catch (e) { console.error(`maintenance fold failed: ${e.message}`); }
  noteComposerHook(id, event, body, statusBefore); // #479 - a submit ends a picker, a Stop a just-sent CR
  const post = honoured && event === 'UserPromptSubmit' ? dashboardHookAnswer(id, event, body) : {};
  return {
    ok: true, status: result.status,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.deferred ? { deferred: result.deferred } : {}),
    ...(post.context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: post.context } } : {}),
  };
}

// The AGENT reports its work items (scripts/wt-report.js). Hook token ONLY: "it came
// from localhost" proves nothing behind tailscale serve (#297), and this route writes.
app.post('/api/session/:id/report', express.json({ limit: '32kb' }), async (req, res) => {
  if (!verifyHookToken(req.headers['x-wt-hook-token'])) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  let s;
  try { s = await workerClient.rpc('getSession', { id }); } catch { return res.status(404).json({ error: 'session not found' }); }
  const v = briefLib.validateReport(req.body, getBriefEntry(id));
  if (v.error) return res.status(400).json({ error: v.error });
  // #466 - a "lead" target needs a lead, and no session waits on itself.
  const tErr = waitTargetLib.targetRefusal(v.report.wait && v.report.wait.target,
    { selfId: id, parentId: (spawnStore.field(id) || {}).parentId || null });
  if (tErr) return res.status(400).json({ error: tErr });
  const prev = getBriefEntry(id);
  // #467 - a bare "#123" names an issue in THIS session's repo, which only this server knows.
  if (v.report.wait && v.report.wait.target) {
    const origin = originForCwd((prev && prev.cwd) || (s && s.cwd) || null);
    v.report.wait.target = waitTargetLib.qualifyTarget(v.report.wait.target, (ref) => briefLib.globalKey(ref, origin));
  }
  const entry = briefLib.applyReport(prev, v.report, Date.now());
  // #413 - the work-item log names the session; a session no list has shaped yet has no name.
  if (!entry.name && s && s.name) entry.name = s.name;
  setBriefEntry(id, entry);
  if (!v.report.partial) workItemsReported(id, prev && prev.reported && prev.reported.items, entry);
  res.json({ ok: true, brief: briefLib.buildBrief(entry, {
    reporting: briefLib.reportingEnabled(entry, dashboardConfig()), origin: originForCwd(entry.cwd) }) });
});

// #469 - the close-out answer (scripts/wt-closeout.js), as STATE: clean, or blocked with what
// is left (lib/closeout.js). Hook token ONLY, like the report beside it: a clean answer lets the
// supervisor close a session an agent opened.
app.post('/api/session/:id/closeout', express.json({ limit: '4kb' }), async (req, res) => {
  if (!verifyHookToken(req.headers['x-wt-hook-token'])) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  try { await workerClient.rpc('getSession', { id }); } catch { return res.status(404).json({ error: 'session not found' }); }
  const prev = getBriefEntry(id) || briefLib.emptyEntry();
  const v = closeoutLib.answerOf(req.body, prev.reported && prev.reported.wait, id);
  if (v.error) return res.status(400).json({ error: v.error });
  const closeout = closeoutLib.applyAnswer(prev.closeout, v.answer, Date.now());
  setBriefEntry(id, { ...prev, closeout });
  supervisorLog({ event: 'closeout-answer', id, state: closeout.state, ...(closeout.left ? { left: closeout.left } : {}), ...(closeout.owner ? { pr: closeout.pr, owner: closeout.owner } : {}) });
  res.json({ ok: true, closeout: closeoutLib.recordOf(closeout) });
});

// --- #340 Hand a long session off to a fresh one -------------------------------------
// Every RULE is in lib/handoff.js; this is the I/O. The run is persisted on the OLD
// session's brief entry, so a hot reload picks it up again from the ticker below. Like
// the brief it lives in server.js only: no worker change, no cold restart.
//   wrapping   the wrap-up prompt was typed; waiting for scripts/wt-handoff.js
//   spawning   creating the successor, then waiting for its composer (#147)
//   verifying  its first prompt was typed; waiting for its UserPromptSubmit hook
//   closing    kill the old session - only on a clean verdict, else `kept`
// Every failure leaves the old session open. A successor that was created stays open too.
const HANDOFF_DIR = process.env.WT_HANDOFF_DIR || path.join(__dirname, 'handoffs');
const HANDOFF_SCRIPT = path.join(__dirname, 'scripts', 'wt-handoff.js');
const MAINT_SCRIPT = path.join(__dirname, 'scripts', 'wt-maintenance.js'); // #407 - the command a session answers the restart question with
const CLOSEOUT_CLI = path.join(__dirname, 'scripts', 'wt-closeout.js').split(path.sep).join('/'); // #469 - the close-out answer
const _handoffBusy = new Set(); // ids whose run is being advanced right now
// #345 - one line per start and per outcome (lib/handoff.js logRecord), so automatic
// hand-offs can be judged afterwards. Hand-offs are rare: no rotation.
const HANDOFF_LOG = path.join(HANDOFF_DIR, 'handoff-log.jsonl');
// #425 - the sessions the automatic scan looked at and did NOT hand off, and why. A SIBLING file:
// handoff-log.jsonl holds only started/outcome events, and a reader of it must not meet a new kind.
const HANDOFF_SKIPS_FILE = process.env.WT_HANDOFF_SKIPS_FILE || path.join(HANDOFF_DIR, 'handoff-skips.jsonl');
const _skipLogged = new Map(); // session id -> { reason, at } of the last line written

function handoffCfg() { return handoffLib.handoffConfig(liveConfig('handoff', null)); }

/** Brief files are the successor's to read, so they are not removed at close; anything
 *  older than BRIEF_TTL_MS is (lib/handoff.js). Run when a hand-off starts - rare. */
function pruneHandoffBriefs() {
  try {
    for (const f of fs.readdirSync(HANDOFF_DIR)) {
      if (!/^handoff-[0-9a-f-]+\.md$/i.test(f)) continue;
      const p = path.join(HANDOFF_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > handoffLib.BRIEF_TTL_MS) fs.unlinkSync(p);
    }
  } catch { /* best effort */ }
}

function logHandoff(event, id, run, extra) {
  const e = getBriefEntry(id) || {};
  const line = handoffLib.logRecord(event, id, run, Date.now(), { name: e.name || null, ...(extra || {}) });
  try {
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    fs.appendFileSync(HANDOFF_LOG, `${JSON.stringify(line)}\n`);
  } catch (err) { console.error(`[handoff] log write failed: ${err.message}`); }
}

function setHandoffRun(id, run) {
  const prev = (getBriefEntry(id) || {}).handoff;
  setBriefEntry(id, { ...(getBriefEntry(id) || briefLib.emptyEntry()), handoff: run });
  // Every kept/failed ending is written through here, so this is where it is logged.
  if (run && handoffLib.TERMINAL_STATES.includes(run.state) && !(prev && prev.state === run.state)) {
    logHandoff(run.state, id, run);
  }
}

/** Write [next] only if the stored run is still [expected] - same run, same state. Every
 *  ticker write goes through this: the ticker awaits the worker between reading a run
 *  and writing the next one, and a person's Cancel (or a new run) landing in that gap
 *  must win. A stale write would resurrect a cancelled run and go on to kill a session. */
function swapHandoffRun(id, expected, next) {
  if (!handoffLib.sameRun((getBriefEntry(id) || {}).handoff, expected)) return false;
  setHandoffRun(id, next);
  return true;
}

/** Type a ONE-LINE prompt exactly as a compose submit does (#55): one frame, text + CR.
 *  The worker owns the rest - the CR gap, and bracketing a long body for Claude (#213). */
const _successorDraftLogged = new Set(); // #479 - sendSuccessorPrompt's held successors
function typePrompt(id, text) {
  // #479 - never on top of a person's unsent draft: the CR would submit their words with ours.
  // Every caller asks first (composerHasDraft) and names the refusal; this is the backstop.
  if (composerHasDraft(id)) return false;
  // #443 - false when the worker link is down and nothing was written.
  if (workerClient.sendPtyIn(id, Buffer.from(`${String(text).replace(/[\r\n]+/g, ' ')}\r`, 'utf8')) === false) return false;
  noteComposerServerSubmit(id); // #479 - an interrupt before its Stop may put it back
  return true;
}

/** The row the candidate rule reads for ONE session: the fields both shapers publish,
 *  built by the same helpers, so a POST can never accept what the board did not offer.
 *  #443's check-in scan reads this same row, for the same reason. */
async function handoffRowFor(id, sessions = null) {
  const s = await workerClient.rpc('getSession', { id });
  const metrics = await sessionMetrics(s).catch(() => null);
  // Not a third shaper (tests/session-brief-routes.spec.js and waiting-for.spec.js count
  // those): one row, for one rule, so its fields are built as locals rather than spelled
  // like a shaper's. It carries every input handoffCandidate and sessionReason read.
  const brief = sessionBriefField(s);
  const waitingFor = sessionWaitingFor(s);
  const row = {
    ...s, metrics, brief, waitingFor,
    usageLimit: usageLimitFields(s.id, metrics, s),
    backgroundTasks: await sessionRunningWork(s).catch(() => []),
    spawn: spawnStore.field(s.id),
    // #470 - the agent gone from the PTY: the gated prompt never types into the shell left.
    agentGone: sessionAgentGone(s),
  };
  // #443 - its child sessions (any depth), with the fields addChildWork reads, so a live
  // child keeps this row's self-wait alive exactly as it does on the board.
  const family = [row, ...await handoffDescendantRows(s.id, sessions)];
  addSessionReasons(family);
  // #456 - each DIRECT child, live or not (the same verdict), and when its latest turn
  // ended: the check-in asks a lead whose children have all stopped. Internal to this row.
  row.childSessions = childVerdicts(family, s.id).map(({ row: k, live }) => ({
    id: k.id, live, endedAt: handoffLib.turnEndedAt(getBriefEntry(k.id) || {}) }));
  return row;
}

/** #443 - the local sessions descended from [id] (#374 spawn.parentId, any depth), each with
 *  the fields lib/background-tasks.js addChildWork reads. [] when it has none. [list] is a
 *  listSessions snapshot to walk (the check-in passes the one its liveness walk read). */
async function handoffDescendantRows(id, list = null) {
  const sessions = list || (await workerClient.rpc('listSessions')).sessions;
  const parentOf = new Map(sessions.map((x) => [x.id, (spawnStore.field(x.id) || {}).parentId || null]));
  const out = [];
  const seen = new Set([id]);
  let frontier = [id];
  while (frontier.length) {
    const next = sessions.filter((x) => !seen.has(x.id) && frontier.includes(parentOf.get(x.id)));
    for (const x of next) seen.add(x.id);
    frontier = next.map((x) => x.id);
    for (const x of next) {
      const metrics = await sessionMetrics(x).catch(() => null);
      out.push({
        ...x, usageLimit: usageLimitFields(x.id, metrics, x),
        backgroundTasks: await sessionRunningWork(x).catch(() => []),
        spawn: spawnStore.field(x.id),
      });
    }
  }
  return out;
}

async function advanceHandoff(id) {
  if (_handoffBusy.has(id)) return;
  _handoffBusy.add(id);
  try { await _advanceHandoff(id); } catch (e) {
    console.error(`[handoff] ${id}: ${e.message}`);
  } finally { _handoffBusy.delete(id); }
}

async function _advanceHandoff(id) {
  const e = getBriefEntry(id);
  const run = e && e.handoff;
  if (!handoffLib.isActive(run)) return;
  const late = handoffLib.overrun(run, Date.now(), handoffCfg());
  if (late) {
    if (swapHandoffRun(id, run, handoffLib.fail(run, late, Date.now()))) {
      console.log(`[handoff] ${id}: ${run.state} gave up (${late}); the session stays open`);
    }
    return;
  }
  if (run.state === 'spawning') return spawnSuccessor(id, e, run);
  if (run.state === 'verifying') return verifySuccessor(id, run);
  if (run.state === 'closing') return closeHandedOff(id, run);
  // wrapping: nothing to do until the agent posts its verdict (or overrun says no-brief).
}

/** [sid] has just been created to take [id]'s place: the ONE record of a hand-off, whoever made
 *  it - the server's own (spawnSuccessor) or the session itself (#472, POST /api/sessions
 *  `replaces`). [entry] is [id]'s dashboard entry; [goal] a goal the successor was opened with. */
function recordHandoff(id, sid, { trigger, name, cwd, agent, entry, goal = null }) {
  // #351 - an agent-started session's successor is agent-started too (a person's, or one with
  // no verdict, passes none on), so the chain cannot launder an orphan into a "no verdict" one.
  // #374 - it replaces [id] and keeps [id]'s parent, so it is never a child of its predecessor.
  spawnStore.inherit(id, sid, goal);
  // #466 - the journal: the old session hands off, and its successor opens with its lineage.
  const sf = spawnStore.field(sid) || {};
  const at = Date.now();
  journalAppend(journalLib.handoffRecord({ id, to: sid, at, trigger }));
  journalAppend(journalLib.openedRecord({ id: sid, at, via: 'hand-off', name, cwd, agent,
    parentId: sf.parentId, goal: sf.goal, replaces: sf.replaces }));
  // It takes the old session's place: its pin and its position, and the work items a
  // person pinned on it (the agent's own report is the successor's to make).
  const rank = getFavoriteRank(id);
  if (rank !== null) setFavorite(sid, true, rank);
  if (entry && entry.pinned && entry.pinned.length) setBriefEntry(sid, { ...briefLib.emptyEntry(), cwd: entry.cwd, pinned: entry.pinned });
}

async function spawnSuccessor(id, entry, run) {
  const old = await workerClient.rpc('getSession', { id });
  if (!run.successorId) {
    const launches = (cmd) => agentsLib.commandLaunches(old.agent, cmd);
    const flags = agentsLib.handoffPolicy(old.agent);
    const grammar = agentsLib.launchGrammar(old.agent);
    const fresh = handoffLib.freshLaunchCommand(old.autoCommand, launches, flags, grammar)
      || handoffLib.freshLaunchCommand(getDefaultCommand(), launches, flags, grammar);
    if (!fresh) return swapHandoffRun(id, run, handoffLib.fail(run, 'no-launch-command', Date.now()));
    // #470 - a dead agent's replacement resumes its conversation when the transcript was sound.
    const resume = run.dead && run.resumeId ? replacementLib.resumeLaunchCommand(fresh, flags, run.resumeId) : null;
    const autoCommand = resume || fresh;
    const sid = crypto.randomUUID();
    const next = { ...run, successorId: sid, successorName: handoffLib.successorName(old.name), ...(run.dead ? { resumed: Boolean(resume) } : {}) };
    // Recorded BEFORE the create: a reload mid-create must never start a second successor.
    // And only if the run is still this one - a Cancel during the awaits above wins.
    if (!swapHandoffRun(id, run, next)) return;
    try {
      await workerClient.rpc('createSession', { id: sid, cwd: old.cwd, name: next.successorName, autoCommand, agent: old.agent });
    } catch (err) {
      console.error(`[handoff] ${id}: successor create failed: ${err.message}`);
      return swapHandoffRun(id, next, handoffLib.fail(next, 'successor-create-failed', Date.now()));
    }
    invalidateClusterSessionsCache();
    recordHandoff(id, sid, { trigger: run.trigger, name: next.successorName, cwd: old.cwd, agent: old.agent, entry });
    console.log(`[handoff] ${id}: successor ${sid} created`);
    return; // its composer is checked on the next tick; overrun() bounds the wait
  }
  let succ;
  try { succ = await workerClient.rpc('getSession', { id: run.successorId }); } catch (err) {
    if (!/not found/i.test(err.message)) throw err; // a stalled worker is retried, not a verdict
    return swapHandoffRun(id, run, handoffLib.fail(run, 'successor-gone', Date.now()));
  }
  if (succ.agentReady === false) return;
  const now = Date.now();
  // #470 - a dead agent's successor is told whose brief it reads (the supervisor's) and whether
  // it resumed the conversation.
  const prompt = run.dead ? replacementLib.replacementPrompt({ briefFile: run.briefFile, oldName: old.name, resumed: run.resumed === true })
    : handoffLib.successorPrompt({ briefFile: run.briefFile, oldName: old.name });
  if (!prompt) return swapHandoffRun(id, run, handoffLib.fail(run, 'prompt-too-long', now));
  // #479 - someone typed into the successor: the next tick tries again. Said once per run.
  if (composerHasDraft(run.successorId)) {
    if (!_successorDraftLogged.has(run.successorId)) { _successorDraftLogged.add(run.successorId); console.log(`[handoff] ${id}: successor prompt held - an unsent draft is in its composer`); }
    return;
  }
  _successorDraftLogged.delete(run.successorId);
  // Claim the transition FIRST, then type: a Cancel that already landed means no prompt.
  if (!swapHandoffRun(id, run, handoffLib.transition(run, 'verifying', now, { sentAt: now }))) return;
  typePrompt(run.successorId, prompt);
}

async function verifySuccessor(id, run) {
  const se = getBriefEntry(run.successorId);
  // Proven up = its agent STARTED A TURN after the prompt was typed (#55: submit means a
  // turn starts, never "the text is on screen").
  if (!(se && Number.isFinite(se.turnAt) && se.turnAt >= run.sentAt)) return;
  const next = handoffLib.transition(run, 'closing', Date.now());
  if (swapHandoffRun(id, run, next)) return closeHandedOff(id, next);
}

async function closeHandedOff(id, run) {
  let old;
  try { old = await workerClient.rpc('getSession', { id }); } catch (err) {
    if (/not found/i.test(err.message)) return; // already gone: sessionExited closes the entry
    throw err; // a stalled worker is retried on the next tick, never read as "gone"
  }
  // Killed only once its own turn is OVER and nobody has prompted it since the verdict
  // (lib/handoff.js closeDecision). The verdict is posted from INSIDE the wrap-up turn,
  // so "the successor is up" alone would kill it mid-turn (#191 never measured that).
  const e = getBriefEntry(id) || {};
  // #470 - a dead agent's run closes the shell it left only while the agent is still gone,
  // and keeps it when an agent runs there again. Keystrokes after the verdict keep any run.
  const st = run.dead === true ? sessionAgentState(old) : null;
  const d = handoffLib.closeDecision(run, { status: old.status, turnAt: e.turnAt, stoppedAt: e.stoppedAt,
    inputAt: _lastInputAt.get(id),
    agentGone: Boolean(st && st.state === 'gone' && st.gone && !Number.isFinite(st.gone.endedAt)),
    agentRunning: Boolean(st && st.state === 'running') }, Date.now(), handoffCfg());
  if (d.action === 'wait') return;
  if (d.action === 'keep') {
    if (swapHandoffRun(id, run, handoffLib.transition(run, 'kept', Date.now(), { reason: d.reason }))) {
      console.log(`[handoff] ${id}: successor up; kept open (${d.reason})`);
    }
    return;
  }
  // The last check before the kill, with no await between it and the kill: still this run.
  if (!handoffLib.sameRun((getBriefEntry(id) || {}).handoff, run)) return;
  console.log(`[handoff] ${id}: handed off to ${run.successorId}; closing`);
  const name = (getBriefEntry(id) || {}).name || null; // the exit drops the entry
  await workerClient.rpc('killSession', { id });
  logHandoff('closed', id, run, { name }); // after the kill: a failed RPC is retried next tick
  invalidateClusterSessionsCache();
}

/** Start a run on a session whose row [row] the rule read. The ONE start path: a
 *  person's press (POST below) and the automatic scan (#345) both come here. Nothing in
 *  it awaits, so its checks cannot be raced by a second start. Returns {run} or
 *  {status, error, why}. */
function startHandoff(id, row, { force = false, trigger = 'manual' } = {}) {
  const h = row && row.handoff;
  if (!h) return { status: 409, error: 'this session\'s agent does not support hand-off' };
  // #359 - a hand-off boots a successor, and a restart hold refuses new sessions.
  if (_maint.hold) return { status: 409, error: 'not a hand-off candidate right now (restart hold)', why: 'restart-hold' };
  // #479 - the wrap-up prompt would submit a person's unsent draft with it. Every trigger.
  if (composerHasDraft(id)) return { status: 409, error: 'not started: an unsent draft is in its composer (send or clear it first)', why: 'draft' };
  if (!h.suggest && !(force && handoffLib.FORCEABLE_GATES.includes(h.why))) {
    return { status: 409, error: `not a hand-off candidate right now (${h.why})`, why: h.why };
  }
  // The rule read the row across awaits: another start may have landed since.
  const e = getBriefEntry(id);
  if (handoffLib.isActive((e || {}).handoff)) {
    return { status: 409, error: 'not a hand-off candidate right now (in-progress)', why: 'in-progress' };
  }
  // ... and, for the scan, a Cancel or a Dismiss (lib/handoff.js autoBlock).
  if (trigger === 'auto') {
    const no = handoffLib.autoBlock(e, handoffCfg(), { now: Date.now(), inputAt: _lastInputAt.get(id), draft: composerHasDraft(id) });
    if (no) return { status: 409, error: `not started automatically (${no})`, why: no };
  }
  try { fs.mkdirSync(HANDOFF_DIR, { recursive: true }); } catch { /* the write below reports it */ }
  pruneHandoffBriefs();
  const briefFile = path.join(HANDOFF_DIR, handoffLib.briefFileName(id));
  // A brief left by an earlier attempt must not satisfy this one.
  try { fs.unlinkSync(briefFile); } catch { /* none */ }
  // #470 - the supervisor's hand-off is recorded as its own, forced or not.
  const run = handoffLib.startRun(Date.now(), briefFile, trigger === 'supervisor' ? trigger : force && !h.suggest ? 'forced' : trigger);
  setHandoffRun(id, run);
  // #443 - a refused write typed nothing: the check-in may then follow a failed run at once.
  if (!typePrompt(id, handoffLib.wrapUpPrompt({ briefFile, scriptPath: HANDOFF_SCRIPT }))) {
    swapHandoffRun(id, run, { ...run, typed: false });
  }
  console.log(`[handoff] ${id}: started ${run.trigger} (${h.ctxTokens === null ? '?' : Math.round(h.ctxTokens / 1000)}k ctx)`);
  logHandoff('started', id, run, { ctxTokens: h.ctxTokens, cwd: row.cwd || null, gate: h.why });
  return { run };
}

// #345 - hand off, without a press, any session the board would offer it for. Same rule,
// same row, same start path as the button; autoBlock adds "nobody said no" and "nobody
// is typing". The scan starts at most one run, and none while another is in flight: each
// needs a free slot and boots a second agent, and the weakest machines (XPS,
// office-tests) feel two of those. A person's press is not held to that.
let _autoScanAt = 0, _autoScanBusy = false;
/** #425 - one `skipped` line for a hand-off candidate the scan passed over. Rate-limited per
 *  session by lib/usage-log.js shouldLogSkip, so a session that stays skipped for the same
 *  reason is written once per 15 minutes, not once per scan. */
function logHandoffSkip(s, reason, source, ctxTokens) {
  const now = Date.now();
  if (!usageLog.shouldLogSkip(_skipLogged.get(s.id), reason, now)) return;
  _skipLogged.set(s.id, { reason, at: now });
  if (_skipLogged.size > 500) for (const k of _skipLogged.keys()) { _skipLogged.delete(k); if (_skipLogged.size <= 400) break; }
  const e = getBriefEntry(s.id) || {};
  usageLog.appendRecord(HANDOFF_SKIPS_FILE, usageLog.skipRecord(
    { id: s.id, name: e.name || s.name, agent: s.agent, reason, source, ctxTokens, status: s.status }, now));
}
// The last keystroke any client sent each session (#345 autoBlock 'typing'). Only the WS
// input path below writes it; the server's own typePrompt does not.
const _lastInputAt = new Map();
// --- #479 A person's unsent draft in the composer (the rule: lib/composer-draft.js) -------
// What each session's keystrokes left in its agent's input box. The text stays in this
// process's memory; WHICH sessions hold a draft (and since when) is kept on disk, written on
// each change, so a hot reload cannot forget one (it comes back UNKNOWN: still a draft).
// Every prompt the server types on its own asks composerHasDraft first and refuses 'draft';
// typePrompt refuses too, as the backstop. The keys are read here, before the worker: a
// worker-side copy would need a cold restart and buys nothing - every person's key comes
// through the WS input path.
const COMPOSER_DRAFTS_FILE = process.env.WT_COMPOSER_DRAFTS_FILE || path.join(HANDOFF_DIR, 'composer-drafts.json');
const COMPOSER_DRAFTS_MAX = 500;
const _composer = new Map(); // session id -> { st, since }
const _sessionStatus = new Map(); // session id -> its last statusChanged
(function loadComposerDrafts() {
  let j;
  try { j = JSON.parse(fs.readFileSync(COMPOSER_DRAFTS_FILE, 'utf8')); } catch { return; } // absent: none kept
  if (!j || typeof j !== 'object' || Array.isArray(j)) return;
  for (const [id, v] of Object.entries(j)) {
    const kept = composerDraft.fromKept(v);
    if (_HOOK_UUID_RE.test(id) && kept) _composer.set(id, kept);
  }
})();
function saveComposerDrafts() {
  const out = {};
  for (const [id, e] of _composer) {
    const v = composerDraft.keptValue(e.st, e.since);
    if (v !== null) out[id] = v;
  }
  const ids = Object.keys(out);
  for (const id of ids.slice(0, Math.max(0, ids.length - COMPOSER_DRAFTS_MAX))) delete out[id];
  try {
    fs.mkdirSync(path.dirname(COMPOSER_DRAFTS_FILE), { recursive: true });
    fs.writeFileSync(`${COMPOSER_DRAFTS_FILE}.tmp`, JSON.stringify(out));
    fs.renameSync(`${COMPOSER_DRAFTS_FILE}.tmp`, COMPOSER_DRAFTS_FILE);
  } catch (e) { console.error(`[composer-draft] write failed: ${e.message}`); }
}
// Does the session's agent have a composer at all? Learnt from its row when a socket attaches
// (lib/agents.js readinessMarker: the agent declares one). A plain shell has none, and no hook
// ever gives it a status, so every CR would read as a possible submit nothing ends. Not known
// (no attach read yet, a failed read) folds: a false draft is the safe side.
const _composerFolds = new Map(); // session id -> false: its agent declares no composer
// #479 gate 3 - a selector's answer fires no hook: a permission approved stays 'waiting' until
// the tool's PostToolUse, for the tool's whole run, while the composer takes text again. So
// only the FIRST frame of a waiting period goes to the selector unfolded; later ones are folded,
// a CR among them only a possible submit. A multi-key answer then reads as a draft until the
// next submit: the safe side.
const _waitAnswered = new Set(); // session ids whose current waiting period had its first frame
// #479 gate 5 - a status, and a waiting period's first frame, belong to the worker that
// reported them: a respawned session starts over, so a 'waiting' left from the old worker
// must not swallow the first frame typed after a restart. Cleared when the worker changes.
let _composerWorkerAt = null;
function syncComposerWorker() {
  const w = workerClient.workerIdentity();
  const at = w && Number.isFinite(w.startedAt) ? w.startedAt : null;
  if (at === null || at === _composerWorkerAt) return;
  if (_composerWorkerAt !== null) { _sessionStatus.clear(); _waitAnswered.clear(); }
  _composerWorkerAt = at;
}
function noteComposerStatus(id, status) {
  syncComposerWorker();
  if (_sessionStatus.get(id) !== status) _waitAnswered.delete(id);
  _sessionStatus.set(id, status);
}
// #479 gate 4 - the worker announces a status only when it CHANGES, and a new session starts
// 'active' (no hook yet), so a fresh session - and every session after a hot reload - had
// none here until a hook: its first prompt read as a possible submit nothing ended. The
// worker's row says it: seed the status from it (never over one an event already set).
async function learnComposerAgent(id) {
  try {
    const s = await workerClient.rpc('getSession', { id });
    // A shell: not seeded, so only a hook's status (an agent started by hand) folds it.
    if (agentsLib.readinessMarker(s && s.agent) === null) { _composerFolds.set(id, false); return; }
    _composerFolds.delete(id);
    syncComposerWorker();
    if (s && typeof s.status === 'string' && s.status && !_sessionStatus.has(id)) _sessionStatus.set(id, s.status);
  } catch { _composerFolds.delete(id); }
}
/** The session's status before a hook moves it: read from the worker when not known yet and
 *  a composer record could depend on it. undefined when it cannot be told. */
async function composerStatusBefore(id) {
  syncComposerWorker();
  if (!_sessionStatus.has(id) && _composer.has(id)) await learnComposerAgent(id);
  return _sessionStatus.get(id);
}
// 'active': the worker's status before any hook - a session at its composer.
const atComposer = (status) => status === 'idle' || status === 'active';
const _serverCr = new Set(); // session ids whose last CR the server typed (typePrompt), not a person
/** A frame's keys, unless the worker has restarted since they were recorded: its sessions
 *  were respawned, and the box with them (a cold restart, a reboot, a worker crash). */
function composerEntry(id) {
  const e = _composer.get(id);
  const w = workerClient.workerIdentity();
  if (e && w && Number.isFinite(w.startedAt) && e.since < w.startedAt) {
    _composer.delete(id);
    saveComposerDrafts();
    invalidateClusterSessionsCache();
    return undefined;
  }
  return e;
}
/** Fold one person's input frame into session [id]'s composer. The first frame of a waiting
 *  period goes to the selector it shows (a permission, a question), not to the composer. */
function noteComposerInput(id, text) {
  syncComposerWorker();
  const status = _sessionStatus.get(id);
  // A shell with no agent that declares a composer - unless a hook has given it a status (an
  // agent started by hand in it).
  if (_composerFolds.get(id) === false && status === undefined) return;
  if (status === 'waiting' && !_waitAnswered.has(id)) { _waitAnswered.add(id); return; }
  _serverCr.delete(id); // a person's keys since the server's last CR
  const prev = composerEntry(id);
  // No status yet (no statusChanged since this server started, e.g. after a hot reload), or
  // waiting with the selector perhaps answered: a CR may be a selector's answer, not a submit.
  setComposer(id, prev, composerDraft.applyInput(prev && prev.st, text, { idle: atComposer(status), uncertain: status === undefined || status === 'waiting' }));
}
/** A hook from session [id]'s agent. A UserPromptSubmit (or a `/clear`'s SessionStart) is
 *  the only end of a picker - but only while the session was idle: a nested `claude -p` run
 *  by one of the agent's tools inherits this session's hook variables, and its prompt arrives
 *  while the session is working. A Stop ends a just-sent CR (an interrupt can no longer put
 *  the prompt back). */
function noteComposerHook(id, event, body, statusBefore) {
  const prev = composerEntry(id);
  if (!prev) return;
  const submitted = event === 'UserPromptSubmit' || (event === 'SessionStart' && body && body.source === 'clear');
  if (submitted && atComposer(statusBefore)) setComposer(id, prev, composerDraft.applySubmitted(prev.st));
  else if (event === 'Stop') setComposer(id, prev, composerDraft.applyStopped(prev.st));
}
/** The worker saw a CR start no turn in time (#179): a person's words may still be in the box.
 *  Not for the server's own CR (the words there are ours; #359 types its question again). */
function noteComposerUnconfirmed(id) {
  if (_composerFolds.get(id) === false && _sessionStatus.get(id) === undefined) return;
  if (_serverCr.has(id)) return;
  const prev = composerEntry(id);
  setComposer(id, prev, composerDraft.applyUnconfirmed(prev && prev.st));
}
/** The server typed its own prompt + CR (typePrompt, only into a box with no draft). */
function noteComposerServerSubmit(id) {
  _serverCr.add(id);
  setComposer(id, composerEntry(id), composerDraft.applyServerSubmit());
}
function setComposer(id, prev, st) {
  const was = Boolean(prev) && composerDraft.hasDraft(prev.st);
  const is = composerDraft.hasDraft(st);
  // An empty box after a lone Esc, or after a submit, is no draft, but is kept: the next Esc
  // may open Rewind or put the prompt back.
  if (is || st.esc === true || st.justSent === true) _composer.set(id, { st, since: was ? prev.since : Date.now() }); else _composer.delete(id);
  // A picker opening or ending changes what is kept on disk, not only whether a draft is.
  const kind = (x) => JSON.stringify(x ? composerDraft.keptValue(x, 0) : null);
  if (was !== is || kind(prev && prev.st) !== kind(st)) saveComposerDrafts();
  if (was !== is) invalidateClusterSessionsCache();
}
function composerHasDraft(id) {
  const e = composerEntry(id);
  return Boolean(e) && composerDraft.hasDraft(e.st);
}
function forgetComposer(id) {
  _sessionStatus.delete(id);
  _composerFolds.delete(id);
  _waitAnswered.delete(id);
  _serverCr.delete(id);
  _successorDraftLogged.delete(id);
  _maintDraftLogged.delete(id);
  if (_composer.delete(id)) saveComposerDrafts();
}
/** The row's `composerDraft`: a draft that nobody is typing (the check-in's quiet period),
 *  so the owner can be told one is waiting. null while a person is at it, or none. */
function composerDraftField(id) {
  const e = composerEntry(id);
  if (!e || !composerDraft.hasDraft(e.st)) return null;
  if (checkInLib.typedRecently(_lastInputAt.get(id), CHECKIN_STARTED_AT, Date.now(), checkInCfg().typingQuietMin)) return null;
  // `release`: what ends the hold. A picker (a slash command, Rewind, a key not followed)
  // ends only when Claude reports a prompt sent; anything else also on an idle Ctrl-C.
  return { since: e.since, release: e.st.picker === true ? 'send' : 'send-or-clear' };
}
/** #345 - one hand-off at a time: a run in flight (wrapping..closing) on any session of this server. The
 *  hand-off scan and the check-in scan's hand-off-instead (#540 layer 3) both wait on it. */
function handoffRunActive() {
  return Object.values(briefStore().sessions).some((e) => e && handoffLib.isActive(e.handoff));
}
async function autoHandoffScan() {
  const cfg = handoffCfg();
  if (!cfg.enabled || !cfg.auto || _autoScanBusy || _checkInBusy || Date.now() - _autoScanAt < cfg.autoEveryMs) return; // #443 - never inside a check-in scan's read-then-type
  if (_maint.hold) return; // #359
  if (handoffRunActive()) return;
  _autoScanBusy = true; _autoScanAt = Date.now();
  try {
    const { sessions } = await workerClient.rpc('listSessions');
    for (const s of sessions) {
      // Cheap pre-checks from the list; the full rule decides on the row below.
      if (!agentsLib.handsOff(s.agent)) continue;
      // #525 - the supervisor's dispatcher is replaced its own way (dispatcherRecycle): a hand-off
      // run that fails or is kept would leave a dispatcher that no case can be typed into.
      if (isDispatcherSession(s.id)) continue;
      if (s.status !== 'idle') { logHandoffSkip(s, 'not-idle', 'scan'); continue; }
      if (checkInInFlight(s.id)) { logHandoffSkip(s, 'check-in', 'scan'); continue; } // #443
      const blocked = handoffLib.autoBlock(getBriefEntry(s.id), cfg, { now: Date.now(), inputAt: _lastInputAt.get(s.id), draft: composerHasDraft(s.id) });
      if (blocked) { logHandoffSkip(s, blocked, 'autoBlock'); continue; }
      let row;
      try { row = await handoffRowFor(s.id); } catch { continue; }
      if (!(row.handoff && row.handoff.suggest)) {
        // #425 - the reason is the one handoffCandidate named, not a re-derivation.
        logHandoffSkip(s, row.handoff ? row.handoff.why : 'no-handoff-field', 'handoffCandidate', row.handoff && row.handoff.ctxTokens);
        continue;
      }
      const started = startHandoff(s.id, row, { trigger: 'auto' });
      if (started.run) break; // one at a time
      logHandoffSkip(s, started.why || 'start-refused', 'startHandoff', row.handoff.ctxTokens);
    }
  } catch (err) {
    console.error(`[handoff] auto scan: ${err.message}`);
  } finally { _autoScanBusy = false; }
}

// --- #443 Check in on an idle session that may have lost its wake-up (#456, #458) -----
// Every RULE is in lib/check-in.js; this is the I/O. The record lives on the session's
// brief entry (so it survives a hot reload) and the answer is folded in from its hooks
// (foldBriefHook). Server-only, like the hand-off: no worker change, no cold restart.
// handoffs/check-in-log.jsonl gets one line per check-in sent and per answer.
const CHECKIN_LOG = path.join(HANDOFF_DIR, 'check-in-log.jsonl');
function checkInCfg() { return checkInLib.checkInConfig(liveConfig('checkIn', null)); }
/** Typed into [id] but not yet started as a turn: the other writers (the hand-off scan,
 *  the restart hold) wait, or their prompt would land right behind it. */
function checkInInFlight(id) {
  return checkInLib.inFlight((getBriefEntry(id) || {}).checkIn, Date.now(), checkInCfg());
}
function logCheckIn(event, id, rec, extra) {
  const line = checkInLib.logRecord(event, id, rec, Date.now(), extra);
  try {
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    fs.appendFileSync(CHECKIN_LOG, `${JSON.stringify(line)}\n`);
  } catch (err) { console.error(`[check-in] log write failed: ${err.message}`); }
}
// --- #540 Wake only what needs waking -------------------------------------------------
// Measured over 14 days (handoffs/check-in-log.jsonl): about 120 of ~170 check-ins got back the wait the
// session had already reported, and each one on a session idle an hour re-writes its whole context as
// cache (~130-200k tokens). Three layers, cheapest first, every RULE in lib/check-in.js and
// lib/check-in-precheck.js (docs/findings/agents-codex.md #540):
//   1. no repeat without a change (checkInBlock 'unchanged', the baseline below);
//   2. a small model reads the tail first and says skip / tell / wake (checkInPrecheckFor);
//   3. a wake of a big session that has been idle an hour starts the existing hand-off instead.
// Every decision goes to the usage ledger with the session's context size (ledgerCheckIn).
// Config `checkInPrecheck` ({enabled, model, command, timeoutMs}) is NOT in ALLOWED_CONFIG_KEYS:
// `command` is something this server EXECUTES (the inbox digest's and the Analyst's rule). The
// model is the registry's cheap tier for the session's agent (lib/agents.js cheapModel) unless
// `model` names another.
function checkInPrecheckConfig() {
  const live = liveConfig('checkInPrecheck', {});
  const c = live && typeof live === 'object' && !Array.isArray(live) ? { ...live } : {};
  // Test seams, under WT_TEST only: the suite points the runner at a fake CLI.
  if (process.env.WT_TEST === '1' && process.env.WT_CHECKIN_PRECHECK_COMMAND) {
    try { c.command = JSON.parse(process.env.WT_CHECKIN_PRECHECK_COMMAND); } catch { /* ignore a bad override */ }
  }
  if (process.env.WT_TEST === '1' && process.env.WT_CHECKIN_PRECHECK_TIMEOUT_MS) c.timeoutMs = Number(process.env.WT_CHECKIN_PRECHECK_TIMEOUT_MS);
  // A suite that names no fake CLI must never reach the real model: the pre-check is off there.
  if (process.env.WT_TEST === '1' && !process.env.WT_CHECKIN_PRECHECK_COMMAND) c.enabled = false;
  return c;
}
const checkInPrecheckService = checkInPrecheck.createPrecheckService({
  getConfig: checkInPrecheckConfig,
  scratchDir: () => { fs.mkdirSync(SCRATCH_DIRS.precheck, { recursive: true }); return SCRATCH_DIRS.precheck; },
});
// The usage ledger claude-memory's usage-monitor.js appends its windows to: one JSON object per
// line with `at` and `machine`. Under WT_TEST nothing is written unless a spec names a file.
const USAGE_LEDGER_FILE = process.env.WT_USAGE_LEDGER_FILE || null;
function usageLedgerFile() {
  return USAGE_LEDGER_FILE || (process.env.WT_TEST === '1' ? null : path.join(transcriptHome(), '.claude', 'usage-ledger.jsonl'));
}
function ledgerCheckIn(decision, by, s, fields) {
  usageLog.appendRecord(usageLedgerFile(), checkInLib.ledgerRecord({ now: Date.now(), machine: getServerName(), id: s.id, decision, by, ...fields }));
}
const _ledgerOnce = new Set(); // `id\0sentAt`: one ledger line per answered check-in the rule held back
/** The tracker's and the CI's own state of the session's items and their open PRs, as two strings - the `t`
 *  and `c` parts of lib/check-in.js changeSignature. The tracker CACHE first (fresh for 10 minutes, one refresh
 *  behind a stale copy: lib/tracker-meta.js); read only for a session whose check-in was answered, a handful a
 *  day. '' when it names no tracked item (or no open PR). A part whose read FAILED is null, never a string a
 *  later look could differ from: a timeout, a 401 or a PR list that could not be read is not a change. */
async function checkInWorld(row) {
  const items = row && row.brief && Array.isArray(row.brief.items) ? row.brief.items : [];
  const refs = [];
  for (const it of items.slice(0, 8)) {
    const r = it && typeof it.key === 'string' ? trackerMeta.parseRef(it.key) : null;
    if (r && !r.unqualified && !refs.some((x) => x.key === r.key)) refs.push(r);
  }
  if (!refs.length) return { tracker: '', ci: '' };
  let metas;
  try { metas = await mcTrackerMeta.getMany(refs); } catch { return { tracker: null, ci: null }; }
  const unread = metas.some((m) => m.error || m.fetchedAt === null || /could not be read/i.test(m.warning || ''));
  return { tracker: unread ? null : metas.map(checkInTrackerPart).join(';'), ci: await checkInCiSig(metas) };
}
const checkInTrackerPart = (m) => [m.key, m.state || '', m.closed === null || m.closed === undefined ? '' : m.closed,
  (m.prs || []).map((p) => `${p.repo}#${p.number}:${p.state || ''}`).join(',')].join('|');
/** The CI state of the open PRs among [metas] (the items' linked PRs, and an item that is itself an open
 *  PR), through the one reader of CI the server has: the supervisor's lookup of a `ci` wait target and
 *  lib/wait-target.js fromLookup, with its cache (a lookup is shared with a wait on the same PR). The source
 *  APIs of the tracker cache do not carry check state. null when any lookup failed. */
async function checkInCiSig(metas) {
  const targets = checkInLib.ciTargets(metas);
  if (!targets.length) return '';
  const cfg = supervisorCfg();
  const parts = [];
  for (const t of targets) {
    const lk = waitTargetLib.lookupKey(t);
    let c = _sup.lookups[lk];
    if (!c || Date.now() - c.at >= cfg.resolveEveryMs) { c = { at: Date.now(), ...(await supervisorLookup(t, cfg)) }; _sup.lookups[lk] = c; }
    const part = checkInLib.ciPart(t, c);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join(';');
}
/** #540 layer 2 - what the pre-check says about [s] (null: not asked - no cheap model declared by its
 *  agent, an off switch, or nothing readable). A failure is `{ok:false, reason}` and means "wake". */
async function checkInPrecheckFor(s, row, { why, idleMin, record, world }) {
  const model = agentsLib.cheapModel(s.agent);
  if (!model || !checkInPrecheck.askable(why) || !checkInPrecheckService.enabled()) return null;
  let turns = [];
  try {
    const tpath = await resolveSessionTranscriptPath(s.id);
    if (tpath) turns = digestWaits.get(tpath).turns || [];
  } catch { turns = []; }
  if (!turns.length) return { ok: false, reason: 'no-turns', noModel: true }; // no model ran: it holds no slot of the scan's three
  const b = row.brief || {};
  const kids = Array.isArray(row.childSessions) ? row.childSessions : [];
  const state = {
    name: (getBriefEntry(s.id) || {}).name || s.name, why, idleMin, wait: b.wait, headline: b.headline, items: b.items,
    work: (Array.isArray(row.backgroundTasks) ? row.backgroundTasks : []).filter((t) => t && !t.stale).map((t) => t.description || t.kind || 'task'),
    children: { live: kids.filter((k) => k.live).length, parked: kids.filter((k) => !k.live).length },
    asked: record && record.answer ? [{ n: checkInLib.askCount(record), on: record.answer.on, what: record.answer.what }] : [],
  };
  const r = await checkInPrecheckService.run(checkInPrecheck.buildPrompt({ state, turns }), model);
  // The world is read only for a verdict that records a baseline (skip, tell): a wake is typed. Here, before the
  // scan's read-then-type section, so the tracker and CI reads never sit inside it.
  if (r.ok && r.verdict !== 'wake') r.world = world || await checkInWorld(row);
  return r;
}
/** #540 layer 1 - the clock allowed another check-in and the world has not moved since the answer:
 *  noted as compared (the next look is changeCheckMin later) and, once per answered check-in, in
 *  the ledger as a check-in that was not asked. */
function noteCheckInUnchanged(s, row, why, ctxTokens) {
  const e = getBriefEntry(s.id);
  const rec = e && e.checkIn;
  if (!rec) return;
  const now = Date.now();
  setBriefEntry(s.id, { ...e, checkIn: checkInLib.withChecked(rec, now) });
  const key = `${s.id}\u0000${rec.sentAt}`;
  if (_ledgerOnce.has(key)) return;
  _ledgerOnce.add(key);
  if (_ledgerOnce.size > 500) for (const k of _ledgerOnce) { _ledgerOnce.delete(k); if (_ledgerOnce.size <= 400) break; }
  ledgerCheckIn('skipped', 'rule', s, { why, n: checkInLib.askCount(rec) + 1, idleMin: (now - checkInLib.idleSince(row, why)) / 60000,
    ctxTokens, reason: 'unchanged since the last answer', changed: [] });
}
// #463 - why a session the cheap pre-check let through was NOT asked: one line when the gate
// changes, else at most one per SKIP_REPEAT_MS (lib/usage-log.js, the hand-off skips' rule).
const CHECKIN_SKIPS_FILE = process.env.WT_CHECKIN_SKIPS_FILE || path.join(HANDOFF_DIR, 'check-in-skips.jsonl');
const _checkInSkipLogged = new Map();
function logCheckInSkip(s, reason, source) {
  if (!checkInLib.skipWorthLogging(reason)) return;
  const now = Date.now();
  if (!usageLog.shouldLogSkip(_checkInSkipLogged.get(s.id), reason, now)) return;
  _checkInSkipLogged.set(s.id, { reason, at: now });
  if (_checkInSkipLogged.size > 500) for (const k of _checkInSkipLogged.keys()) { _checkInSkipLogged.delete(k); if (_checkInSkipLogged.size <= 400) break; }
  const e = getBriefEntry(s.id) || {};
  usageLog.appendRecord(CHECKIN_SKIPS_FILE, usageLog.skipRecord(
    { id: s.id, name: e.name || s.name, agent: s.agent, reason, source, status: s.status }, now));
}
// _checkInScanning: a scan is running (its own re-entrancy guard, held across the model call). _checkInBusy: the
// scan is inside its read-then-type section - the flag the hand-off scan and the gated prompt route (safe-prompt
// `busy`) refuse on, so it is held only there, never across a pre-check (up to 60 s each) or a tracker read.
let _checkInScanAt = 0, _checkInBusy = false, _checkInScanning = false;
// Keystrokes are remembered in memory only (_lastInputAt): the typing gate counts from here
// at least, so a draft typed just before a reload is never submitted with a check-in.
const CHECKIN_STARTED_AT = Date.now();
/** Can the live-work reading be trusted for [s]? The row's readers turn a failure into
 *  "nothing running" (right for a badge, wrong before a write): a transcript that cannot be
 *  found or read, or no process snapshot yet, is "cannot tell", and the check-in refuses.
 *  Read FIRST, so the row's read that follows is served from the same cached scan. */
async function checkInLiveKnown(s, sessions) {
  // Its children (any depth) too: a child's own work keeps the parent's wait alive
  // (addChildWork), and handoffDescendantRows reads it with the same "failure = none".
  const parentOf = new Map(sessions.map((x) => [x.id, (spawnStore.field(x.id) || {}).parentId || null]));
  const seen = new Set([s.id]);
  let frontier = [s.id];
  const all = [s];
  while (frontier.length) {
    const next = sessions.filter((x) => !seen.has(x.id) && frontier.includes(parentOf.get(x.id)));
    for (const x of next) { seen.add(x.id); all.push(x); }
    frontier = next.map((x) => x.id);
  }
  // A child that never got a hook cannot reach here as a blocker: it stays `active` (the
  // worker idles only on a hook), which addChildWork counts as live work - not stale.
  for (const x of all) if (!(await liveKnownOne(x))) return false;
  return true;
}
async function liveKnownOne(s) {
  if (agentsLib.hasBackgroundTasksInTranscript(s.agent)) {
    const tpath = await resolveSessionTranscriptPath(s.id).catch(() => null);
    if (!tpath) return false;
    try { await readBackgroundTasks(s); } catch { return false; }
  }
  if (process.platform === 'win32' && Number.isFinite(s.pid)) {
    try { if (!processTree.snapshotNoWait()) return false; } catch { return false; }
  }
  return true;
}
/** Type ONE check-in per scan, into the first session the rule allows. Reads the same row
 *  the hand-off rule reads (handoffRowFor), then re-reads the session immediately before
 *  typing, so a turn, a question or a menu that came up during the awaits is never typed
 *  into (the restart hold's #410 lesson). Nothing is recorded until the prompt is typed:
 *  a "not now" is retried by the next scan, never consumed. */
async function checkInScan() {
  const cfg = checkInCfg();
  // Never beside the hand-off scan: each reads a row across awaits and then types, and
  // the two must never both type into one session. Each sets its flag before its first await.
  if (!cfg.enabled || _checkInScanning || _autoScanBusy || Date.now() - _checkInScanAt < cfg.everyMs) return;
  if (_maint.hold) return; // #359 - the hold types its own question
  _checkInScanning = true; _checkInScanAt = Date.now();
  let prechecks = 0; // #540 - model runs this scan: a fleet back from an outage is read a few at a time
  try {
    const hcfg = handoffCfg();
    // #456 - children: the row's direct child sessions, live or parked (handoffRowFor).
    const opts = (id, liveKnown, children) => ({ now: Date.now(), cfg, hcfg, supported: true, inputAt: _lastInputAt.get(id),
      startedAt: CHECKIN_STARTED_AT, hold: Boolean(_maint.hold), liveKnown, children, draft: composerHasDraft(id) });
    const { sessions } = await workerClient.rpc('listSessions');
    for (const s of sessions) {
      _checkInBusy = false; // the previous session's read-then-type section (below) ended with its `continue`
      // Cheap pre-checks from the list and the raw brief; the full rule decides on the row below.
      if (!agentsLib.checksIn(s.agent) || s.status !== 'idle') continue;
      // #475 - the supervisor's dispatcher is the fleet's supervisor, not one of its sessions: the server
      // types its cases into it and replaces it (#525), so a check-in is never asked of it.
      if (isDispatcherSession(s.id)) continue;
      if (!checkInLib.worthReading(getBriefEntry(s.id), { now: Date.now(), cfg, hcfg, listed: s })) continue;
      // One snapshot for both: a child the row counts is a child the walk read.
      const liveKnown = await checkInLiveKnown(s, sessions);
      let row;
      try { row = await handoffRowFor(s.id, sessions); } catch { continue; }
      // #540 layer 1 - an answered check-in is compared with the world its answer left. The first look
      // after the answer RECORDS that world (the baseline) and asks nothing; a later look finds
      // 'unchanged' unless the wait, its items, its running work, its children or its tracker moved.
      const prior = getBriefEntry(s.id);
      const answered = prior && prior.checkIn && checkInLib.periodOpen(prior.checkIn, prior.turnAt) ? prior.checkIn : null;
      const world = answered ? await checkInWorld(row) : undefined; // { tracker, ci }: null parts = a failed read
      const sigNow = () => checkInLib.changeSignature(row, { children: row.childSessions, ...world, now: Date.now() });
      const noteBase = (note) => { // the record's baseline: written once, a part that could not be read filled in later
        const cur0 = getBriefEntry(s.id);
        if (liveKnown && cur0 && cur0.checkIn === answered) {
          const next = note(answered, sigNow());
          if (next !== answered) setBriefEntry(s.id, { ...cur0, checkIn: next });
        }
      };
      if (answered && checkInLib.needsBaseline(answered, cfg, Date.now())) {
        noteBase(checkInLib.withBaseline);
        continue;
      }
      if (answered) noteBase(checkInLib.fillBaseline);
      const o = { ...opts(s.id, liveKnown, row.childSessions), ...world };
      const no = checkInLib.checkInBlock(row, o);
      if (no) {
        if (no === 'unchanged') noteCheckInUnchanged(s, row, (answered && answered.why) || 'stale-self', checkInLib.ctxTokensOf(row));
        logCheckInSkip(s, no, 'row');
        continue;
      }
      // #540 layer 2 - a small model reads the tail before a check-in is typed. Awaited HERE, before
      // the re-read below, so everything that follows is judged on the session as it is after it.
      const why0 = checkInLib.checkInReading(row, { ...o, now: Date.now() }) || 'stale-self';
      const idle0 = (Date.now() - checkInLib.idleSince(row, why0)) / 60000;
      if (prechecks >= 3 && agentsLib.cheapModel(s.agent) && checkInPrecheck.askable(why0)) break;
      // #540 layer 3 waits its turn like the hand-off scan (one run at a time): a session that a wake would hand off
      // is deferred - not typed, not asked of the model again every minute - until the run in flight has ended.
      if (handoffRunActive() && checkInLib.handoffInstead({ verdict: 'wake', why: why0, idleMin: idle0, handoff: row.handoff, cfg })) {
        logCheckInSkip(s, 'handoff-busy', 'handoff-instead');
        continue;
      }
      const pre = await checkInPrecheckFor(s, row, { why: why0, idleMin: idle0, record: prior && prior.checkIn, world });
      if (pre && !pre.noModel) prechecks++;
      // The read-then-type section: from here to this session's `continue`/`break`.
      _checkInBusy = true;
      let cur;
      try { cur = await workerClient.rpc('getSession', { id: s.id }); } catch { continue; }
      const fresh = { ...row, ...cur, waitingFor: sessionWaitingFor(cur), brief: sessionBriefField(cur) || row.brief };
      fresh.reason = sessionReasonLib.sessionReason(fresh);
      const noNow = checkInLib.checkInBlock(fresh, { ...opts(s.id, liveKnown, row.childSessions), ...world });
      if (noNow) { logCheckInSkip(s, noNow, 'recheck'); continue; }
      if (fresh.brief.turnAt !== row.brief.turnAt) continue; // a turn began meanwhile
      const e = getBriefEntry(s.id);
      if (!e) continue;
      const now = Date.now();
      const why = checkInLib.checkInReading(fresh, { ...opts(s.id, liveKnown, row.childSessions), now }) || 'stale-self';
      // #461 - a turn an API error cut has no end; its idle period counts from the error.
      const idleMin = (now - checkInLib.idleSince(fresh, why)) / 60000;
      // #463 - a repeat in the same idle period counts on from the last one.
      const n = checkInLib.periodOpen(e.checkIn, e.turnAt) ? checkInLib.askCount(e.checkIn) + 1 : 1;
      const verdict = pre && pre.ok ? checkInPrecheck.effectiveVerdict(why, pre.verdict, { reporting: fresh.brief.reporting }) : 'wake';
      const ctxTokens = checkInLib.ctxTokensOf(fresh);
      const named = { name: e.name || s.name || null, cwd: s.cwd || null };
      if (pre && !pre.ok) logCheckIn('precheck', s.id, null, { ...named, verdict: 'wake', failed: pre.reason });
      if (verdict === 'skip' || verdict === 'tell') {
        // Nothing is typed. A virtual check-in is recorded as answered (lib/check-in.js skipRecord), so
        // the period, the count and layer 1's change gate hold the session quiet until something moves.
        const skipped = checkInLib.skipRecord(now, idleMin, why, checkInLib.periodOpen(e.checkIn, e.turnAt) ? e.checkIn : null, { verdict, reason: pre.reason, model: pre.model, wait: fresh.brief.wait,
          baseline: checkInLib.changeSignature(fresh, { children: row.childSessions, ...pre.world, now }) });
        const told = verdict === 'tell' ? { possibleAsk: { text: `Pre-check: ${skipped.pre.reason}`.slice(0, 240), at: now } } : {};
        setBriefEntry(s.id, { ...e, ...told, checkIn: skipped });
        logCheckIn('precheck', s.id, skipped, { ...named, verdict, reason: skipped.pre.reason, model: pre.model, ms: pre.ms });
        ledgerCheckIn(verdict === 'tell' ? 'told' : 'skipped', 'precheck', s, { why, n, idleMin, ctxTokens, verdict, reason: pre.reason, model: pre.model });
        console.log(`[check-in] ${s.id}: pre-check said ${verdict} (${why}, ${Math.round(idleMin)} min idle)`);
        continue; // nothing was typed: the next session may be asked in this scan
      }
      // Only what TYPES waits for the hand-off scan: it may be mid-read of a row it will type into (a skip or a tell
      // writes only this record, so the model's answer is kept). Nothing is consumed; the next scan retries.
      if (_autoScanBusy) break;
      // #540 layer 3 - a wake of a big session idle an hour is the existing hand-off instead (#340/#393): the
      // successor answers from a brief and the NEXT wake costs a small context. startHandoff keeps every
      // hand-off gate (autoBlock: handoff.auto off, a person's Cancel, typing, a draft); refused, the
      // check-in below is what it always was.
      const hc = handoffLib.handoffCandidate(fresh, { now, cfg: hcfg, supported: agentsLib.handsOff(fresh.agent) });
      if (checkInLib.handoffInstead({ verdict, why, idleMin, handoff: hc, cfg })) {
        if (handoffRunActive()) { logCheckInSkip(s, 'handoff-busy', 'handoff-instead'); continue; } // a run started during the model call
        const started = startHandoff(s.id, { ...fresh, handoff: hc }, { trigger: 'auto' });
        if (started.run) {
          logCheckIn('handed-off', s.id, { sentAt: now, idleMin, why, n }, { ...named, ctxTokens });
          ledgerCheckIn('handed-off', 'handoff', s, { why, n, idleMin, ctxTokens, verdict, reason: pre && pre.ok ? pre.reason : '', model: pre && pre.ok ? pre.model : '' });
          console.log(`[check-in] ${s.id}: a hand-off instead of a check-in (${Math.round(ctxTokens / 1000)}k ctx, ${Math.round(idleMin)} min idle)`);
          break; // one per scan; the hand-off's own prompt is in flight
        }
        logCheckInSkip(s, `handoff-${started.why || 'refused'}`, 'handoff-instead');
      }
      const rec = { ...checkInLib.startRecord(now, idleMin, why, n),
        ...(pre && pre.ok ? { pre: { verdict: 'wake', reason: checkInLib.clipReason(pre.reason), model: pre.model, at: now } } : {}) };
      // Recorded FIRST, then typed: the delivery hook can arrive before this returns.
      setBriefEntry(s.id, { ...e, checkIn: rec });
      // #463 - nothing reported: the work listed as running is what it is idle on.
      const what = why === 'api-error' ? fresh.apiErrorText
        : why === 'live-unreported' ? (fresh.reason && fresh.reason.text)
          : (fresh.brief.wait && fresh.brief.wait.what);
      if (!typePrompt(s.id, checkInLib.checkInPrompt({ idleMin, what, why }))) {
        // Nothing was typed: the worker link is down, or (typePrompt's #479 backstop) a draft
        // appeared since the gate read it (logged as a skip). Undo the record, so the next scan
        // asks again - deferred, never consumed.
        if (composerHasDraft(s.id)) logCheckInSkip(s, 'draft', 'typed');
        const now2 = getBriefEntry(s.id);
        if (now2 && now2.checkIn === rec) setBriefEntry(s.id, { ...now2, checkIn: e.checkIn || null });
        continue;
      }
      logCheckIn('sent', s.id, rec, { ...named, ...(pre && pre.ok ? { verdict: 'wake', reason: rec.pre.reason, model: pre.model } : {}) });
      // A repeat names what moved since its answer (an older answer with no baseline counts as changed: repeatDue).
      const changed = answered ? (answered.base ? checkInLib.changedParts(answered.base, checkInLib.changeSignature(fresh, { children: row.childSessions, ...world, now })) : ['no-baseline']) : undefined;
      ledgerCheckIn('woken', pre && pre.ok ? 'precheck' : 'rule', s, { why, n, idleMin, ctxTokens, verdict: pre && pre.ok ? 'wake' : undefined,
        reason: pre && pre.ok ? pre.reason : pre ? `pre-check failed: ${pre.reason}` : '', model: pre && pre.ok ? pre.model : '', changed });
      console.log(`[check-in] ${s.id}: asked after ${Math.round(idleMin)} min idle (${why}${n > 1 ? `, ask ${n}` : ''})`);
      break; // one per scan
    }
  } catch (err) {
    console.error(`[check-in] scan: ${err.message}`);
  } finally { _checkInBusy = false; _checkInScanning = false; }
}

// A run survives a hot reload on disk; this is what moves it on, and what times it out.
const _handoffTicker = setInterval(() => {
  for (const [id, e] of Object.entries(briefStore().sessions)) {
    if (e && handoffLib.isActive(e.handoff)) advanceHandoff(id);
  }
  autoHandoffScan();
  checkInScan(); // #443 - returns at once while the hand-off scan above is still busy
}, 3000);
if (_handoffTicker.unref) _handoffTicker.unref();

// #351 - close agent-started sessions nobody came back to. The rule is
// lib/spawn-reaper.js shouldClose; this reads the sockets and the worker for it, and ends a
// session the same way DELETE /api/sessions/:id does (killLocalSession). LOCAL sessions only:
// each server runs its own sweep over its own sessions, and none reaches into a peer.
/** Viewers of [id] for the reaper: sockets attached and ACTIVE, plus every socket still
 *  attaching - its mode is not known yet, and a person who has just opened the session must
 *  never lose it to a sweep that raced the attach. */
function activeViewerCount(id) {
  const attached = spawnReaper.countActiveViewers([...(sessionClients.get(id) || [])].map((c) => ({ background: !!c._wtBackground })));
  return attached + (attachingSockets.get(id) ? attachingSockets.get(id).size : 0);
}

// What a sweep DECIDES ON must not inherit the badge's leniencies. The lists age a launch out
// at 6h (BG_TASKS_MAX_AGE_MS), mark a shell stale at 6h, turn a failed read into [] and answer
// [] when the process snapshot is old: fine for a chip, wrong for "may I kill this". The idle
// threshold is ALSO 6h, so at the moment the reaper may act the aged gate would be dead, and a
// failed read would look like a quiet session. So the reaper reads the raw lists and carries
// null for "could not tell", which lib/spawn-reaper.js shouldClose keeps. The process tree
// comes from snapshotNoWait (#280: server.js never awaits a whole-machine query - a hung
// PowerShell must not stall even a timer): a tree at most SNAPSHOT_SERVE_MAX_MS old, or null
// when there is none, which keeps the session and starts the refresh the next sweep reads.

/** What is running in [s]: an array (known, maybe empty) or null (could not tell). */
async function reaperRunningWork(s) {
  try {
    let tasks;
    try { tasks = await readBackgroundTasks(s); } catch { tasks = null; }
    let shells = null;
    if (!Number.isFinite(s.pid)) shells = null;
    // The process snapshot is null off Windows BY DESIGN (no source of truth for the tree
    // there), so shells are unreadable, not unknown: the transcript source still speaks.
    else if (process.platform !== 'win32') shells = [];
    else {
      const procs = processTree.snapshotNoWait();
      // #411: the agent's MCP-server shells are not work (an npx server lives as long as it).
      shells = procs ? processTree.liveWorkUnder(procs, s.pid, agentsLib.mcpLaunchFor(s.agent)) : null;
    }
    return spawnReaper.combineWork(tasks, shells);
  } catch {
    return null;
  }
}

let _spawnSweepBusy = false;
/** One pass. `idleMs` and `fail` are test-only (the route that passes them exists only under
 *  WT_TEST): a shorter threshold, and 'work' / 'metrics' to make that read fail. */
async function spawnReaperSweep({ idleMs, fail } = {}) {
  const out = { closed: [], kept: {} };
  if (_spawnSweepBusy) return { ...out, skipped: 'busy' };
  _spawnSweepBusy = true;
  const faults = new Set(process.env.WT_TEST && Array.isArray(fail) ? fail : []);
  try {
    const listedAt = Date.now();
    const { sessions } = await workerClient.rpc('listSessions');
    spawnStore.prune(new Set(sessions.map((s) => s.id)), listedAt);
    const cfg = spawnReaperCfg(idleMs);
    for (const s of sessions) {
      try {
        const meta = spawnStore.metaOf(s.id);
        if (!meta || meta.by !== 'agent') continue; // human, still pending, or no verdict: never closed
        // Someone is looking right now: that IS the last time it was viewed. Keeps the clock
        // honest across a restart that never saw the viewer leave.
        const viewers = activeViewerCount(s.id);
        if (viewers > 0) { spawnStore.noteViewed(s.id); out.kept[s.id] = 'viewer'; continue; }
        if (!cfg.enabled) { out.kept[s.id] = 'disabled'; continue; }
        // The slow reads first, the worker's own row last and the decision straight after it.
        let metrics = null, metricsKnown = true;
        try {
          if (faults.has('metrics')) throw new Error('injected');
          metrics = await sessionMetrics(s);
        } catch { metricsKnown = false; }
        const backgroundTasks = faults.has('work') ? null : await reaperRunningWork(s);
        const cur = await workerClient.rpc('getSession', { id: s.id });
        const m = spawnStore.metaOf(s.id);
        const d = spawnReaper.shouldClose({
          ...cur, ...favoriteFields(s.id), activeViewers: viewers, openAsks: ((sessionBriefField(cur) || {}).asks || []).length,
          usageLimit: metricsKnown ? usageLimitFields(s.id, metrics, cur) : null, backgroundTasks,
        }, m, Date.now(), cfg);
        if (!d.close) { out.kept[s.id] = d.why; continue; }
        // The last look, with nothing awaited between it and the kill request: a socket that
        // attached, or declared itself active, while the reads above were in flight keeps it.
        if (activeViewerCount(s.id) > 0) { out.kept[s.id] = 'viewer'; continue; }
        await killLocalSession(s.id, 'reaped'); // #413 - ended how: the sweep
        out.closed.push(s.id);
        console.log(spawnReaper.closeLogLine({ name: cur.name, id: s.id, spawnedBy: m.spawnedBy, idleMs: d.idleMs }));
      } catch (e) {
        if (!/not found/i.test(e.message)) console.error(`spawn-reaper: ${s.id}: ${e.message}`);
      }
    }
  } finally { _spawnSweepBusy = false; }
  return out;
}
const _spawnReaperTicker = setInterval(() => {
  spawnReaperSweep().catch((e) => console.error(`spawn-reaper: sweep failed: ${e.message}`));
}, spawnReaper.SWEEP_EVERY_MS);
if (_spawnReaperTicker.unref) _spawnReaperTicker.unref();

// --- #359: prepare this machine for a restart -------------------------------------
// lib/maintenance.js owns every rule; this is the I/O. The hold is persisted so a hot
// reload keeps it, and it clears itself once the restart it was for has happened.
const MAINT_FILE = process.env.WT_MAINTENANCE_FILE || path.join(__dirname, 'maintenance.json');
function loadMaint() {
  try {
    const j = JSON.parse(fs.readFileSync(MAINT_FILE, 'utf8'));
    return { hold: (j && j.hold) || null, back: (j && j.back) || null, off: (j && j.off) || null };
  } catch { return { hold: null, back: null, off: null }; }
}
let _maint = loadMaint();
function saveMaint() {
  try {
    if (!_maint.hold && !_maint.back && !_maint.off) { try { fs.unlinkSync(MAINT_FILE); } catch { /* none */ } return; }
    const tmp = `${MAINT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_maint, null, 2));
    fs.renameSync(tmp, MAINT_FILE);
  } catch (e) { console.error(`[maintenance] save failed: ${e.message}`); }
}
// When this machine booted, as a timestamp. Uptime is whole seconds, so it wobbles a
// little; lib/maintenance.js allows for that.
const machineBootAt = () => Date.now() - Math.round(os.uptime() * 1000);
const maintRowsOf = (sessions) => Object.fromEntries(sessions.map((s) => [s.id, s]));
// The worker row plus the one server-side fact the rules read (a pending question).
const maintRowOf = (row) => ({ ...row, waitingFor: sessionWaitingFor(row) });
// Every change to the hold goes through here: read _maint.hold at the moment of the
// change (never a copy taken before an await), apply one pure step, save if it moved.
function maintUpdate(step) {
  if (!_maint.hold) return;
  const next = step(_maint.hold);
  if (next !== _maint.hold) { _maint.hold = next; saveMaint(); }
}

/** The restart happened: drop the hold and queue the "back" notice. */
function maintCheckRestarted(rows) {
  if (!_maint.hold || !maintLib.restarted(_maint.hold, rows, machineBootAt(), workerClient.workerIdentity())) return;
  const back = maintLib.backList(_maint.hold, Date.now());
  console.log(`[maintenance] restart detected: hold "${_maint.hold.reason}" cleared${back ? `, ${back.pending.length} session(s) to tell` : ''}`);
  _maint = { hold: null, back, off: null };
  saveMaint();
}

/** A hook for a held session: delivery (the tagged UserPromptSubmit) and the answer (its Stop). */
function maintNoteHook(id, event, body) {
  maintUpdate((h) => maintLib.noteHook(h, id, event, body, Date.now()));
}

/** Type a notice into each session in `list` ({ since, pending }) that is idle at its
 *  composer; keep the rest until BACK_TIMEOUT_MS. Returns the list still owed, or null. */
function maintDeliver(list, rows, promptOf, what) {
  const expired = Date.now() - list.since > maintLib.BACK_TIMEOUT_MS;
  const pending = [];
  for (const id of list.pending) {
    const row = rows[id] && maintRowOf(rows[id]);
    // Not in the list: not restored. The worker restores every saved session before it
    // answers its first RPC, so a missing id here is gone for good, not still coming.
    if (!row) continue;
    if (maintLib.canSendBack(row) && !checkInInFlight(id) && !maintDraftHeld(id)) { // #443 - never behind a check-in still landing
      typePrompt(id, promptOf(list.reason));
      console.log(`[maintenance] ${id}: ${what}`);
    } else if (!expired) pending.push(id);
  }
  return pending.length === list.pending.length ? list : (pending.length ? { ...list, pending } : null);
}

/** #410: where what runs decides the verdict (said yes and its turn ended, or a plain shell),
 *  read it into busySince, so status can say since when - and a yes that stays BUSY gets ONE
 *  follow-up. Anywhere else the work is not read ([] clears busySince). Runs after the tick's
 *  synchronous pass (it awaits), and re-reads a session before typing into it. */
async function maintBusyPass(rows) {
  for (const id of Object.keys(_maint.hold.sessions)) {
    const row = rows[id] && maintRowOf(rows[id]);
    if (!row || !_maint.hold || !_maint.hold.sessions[id]) continue;
    const work = maintLib.workDecides(_maint.hold.sessions[id], row, Date.now()) ? await reaperRunningWork(rows[id]) : [];
    if (!_maint.hold || !_maint.hold.sessions[id]) continue; // cancelled during the read
    maintUpdate((h) => maintLib.noteWork(h, id, row, work, Date.now()));
    if (!maintLib.shouldNudge(_maint.hold.sessions[id], row, work, Date.now())) continue;
    // `row` was listed before the work reads: re-read the session, so a turn that started
    // meanwhile is never typed behind (canPrompt's whole point).
    const cur = await workerClient.rpc('getSession', { id }).then(maintRowOf, () => null);
    const entry = _maint.hold && _maint.hold.sessions[id];
    if (cur && entry && maintLib.shouldNudge(entry, cur, work, Date.now()) && !maintDraftHeld(id)) {
      typePrompt(id, maintLib.busyPrompt(_maint.hold.reason, work, maintLib.workSince(entry, work), MAINT_SCRIPT));
      maintUpdate((h) => maintLib.noteNudged(h, id, Date.now()));
      console.log(`[maintenance] ${id}: said yes but still busy; asked about it (try ${_maint.hold.sessions[id].nudgeTries})`);
    }
  }
}

// #479 - a session holding a person's unsent draft is not asked (the question's CR would
// submit the draft): it stays unanswered, which blocks the restart SAFE, and says why once.
const _maintDraftLogged = new Set();
function maintDraftHeld(id) {
  if (!composerHasDraft(id)) { _maintDraftLogged.delete(id); return false; }
  if (!_maintDraftLogged.has(id)) { _maintDraftLogged.add(id); console.log(`[maintenance] ${id}: not prompted - an unsent draft is in its composer`); }
  return true;
}
let _maintBusy = false;
/** Ask each session as soon as it can take the question (and ask again when a "later" is
 *  up), notice an ended turn on an agent with no Stop hook, and, after the restart, send
 *  the "back" notice - or, after a cancel, the "called off" one. */
async function maintTick() {
  if ((!_maint.hold && !_maint.back && !_maint.off) || _maintBusy) return;
  _maintBusy = true;
  try {
    const { sessions } = await workerClient.rpc('listSessions');
    const rows = maintRowsOf(sessions);
    maintCheckRestarted(rows);
    let changed = false;
    if (_maint.hold) {
      // An agent that appeared while the hold is on (created between the refusal check and
      // the prepare's session list) is tracked, so it is asked like the rest.
      for (const [id, r] of Object.entries(rows)) {
        if (r.agent && !_maint.hold.sessions[id]) maintUpdate((h) => maintLib.trackSession(h, r));
      }
      for (const id of Object.keys(_maint.hold.sessions)) {
        const row = rows[id] && maintRowOf(rows[id]);
        if (!row || !_maint.hold) continue;
        maintUpdate((h) => maintLib.noteStatus(h, row));
        if (maintLib.shouldPrompt(_maint.hold.sessions[id], row, Date.now()) && !checkInInFlight(id) && !maintDraftHeld(id)) { // #443
          typePrompt(id, maintLib.wrapUpPrompt(_maint.hold.reason, MAINT_SCRIPT));
          maintUpdate((h) => maintLib.notePrompted(h, id, Date.now()));
          console.log(`[maintenance] ${id}: asked about the restart (ask ${_maint.hold.sessions[id].asks}, try ${_maint.hold.sessions[id].tries})`);
        }
      }
    }
    if (_maint.back) {
      const next = maintDeliver(_maint.back, rows, maintLib.backPrompt, 'told the machine is back');
      if (next !== _maint.back) { _maint.back = next; changed = true; }
    }
    if (_maint.off) {
      const next = maintDeliver(_maint.off, rows, maintLib.calledOffPrompt, 'told the restart is called off');
      if (next !== _maint.off) { _maint.off = next; changed = true; }
    }
    if (changed) saveMaint();
    // LAST, and on its own: everything above types from `rows` with no await in between, so
    // a prompt is never typed on a stale idle row. The #410 pass awaits, so it must not run
    // before (or inside) that pass - final-gate finding.
    if (_maint.hold) await maintBusyPass(rows);
  } catch (e) {
    console.error(`[maintenance] tick: ${e.message}`);
  } finally { _maintBusy = false; }
}
const _maintTicker = setInterval(() => { maintTick(); }, 3000);
if (_maintTicker.unref) _maintTicker.unref();

/** The answer GET /api/maintenance/status gives: a verdict per session, from state. */
async function maintStatus() {
  const { sessions } = await workerClient.rpc('listSessions');
  const rows = maintRowsOf(sessions);
  maintCheckRestarted(rows);
  const back = _maint.back ? { reason: _maint.back.reason, since: _maint.back.since, pending: _maint.back.pending.length } : null;
  if (!_maint.hold) return { ...maintLib.status(null, {}, {}), back };
  const works = {};
  for (const s of sessions) {
    rows[s.id] = maintRowOf(s);
    works[s.id] = await reaperRunningWork(s);
  }
  const out = maintLib.status(_maint.hold, rows, works, Date.now());
  // What the agent said when its turn ended - shown, never decided on.
  for (const v of out.sessions) {
    const did = (getBriefEntry(v.id) || {}).did;
    v.reply = did && v.promptedAt && did.at >= v.promptedAt ? did.text : null;
  }
  return { ...out, back };
}

/** The refusal a creating route answers with while a hold is on, or null. */
function maintRefusal() {
  if (!_maint.hold) return null;
  return {
    error: `Restart hold on this machine (${_maint.hold.reason}): new sessions are refused until it restarts. Cancel the hold, or pass "force": true.`,
    restartHold: { reason: _maint.hold.reason, startedAt: _maint.hold.startedAt },
  };
}

// The OLD session's agent posts its verdict (scripts/wt-handoff.js) once the brief file
// is written. Hook token ONLY, like /report: this route moves a run that ends in a kill.
app.post('/api/session/:id/handoff-report', express.json({ limit: '8kb' }), (req, res) => {
  if (!verifyHookToken(req.headers['x-wt-hook-token'])) return res.status(401).json({ error: 'Unauthorized' });
  const id = req.params.id;
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  const run = (getBriefEntry(id) || {}).handoff;
  if (!run || run.state !== 'wrapping') {
    return res.status(409).json({ error: 'no hand-off is waiting for a verdict from this session' });
  }
  const v = handoffLib.validateHandoffReport(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  // The successor starts from this file, so it must exist and say something. Its path
  // is the one the server named, never one taken from the post.
  let size = 0;
  try { size = fs.statSync(run.briefFile).size; } catch { /* absent */ }
  if (!size) return res.status(400).json({ error: `write the brief to ${run.briefFile} first, then post the verdict again` });
  const at = Date.now();
  setHandoffRun(id, handoffLib.transition(run, 'spawning', at, { verdict: v.verdict, verdictAt: at }));
  res.json({ ok: true, canClose: v.verdict.canClose });
  // #413 - the wrap-up is done and the brief exists: the moment to write each item's card,
  // whatever the successor then does. `context-budget` when the server started it (#345).
  workItemsCheckpoint(id, getBriefEntry(id), workItems.handoffEvent(run), {
    at, extra: { handoffBriefFile: run.briefFile, verdict: v.verdict, cwd: (getBriefEntry(id) || {}).cwd || null },
  });
  advanceHandoff(id);
});

// #413 - what a `continue ado:N` prompt starts from (scripts/wt-work-item.js), for an agent
// in a session: the item's events and last snapshot from every machine of the cluster.
// Hook token ONLY, like the posts above - an agent holds no cookie or Bearer.
app.get('/api/session/:id/work-item/:ref', async (req, res) => {
  if (!verifyHookToken(req.headers['x-wt-hook-token'])) return res.status(401).json({ error: 'Unauthorized' });
  if (!_HOOK_UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'session not found' });
  try { await workerClient.rpc('getSession', { id: req.params.id }); } catch { return res.status(404).json({ error: 'session not found' }); }
  const key = workItemKeyOr400(req, res);
  if (!key) return;
  try { res.json(await clusterWorkItemView(key)); } catch (e) {
    console.error(`[work-items] view ${key}: ${e.message}`);
    res.status(500).json({ error: 'could not read the work-item log' });
  }
});

app.post('/api/hook', express.json({ limit: '256kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = req.headers['x-wt-session-id'];
  if (!id) return res.json({ ok: true, skipped: 'no session ID' });
  const event = req.body?.hook_event_name || req.body?.event;
  const claudeSessionId = req.body?.session_id;
  try {
    res.json(await answerHook(id, event, claudeSessionId, req.body, true));
  } catch (e) {
    if (/not found/i.test(e.message)) return res.json({ ok: true, skipped: 'session not found' });
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/session/:id/hook', express.json({ limit: '256kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const event = req.body?.hook_event_name || req.body?.event;
  if (!event) return res.status(400).json({ error: 'event required' });
  const claudeSessionId = req.body?.session_id;
  try {
    res.json(await answerHook(req.params.id, event, claudeSessionId, req.body, false));
  } catch (e) {
    if (/not found/i.test(e.message)) return res.status(404).json({ error: 'session not found' });
    if (/event required/i.test(e.message)) return res.status(400).json({ error: 'event required' });
    res.status(500).json({ error: e.message });
  }
});

// Claude Code status-line metrics (ctx%, 5h/7d rate-limit %, model, effort).
// Pushed by the global statusline script (throttled, safe-fail) — the only
// source for these numbers, which Claude Code exposes to nothing but its own
// statusLine invocation. Keyed by Claude session id; ephemeral (reposted every
// few seconds), so a plain in-memory Map is fine — it self-heals after a
// server hot-reload. Localhost-only: same trust boundary as the local hooks.
// #425 - real session cost: the statusLine payload's `cost` object, sampled per session.
const SESSION_COST_FILE = process.env.WT_SESSION_COST_FILE || path.join(__dirname, 'logs', 'session-cost.jsonl');
const _costLogged = new Map();   // agent session id -> { at, usd } of the last line written
const _wtIdByAgentSid = new Map(); // agent session id -> web-terminal session id, learnt from hooks
function noteAgentSession(id, agentSid) {
  if (!id || typeof agentSid !== 'string' || !agentSid || _wtIdByAgentSid.get(agentSid) === id) return;
  _wtIdByAgentSid.set(agentSid, id);
  if (_wtIdByAgentSid.size > 500) _wtIdByAgentSid.delete(_wtIdByAgentSid.keys().next().value);
}
const claudeStatusMetrics = new Map(); // claudeSessionId -> { ctx, ctxWindow, ctxTokens, fiveH, sevenD, fiveHResetAt, model, effort, ts }
// Idle sessions stop rendering their status line, so they stop posting. Keep the
// last-known metrics for hours: context % is frozen while idle (accurate), and
// stale 5h/7d numbers are low-stakes. Prevents an idle session showing only its
// folder. Bounded by the 200-entry prune + a session vanishing from /api/sessions.
// The TTL itself lives in lib/usage-rollup.js (METRICS_TTL_MS) — one definition of
// "too old to trust" shared by the pushed map, the roll-up, and any future source.
//
// #72 — the map is MIRRORED TO DISK, because in-memory was only ever true for an
// ACTIVE session. The old comment ("self-heals after a hot-reload") held because a
// working session reposts within seconds; an IDLE one never reposts at all, so a
// restart blanked ctx/5h/7d for every idle session permanently — until someone typed
// into it. Persisting costs one debounced write and removes the whole class.
// Overridable so a test run (and the rig) mirrors to its OWN file: the production
// server and a test server share __dirname, and a test must not write conversation
// ids into the file the real server loads on its next restart.
const CLAUDE_METRICS_FILE = process.env.WT_CLAUDE_METRICS_FILE || path.join(__dirname, 'claude-metrics.json');
// The FILE keeps entries far longer than METRICS_TTL_MS: past the TTL a report is no
// longer served as a live quota reading, but its ctx is still worth restoring across a
// restart (context occupancy cannot change while a session is idle — that is exactly
// why it is worth keeping). Bounded by count as well as age so the file cannot grow
// without limit across months of sessions.
const CLAUDE_METRICS_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const CLAUDE_METRICS_MAX_ENTRIES = 200;
// Status lines re-render far faster than the numbers change; the debounce keeps the
// mirror to one write per burst. Overridable so a test can assert the file's CONTENT
// without waiting out the production interval — the code path is identical either way.
const CLAUDE_METRICS_WRITE_DEBOUNCE_MS =
  parseInt(process.env.WT_CLAUDE_METRICS_DEBOUNCE_MS, 10) > 0
    ? parseInt(process.env.WT_CLAUDE_METRICS_DEBOUNCE_MS, 10)
    : 10000;

function loadClaudeMetrics() {
  let raw;
  try {
    if (!fs.existsSync(CLAUDE_METRICS_FILE)) return;
    raw = JSON.parse(fs.readFileSync(CLAUDE_METRICS_FILE, 'utf8'));
  } catch (e) { console.error('claude-metrics load failed:', e.message); return; }
  if (!raw || typeof raw !== 'object') return;
  const now = Date.now();
  for (const [sid, m] of Object.entries(raw)) {
    // Re-validate on the way IN. The file is ours, but a truncated write or a
    // hand-edit must not put a shape on the wire that never passed the endpoint's
    // checks — every value here is rendered by two clients.
    if (typeof sid !== 'string' || !sid || !m || typeof m !== 'object') continue;
    if (typeof m.ts !== 'number' || !Number.isFinite(m.ts) || now - m.ts > CLAUDE_METRICS_RETAIN_MS) continue;
    const parsed = parseStatusPayload({
      ctx: m.ctx, five: m.fiveH, seven: m.sevenD, model: m.model, effort: m.effort,
    });
    claudeStatusMetrics.set(sid, {
      ...parsed,
      // parseStatusPayload's legacy branch carries no window/tokens/reset — those are
      // restored straight from the file, through the same validators the raw branch uses.
      ctxWindow: typeof m.ctxWindow === 'number' && Number.isFinite(m.ctxWindow) && m.ctxWindow > 0 ? m.ctxWindow : null,
      ctxTokens: typeof m.ctxTokens === 'number' && Number.isFinite(m.ctxTokens) && m.ctxTokens >= 0 ? m.ctxTokens : null,
      fiveHResetAt: typeof m.fiveHResetAt === 'number' && Number.isFinite(m.fiveHResetAt) ? m.fiveHResetAt : null,
      ts: m.ts,
    });
  }
  pruneStatusMetrics();
}

let _metricsWriteTimer = null;
function writeClaudeMetricsSoon() {
  if (_metricsWriteTimer) return;
  _metricsWriteTimer = setTimeout(() => {
    _metricsWriteTimer = null;
    flushClaudeMetrics();
  }, CLAUDE_METRICS_WRITE_DEBOUNCE_MS);
  if (_metricsWriteTimer.unref) _metricsWriteTimer.unref(); // never hold the process open
}

function flushClaudeMetrics() {
  const now = Date.now();
  // Newest first, so trimming to the cap drops the least useful entries.
  const entries = [...claudeStatusMetrics.entries()]
    .filter(([, m]) => m && typeof m.ts === 'number' && now - m.ts <= CLAUDE_METRICS_RETAIN_MS)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, CLAUDE_METRICS_MAX_ENTRIES);
  try {
    fs.writeFileSync(CLAUDE_METRICS_FILE, JSON.stringify(Object.fromEntries(entries), null, 2));
  } catch (e) { console.error('claude-metrics write failed:', e.message); }
}

// Restore the mirror before the first session list is ever served, so an idle session
// shows its real ctx immediately after a restart rather than only once it next reports
// (which, being idle, it never does).
loadClaudeMetrics();

// #56 — the agent whose CLI pushes its status line here. Asked once of the registry,
// never hardcoded: it is the OWNER of every pushed report, including one carried by a
// session that declares no agent (a `claude` run inside a plain shell).
const STATUS_PUSH_AGENT = agentsLib.statusPushAgent();

function getStatusMetrics(claudeSessionId) {
  if (!claudeSessionId) return null;
  const m = claudeStatusMetrics.get(claudeSessionId);
  if (!m) return null;
  // #56: `ts` (when this landed) and `agent` (whose account quota it describes) ride along.
  // The 5h/7d windows are account-wide, so the server-side roll-up needs both to pick the
  // freshest report per agent — and to say nothing at all when the newest one is stale.
  //
  // #72 — the TTL applies PER FIELD, because the fields decay differently:
  //   ctx / ctxWindow / ctxTokens describe THIS SESSION's context, which cannot change
  //     while the session is idle. An idle session is precisely the one that stopped
  //     reporting, so ageing its ctx out replaces an accurate number with nothing (and,
  //     before this, with the client's 200k guess — #71).
  //   fiveH / sevenD / fiveHResetAt describe an ACCOUNT-WIDE window that keeps moving
  //     whether this session reports or not. Past the TTL they are unknown, and unknown
  //     renders as NOTHING, never as 0% (#56 rule 3). The roll-up drops the whole report
  //     on `ts` before it ever reads a field, so this only affects the per-session view.
  const stale = Date.now() - m.ts > METRICS_TTL_MS;
  return {
    ctx: m.ctx, ctxWindow: m.ctxWindow ?? null, ctxTokens: m.ctxTokens ?? null,
    fiveH: stale ? null : m.fiveH,
    sevenD: stale ? null : m.sevenD,
    fiveHResetAt: stale ? null : m.fiveHResetAt,
    model: m.model, effort: m.effort, ts: m.ts, agent: STATUS_PUSH_AGENT,
  };
}

// Drop stale entries so the Map can't grow without bound as sessions come and go.
function pruneStatusMetrics() {
  const now = Date.now();
  for (const [k, v] of claudeStatusMetrics) {
    if (now - v.ts > METRICS_TTL_MS) claudeStatusMetrics.delete(k);
  }
}

// --- transcript-recorded metrics (Codex) -------------------------------------
// Claude PUSHES its status line to /api/claude-status; Codex writes the same numbers
// into its rollout every turn. For agents whose provider exposes readMetrics we read
// the transcript's TAIL instead — no extra process, no extra endpoint.
//
// The session list is polled, so the read is memoised on the file's identity
// (size + mtime): an unchanged rollout costs one stat, a changed one costs a single
// bounded tail read. Nothing is cached across a rewrite of the file.
const METRICS_TAIL_BYTES = 262144; // 256KB — a turn's token_count sits near the end
// Codex writes `turn_context` (the model + effort labels) ONCE PER USER TURN, near the
// start of that turn. A single long turn — an agent grinding through dozens of tool
// calls — pushes it far outside the tail, so the head is read too. Concatenating
// head + tail and scanning BACKWARD keeps the semantics right: the newest token_count
// (tail) wins, and the scan only falls through to the head for a label the tail lacks.
const METRICS_HEAD_BYTES = 65536; // 64KB — session_meta + the first turn_context
const _transcriptMetricsCache = new Map(); // path -> { size, mtimeMs, metrics }

function _readSlice(fd, start, len) {
  const buf = Buffer.alloc(len);
  let read = 0;
  while (read < len) {
    const n = fs.readSync(fd, buf, read, len - read, start + read);
    if (n <= 0) break;
    read += n;
  }
  return buf.slice(0, read).toString('utf8');
}

// #73 — the CURRENT task list for a session, in the one shape both agents produce.
//
// The two sources are a registry fact, not a branch here:
//   'hooks'      already folded live in the notify-state (see processHookEvent).
//   'transcript' the newest whole-list snapshot, recovered from the file's tail.
// An agent that declares neither (a plain shell) costs nothing — no read, no parse.
//
// Returns null for "no task list", which the client renders as no panel at all. For the
// transcript source null also covers "the last snapshot is older than the tail window",
// and that is deliberately NOT reported as an empty list: blanking a live panel because
// one long turn pushed the plan out of view would be worse than leaving it as it was.
const TASKLIST_TAIL_BYTES = 262144; // 256KB, same budget as the metrics tail
const _taskListCache = new Map(); // path -> { size, mtimeMs, items }

function readSessionTaskList(sessionId, agent, tpath) {
  const source = agentsLib.taskListSource(agent);
  if (!source) return null;

  if (source === 'hooks') {
    const ns = _notifyState.get(sessionId);
    const items = ns && ns.taskList;
    return Array.isArray(items) && items.length ? items : null;
  }

  if (source !== 'transcript' || !tpath) return null;
  let st;
  try { st = fs.statSync(tpath); } catch { return null; }
  const hit = _taskListCache.get(tpath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.items;

  let items = null;
  try {
    if (st.size > 0) {
      const fd = fs.openSync(tpath, 'r');
      try {
        const start = Math.max(0, st.size - TASKLIST_TAIL_BYTES);
        let tail = _readSlice(fd, start, Math.min(TASKLIST_TAIL_BYTES, st.size));
        // Drop a leading partial line so a half-written JSON object is never parsed.
        if (start > 0) {
          const nl = tail.indexOf('\n');
          tail = nl >= 0 ? tail.slice(nl + 1) : '';
        }
        items = agentsLib.readTaskListFromText(agent, tail);
      } finally { fs.closeSync(fd); }
    }
  } catch { items = null; }
  _taskListCache.set(tpath, { size: st.size, mtimeMs: st.mtimeMs, items });
  return items;
}

function readTranscriptMetrics(tpath, adapter) {
  if (!tpath || !adapter || typeof adapter.readMetrics !== 'function') return null;
  let st;
  try { st = fs.statSync(tpath); } catch { return null; }
  const hit = _transcriptMetricsCache.get(tpath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.metrics;

  let metrics = null;
  try {
    if (st.size > 0) {
      const fd = fs.openSync(tpath, 'r');
      let text;
      try {
        if (st.size <= METRICS_HEAD_BYTES + METRICS_TAIL_BYTES) {
          text = _readSlice(fd, 0, st.size); // small enough — no need to splice
        } else {
          // Head: cut back to the last complete line so a partial one can't be parsed.
          let head = _readSlice(fd, 0, METRICS_HEAD_BYTES);
          const cut = head.lastIndexOf('\n');
          head = cut >= 0 ? head.slice(0, cut) : '';
          // Tail: drop the leading partial line for the same reason.
          const start = st.size - METRICS_TAIL_BYTES;
          let tail = _readSlice(fd, start, METRICS_TAIL_BYTES);
          const nl = tail.indexOf('\n');
          tail = nl >= 0 ? tail.slice(nl + 1) : '';
          text = head + '\n' + tail;
        }
      } finally { fs.closeSync(fd); }
      metrics = adapter.readMetrics(text);
      if (metrics) {
        // #56 — the two facts a pushed report carries in its envelope, recovered for a
        // report that was RECORDED instead: it is exactly as fresh as the last write of
        // the transcript holding it, and it describes the quota of the agent whose
        // transcript that is. Both are properties of the SOURCE, not of any one agent, so
        // there is nothing to branch on here.
        metrics.ts = st.mtimeMs;
        metrics.agent = adapter.id;
      }
    }
  } catch { metrics = null; } // unreadable/racing file → no metrics, never a 500
  _transcriptMetricsCache.set(tpath, { size: st.size, mtimeMs: st.mtimeMs, metrics });
  return metrics;
}

// A session whose transcript cannot be resolved would otherwise re-derive on EVERY
// session-list poll — and a Codex derivation walks the rollouts tree. Remember the
// miss briefly so a transcript-less session costs nothing, while one that appears
// (the agent's first turn) is picked up within the window.
const _metricsMissTtlMs = 60000;
const _metricsMiss = new Map(); // session id -> ts of the last failed resolution

// --- #69: hand fiveHResetAt to the worker, which is the one process that can arm a
// timer and survive THIS process restarting. sessionMetrics() is the single choke
// point every fiveHResetAt source (Claude's pushed stub, Codex's transcript read)
// already flows through for a LOCAL session, so it is the one place this needs
// wiring — no duplicate "did it change" logic in each of /api/sessions and the
// cluster fan-out, which both call sessionMetrics(). De-duped so the overwhelmingly
// common case (unchanged value, polled every few seconds) costs a Map lookup, not
// an RPC round trip; the worker independently no-ops an unchanged value too.
const _lastPushedResetAt = new Map(); // session id -> "<resetAt>|<capBlocked>" last sent

/**
 * Push the worker a decision about this session's window, de-duped.
 *
 * `fields` carries only what this caller actually knows: an OMITTED key says nothing
 * about that aspect and leaves the worker holding what it already had. That is why
 * the opt-out no longer travels as `fiveHResetAt: null` — see the setFiveHResetAt
 * handler in pty-worker.js for the "on hold forever" this cost.
 */
function _pushResetState(sessionId, fields) {
  const key = JSON.stringify([fields.fiveHResetAt, fields.capBlocked, fields.enabled]);
  if (_lastPushedResetAt.get(sessionId) === key) return;
  _lastPushedResetAt.set(sessionId, key);
  workerClient.rpc('setFiveHResetAt', { id: sessionId, ...fields })
    .catch((e) => console.error('setFiveHResetAt failed:', e.message));
}

/**
 * Does this metrics report SAY anything about the 5h window, or is it merely silent?
 *
 * The distinction is load-bearing and was missed the first time. A capped Claude
 * session stops pushing its status line — it is capped, it has nothing to run — and
 * past METRICS_TTL_MS getStatusMetrics blanks fiveH/fiveHResetAt while still
 * returning a truthy object. Treating that blank as "not blocked" pushed a null
 * resetAt, which the worker takes as CANCEL: it dropped the persisted reset time and
 * disarmed. A 5h window outlasts the 4h TTL, so the long wait this feature exists for
 * was exactly the one that lost its timer. Unknown is not recovered.
 */
function _metricsSpeakAboutWindow(metrics) {
  if (!metrics) return false;
  return (typeof metrics.fiveH === 'number' && Number.isFinite(metrics.fiveH))
      || (typeof metrics.fiveHResetAt === 'number' && Number.isFinite(metrics.fiveHResetAt));
}

function armResetTimerFromMetrics(sessionId, metrics) {
  // #137 — the user's per-session choice travels as its own field on every push, and
  // it does not depend on metrics saying anything. It used to be expressed as a null
  // reset time, which cancelled by destroying the schedule; see _pushResetState.
  const enabled = getAutoResumeEnabled(sessionId);

  // Silence is not evidence of recovery — see _metricsSpeakAboutWindow. Say nothing
  // about the WINDOW and leave the worker holding whatever it last learned, which for
  // a capped session is the reset time it still needs. The user's choice is not part
  // of that silence: a session switched off while its metrics have gone quiet must
  // still be switched off in the worker.
  if (!_metricsSpeakAboutWindow(metrics)) {
    if (!enabled) _pushResetState(sessionId, { enabled: false });
    return;
  }

  const raw = metrics.fiveHResetAt;
  const val = (typeof raw === 'number' && Number.isFinite(raw)) ? raw : null;
  // #138 — the worker arms on an OBSERVED block, never on a bare timestamp. The rule
  // lives in lib/usage-limit.js so the arming decision and the `usageLimit` the
  // session list publishes are one computation, not two readings of the same fields.
  //
  // Which is why this goes through usageLimitState rather than isCapBlocked directly:
  // #142 added a THIRD cap source (a Codex rollout's own usage_limit_exceeded error)
  // that the badge reads and this did not, so the list could publish `capBlocked: true`
  // while the worker was told `false`. Harmless only while Codex declines to arm — and
  // the comment above promises one computation, not two. Found in review.
  const { capBlocked } = usageLimit.usageLimitState({
    // The WHOLE metrics object, with only fiveHResetAt overridden by the sanitised
    // value above: observedCapReset needs the weekly window too, or an observed cap
    // here expires on the 7-day backstop while the badge expires it on the real reset.
    metrics: { ...metrics, fiveHResetAt: val },
    enabled: true,     // the opt-out is passed separately below; this is the QUOTA reading
    now: Date.now(),
    delayMs: usageLimit.autoResumeDelayMs(process.env),
  });
  // capBlocked stays the honest reading of the QUOTA even for an opted-out session —
  // it is still capped, and `enabled` is a separate question (lib/usage-limit.js
  // `usageLimitState` keeps the same two apart for the badge).
  _pushResetState(sessionId, { fiveHResetAt: val, capBlocked, enabled });
}

/** Forget the de-dup entry so the next poll re-pushes — used when the opt-out flips. */
function forgetPushedResetAt(sessionId) { _lastPushedResetAt.delete(sessionId); }

// #138 — capBlocked is deliberately NOT persisted by the worker (a blocked flag
// restored from disk hours later is exactly the unfounded arming the gate exists to
// prevent), so a restarted worker comes back knowing only the timestamp. That makes
// this de-dup memo a liability across a reconnect: it would report "already told it"
// about a worker that no longer knows, and auto-resume would go quietly dead until
// the reset time itself changed. Dropping it on disconnect costs one re-push per
// session on the next poll and restores the feature within seconds.
workerClient.on('close', () => _lastPushedResetAt.clear());

/**
 * The `usageLimit` block the session lists carry (#137). Derived here, on the server
 * that owns the session, so BOTH clients render one already-decided answer instead of
 * each re-implementing "is it capped, and when does it come back" against raw metrics.
 */
function usageLimitFields(sessionId, metrics, session) {
  return usageLimit.usageLimitState({
    metrics,
    enabled: getAutoResumeEnabled(sessionId),
    delayMs: usageLimit.autoResumeDelayMs(process.env),
    // The worker's own sighting of the agent's cap prompt — see pty-worker.js
    // detectUsageLimitPromptInOutput. Absent on a session from a worker too old to
    // report it, which simply falls back to the metrics derivation.
    observedBlockAt: session && session.limitPromptAt,
    // #138 - whether this agent may arm at all. Codex is `false` for now: it still
    // reports a spent window (so the row honestly shows the session is held), but the
    // badge must not say "resumes 14:32" when the worker's gate will refuse.
    canArm: agentsLib.armsAutoResume(session && session.agent),
    // #227 - and the WORKER's own answer to "is a resume actually scheduled", which
    // outranks the derivation whenever it is present. The worker holds the timer; every
    // other field here is an input to a guess about what it decided. It is passed
    // straight through (undefined when the session came from a worker too old to
    // publish it, which falls back to the guess) rather than being folded in here,
    // because the whole defect was two places computing one fact.
    armedByWorker: session ? session.autoResumeArmed : undefined,
  });
}

// The metrics for one session, from whichever source its agent provides. Claude's
// pushed status line wins when present (it is live and richer); otherwise an agent
// that records its own usage has it read from the transcript. A plain shell (agent
// null → the default provider, which has no readMetrics) never triggers a file read.
async function sessionMetrics(s) {
  const pushed = getStatusMetrics(s.claudeSessionId);
  // #483 - the worker is told the reset it should resume on, which after an automatic
  // account switch is the switch itself (armWithAutoSwitchResume); the row keeps the real numbers.
  if (pushed) { armWithAutoSwitchResume(s, pushed); return withContextBudget(s, pushed); }
  const adapter = getAdapter(s.agent);
  if (typeof adapter.readMetrics !== 'function') return null;

  const missedAt = _metricsMiss.get(s.id);
  if (missedAt && Date.now() - missedAt < _metricsMissTtlMs) return null;

  const tpath = await resolveSessionTranscriptPath(s.id);
  if (!tpath) { _metricsMiss.set(s.id, Date.now()); return null; }
  _metricsMiss.delete(s.id);
  const metrics = readTranscriptMetrics(tpath, adapter);
  armResetTimerFromMetrics(s.id, metrics);
  return withContextBudget(s, metrics);
}

// --- #393 the context budget and the compaction count, on every session's metrics ---
//
// The rule is lib/context-budget.js's; this is the I/O. Added in sessionMetrics, the one
// choke point both row shapers and the hand-off row read, so none of them can lack it.
//   ctxUsed      occupancy in tokens (what the budget is compared with)
//   budget       {warnAt, handoffAt, compactAt, source}; null for an agent that declares
//                no budget (lib/agents.js contextBudget) - a client keeps its old rule
//   compactions  how many times this conversation compacted; null until counted, or for
//                an agent that declares no compaction record
// The agent is the METRICS' owner first: a pushed status line is Claude's whichever
// session carries it (#56), so a plain-shell session running claude still gets a budget.
async function withContextBudget(s, metrics) {
  if (!metrics) return metrics;
  const agent = metrics.agent || s.agent || null;
  const policy = agentsLib.contextBudgetPolicy(agent);
  const budget = policy
    ? contextBudgetLib.contextBudget({ ctxWindow: metrics.ctxWindow, autoCompactWindow: agentAutoCompactWindow(policy) })
    : null;
  const record = agentsLib.compactionRecord(agent);
  const tpath = record ? await compactionTranscriptPath(s.id) : '';
  return {
    ...metrics,
    ctxUsed: contextBudgetLib.occupancy(metrics),
    budget,
    compactions: tpath ? compactionCount(tpath, record) : null,
  };
}

// A status line is pushed before the conversation's first message, so its transcript
// may not exist yet - and a miss costs a worker RPC and a projects walk. Not on every
// poll: a miss is remembered for the same minute the metrics path uses.
const _compactionPathMiss = new Map(); // session id -> ts of the last failed resolution
async function compactionTranscriptPath(id) {
  const missedAt = _compactionPathMiss.get(id);
  if (missedAt && Date.now() - missedAt < _metricsMissTtlMs) return '';
  const tpath = await resolveSessionTranscriptPath(id).catch(() => '');
  if (tpath) _compactionPathMiss.delete(id); else _compactionPathMiss.set(id, Date.now());
  return tpath;
}

// The agent's auto-compact window, from its settings file under the agent home. Stat at
// most every few seconds and re-read only when the file changed, so a settings edit lands
// with no restart and a poll costs nothing. Absent reads as unset. A file that does not
// parse keeps the last good value and is retried next check: Claude Code writes this file
// itself, so a read can land mid-write. WT_AGENT_SETTINGS_DIR replaces the agent home for
// this one lookup, so the suite can drive the setting without touching the real file.
const _acwCache = new Map(); // settings path -> { checkedAt, mtimeMs, value }
const ACW_RECHECK_MS = 5000;
function agentAutoCompactWindow(policy) {
  const file = path.join(process.env.WT_AGENT_SETTINGS_DIR || transcriptHome(), ...policy.settingsFile);
  const now = Date.now();
  let e = _acwCache.get(file);
  if (e && now - e.checkedAt < ACW_RECHECK_MS) return e.value;
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* absent */ }
  if (!e || e.mtimeMs !== mtimeMs) {
    if (mtimeMs === null) e = { value: null, mtimeMs };
    else {
      try {
        const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
        e = { value: contextBudgetLib.autoCompactWindowFrom(settings, policy), mtimeMs };
      } catch {
        e = { value: e ? e.value : null, mtimeMs: null }; // unparsed: re-read next time
      }
    }
  }
  e.checkedAt = now;
  _acwCache.set(file, e);
  return e.value;
}

// The compaction count of one transcript. The poll NEVER waits for it (#280's rule): it
// answers from the last scan and queues the next one. A transcript only grows, so each
// scan reads just the bytes added since the last (lib/context-budget.js scanCompactions);
// the first scan of a 150MB transcript is the only big read, and scans run one at a time
// so a hot reload with ten long sessions does not read them all at once.
const _compactionScans = new Map(); // transcript path -> scan state
const _compactionQueued = new Set();
let _compactionQueue = Promise.resolve();
const COMPACTION_CHUNK = 4 * 1024 * 1024;
const COMPACTION_SCANS_MAX = 200;
function compactionCount(tpath, record) {
  const e = _compactionScans.get(tpath);
  if (!_compactionQueued.has(tpath)) {
    _compactionQueued.add(tpath);
    _compactionQueue = _compactionQueue
      .then(() => scanCompactionFile(tpath, record))
      .catch(() => {})
      .then(() => { _compactionQueued.delete(tpath); });
  }
  return e ? e.count : null;
}

async function scanCompactionFile(tpath, record) {
  const st = await fs.promises.stat(tpath);
  let e = _compactionScans.get(tpath) || contextBudgetLib.emptyScan();
  if (st.size < e.offset) e = contextBudgetLib.emptyScan(); // rewritten, not appended
  if (st.size > e.offset) {
    const fh = await fs.promises.open(tpath, 'r');
    const buf = Buffer.allocUnsafe(Math.min(COMPACTION_CHUNK, st.size - e.offset));
    try {
      while (e.offset < st.size) {
        const len = Math.min(buf.length, st.size - e.offset);
        const { bytesRead } = await fh.read(buf, 0, len, e.offset);
        const next = contextBudgetLib.scanCompactions(e, buf.subarray(0, bytesRead), record);
        if (next.offset === e.offset) break; // only an unfinished line left
        e = next;
      }
    } finally { await fh.close(); }
  }
  _compactionScans.delete(tpath); // re-insert: the Map's order is then least-recent first
  _compactionScans.set(tpath, e);
  if (_compactionScans.size > COMPACTION_SCANS_MAX) _compactionScans.delete(_compactionScans.keys().next().value);
}

// Background commands still RUNNING in this session (#background-work badge).
//
// A session's status tracks the AGENT'S TURN, not the work inside it: Claude's
// `run_in_background` returns the moment the command is launched, so PostToolUse fires
// at once, the turn ends, Stop flips the session to idle — and the dot is green while a
// build runs. Reported live on Office. The dot is left alone on purpose (the agent
// really IS idle); this is the separate fact it cannot carry.
//
// Derived from the transcript, which records both ends, so no new hook and no worker
// change — server-only, hot-reloadable. #443: read INCREMENTALLY. The file only ever
// grows, so each read feeds just the bytes appended since the last one into a scanner
// that keeps its state (lib/background-tasks.js createBackgroundScanner), and an
// unchanged size costs one stat. A fixed 256KB tail used to be re-read instead, and it
// missed the launch of much of the work that later woke a session (measured: the launch
// sat further back than 256KB for 23% of subagent wakes, 45% of monitor events and 81% of
// cron fires; 1MB still missed 4-11%). The first read of a file takes its last
// BG_TASKS_FIRST_READ bytes; after that nothing scrolls out while the server runs.
const _bgTasksCache = new Map(); // session id -> { path, size, scanner, circling, carry, guard, tasks, checkedAt }
/** #468 R9 - the failure session [id] keeps hitting, from its last transcript read, or null. */
function sessionCircling(id) {
  const hit = _bgTasksCache.get(id);
  return hit && hit.circling ? hit.circling.field(Date.now()) : null;
}
/** #468 - the fields both session shapers publish for the Supervisor: R9's evidence (the
 *  failure this session keeps hitting, from the read that found its background work; null
 *  when nothing repeats) and, for the dispatcher's own session, `role: 'supervisor'` so
 *  clients show it apart from the list. */
function supervisorRowFields(s) {
  const id = s.id;
  // #470 - R7's fact, only when there is one (a running agent's row is unchanged).
  const gone = sessionAgentGone(s);
  // #479 - a person's unsent draft nobody is typing: the supervisor's Journal lists it under Needs you.
  const draft = gone ? null : composerDraftField(id); // a shell's line is no agent's draft
  return { circling: sessionCircling(id), ...(gone ? { agentGone: gone } : {}), ...(isDispatcherSession(id) ? { role: 'supervisor' } : {}),
    ...(draft ? { composerDraft: draft } : {}) };
}

// --- #470 R7: does the session's agent still run? -------------------------------------------
// SEEN = its process (lib/agents.js agentExit.process) was under the session's PTY in a process
// snapshot. Remembered in memory only: a reload re-learns it, and judges nobody dead meanwhile.
// Gone after being seen is a death unless the agent's exit hook (SessionEnd) stands on the brief
// - and only while that hook is installed, or every deliberate exit would read as a death. The
// rule is lib/replacement.js agentGoneField; this is the I/O.
const _agentSeen = new Map(); // session id -> { pid, at }: the shell it was seen under, and that snapshot's time
const _lastHookAt = new Map(); // session id -> epoch ms of its last hook on this server (foldBriefHook)
const _agentFoundForTests = new Map(); // WT_TEST only (POST /api/test/agent-process): id -> true | false
const _exitHookCache = new Map(); // settings path -> { checkedAt, mtimeMs, value }
/** Is [policy]'s exit hook installed for web-terminal (scripts/install-hooks.js) in the agent's
 *  settings file? Stat at most every 30 s, re-read only when the file changed. */
function agentExitHooked(policy) {
  const file = path.join(process.env.WT_AGENT_SETTINGS_DIR || transcriptHome(), ...policy.settingsFile);
  const now = Date.now();
  let e = _exitHookCache.get(file);
  if (e && now - e.checkedAt < 30000) return e.value;
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* absent: not installed */ }
  if (!e || e.mtimeMs !== mtimeMs) {
    let value = false;
    try {
      value = mtimeMs !== null && replacementLib.exitHookInstalled(JSON.parse(fs.readFileSync(file, 'utf8')), policy.hookEvent, isWtHook);
    } catch { /* unreadable: not known to be installed */ }
    e = { value, mtimeMs };
  }
  e.checkedAt = now;
  _exitHookCache.set(file, e);
  return e.value;
}
/** Remember [id] in a bounded insertion-ordered map: re-inserted last, the oldest dropped. */
function rememberBounded(map, id, value) {
  map.delete(id);
  map.set(id, value);
  if (map.size > 500) map.delete(map.keys().next().value);
}
/** What this server can say about worker row [s]'s agent: `{state: running|gone|unknown, gone}`
 *  (lib/replacement.js agentState). A sighting counts only for the shell it was made under, and
 *  is stamped with its snapshot's time, so an older snapshot never reads as a death. */
function sessionAgentState(s) {
  const unknown = { state: 'unknown', gone: null };
  try {
    const policy = agentsLib.agentExitPolicy(s && s.agent);
    if (!policy || !s.id) return unknown;
    let found = null;
    let snapAt = null;
    if (process.env.WT_TEST === '1' && _agentFoundForTests.has(s.id)) {
      found = _agentFoundForTests.get(s.id);
      snapAt = Date.now();
    } else if (Number.isFinite(s.pid) && process.platform === 'win32') {
      const snap = processTree.snapshotNoWaitAt();
      if (snap) {
        found = Boolean(processTree.newestDescendantNamed(snap.procs, s.pid, policy.process));
        snapAt = snap.at;
      }
    }
    const prev = _agentSeen.get(s.id);
    const seenAt = prev && prev.pid === s.pid ? prev.at : null;
    if (found === true) {
      if (!(Number.isFinite(seenAt) && seenAt >= snapAt)) rememberBounded(_agentSeen, s.id, { pid: s.pid, at: snapAt });
      return { state: 'running', gone: null };
    }
    const ended = (getBriefEntry(s.id) || {}).agentEnded || null;
    return replacementLib.agentState({ found, snapAt, seenAt, hookAt: _lastHookAt.get(s.id), hooked: agentExitHooked(policy),
      endedAt: ended && ended.at, endReason: ended && ended.reason });
  } catch { return unknown; }
}
/** The `agentGone` field for worker row [s], or null (running, never seen, cannot tell). */
function sessionAgentGone(s) {
  return sessionAgentState(s).gone;
}
const BG_TASKS_FIRST_READ = 2 * 1024 * 1024;
// The bytes just before the read offset, re-checked on the next read: if they changed, the
// file was rewritten rather than appended to, and the scan starts over.
const BG_TASKS_GUARD = 64;
const BG_TASKS_CACHE_MAX = 200;
/** Re-insert [id] so the Map's order is least-recently READ first, then trim the oldest:
 *  entries outlive their sessions, and only the ones still being read are worth keeping. */
function touchBgCache(id, entry) {
  _bgTasksCache.delete(id);
  _bgTasksCache.set(id, entry);
  if (_bgTasksCache.size > BG_TASKS_CACHE_MAX) _bgTasksCache.delete(_bgTasksCache.keys().next().value);
}
// A size check alone is not enough of a brake: an ACTIVE session's transcript grows on
// every poll, so "re-read when it grew" means a 256KB synchronous read per poll per
// session on the list path. A background command lasts minutes, so re-scanning at most
// this often costs nothing in accuracy and bounds the I/O.
const BG_TASKS_MIN_INTERVAL_MS = 3000;
// Stuck-badge backstop: a launch whose finish never reached the transcript (Claude Code
// died mid-command) would otherwise show as running forever. Long enough that no real
// build is cut off, short enough that a stranded entry does not outlive the day.
// Overridable so a test can watch a stranded launch actually expire instead of waiting
// six hours for it — the same lever WT_NOTIFY_FAST pulls on the push debounces.
const BG_TASKS_MAX_AGE_MS =
  parseInt(process.env.WT_BG_TASK_MAX_AGE_MS, 10) > 0
    ? parseInt(process.env.WT_BG_TASK_MAX_AGE_MS, 10)
    : 6 * 60 * 60 * 1000;

// Age is a property of NOW, not of the scan — so it is applied on EVERY return, cache
// hits included. That distinction is the whole bug: the size cache short-circuits while
// the transcript is unchanged, and a launch that was never finished is BY DEFINITION one
// whose transcript stopped growing (Claude Code died holding it). So the backstop was
// evaluated exactly once, at the scan that first saw the launch — when it was minutes
// old and rightly kept — and never again. Observed on Home: "Full server suite with the
// running-shell detection", launched 2026-07-29 12:55Z, still badged as running 16 hours
// later beside an idle session with nothing whatsoever alive in it. Filtering here means
// a cached answer can only ever shrink with time; growing it still requires a rescan,
// which is exactly what a new launch causes.
function freshBackgroundTasks(tasks) {
  const now = Date.now();
  // #443: an entry with a KNOWN end (`until`, already applied by readBackgroundTasks) is
  // not aged: a recurring cron created 8 hours ago and still firing is live.
  return tasks.filter(t => Number.isFinite(t.until) || !t.startedAt || (now - t.startedAt) < BG_TASKS_MAX_AGE_MS);
}

// A shell command running in the session RIGHT NOW, which the transcript cannot
// see: `run_in_background` is recorded, an ordinary tool call is not. Measured on
// Office — "sanity 147" reported idle with an empty badge while a real
// powershell.exe was alive under its agent (it exited minutes later).
//
// Cost is the whole design here. Windows 11 has no wmic, so a snapshot means
// spawning PowerShell (~1s). Two things keep that off the hot path: it is asked
// for ONLY when a session is showing green (a working/waiting session already
// reads as busy, so the answer would change nothing), and processTree.snapshot()
// is cached for 15s AND shares one in-flight query across the whole list — so a
// poll costs at most one spawn per 15s no matter how many sessions there are,
// and nothing at all while every session is busy or nobody is polling.
//
// #280: and the poll never WAITS for that spawn. On office-tests PowerShell hung at
// startup, snapshot() took 25s, and a failed query is not cached, so every
// GET /api/sessions waited out a fresh hung one. snapshotNoWait() serves the last
// good snapshot and refreshes behind it; the badge may lag one poll, the list never.
const GREEN_STATUSES = new Set(['idle', 'active']);

async function sessionRunningShells(s) {
  // No agent, no answer — and therefore no snapshot. runningShellsUnder needs an
  // agent process to subtract the login chain from, so a plain shell session can
  // never report anything; taking a snapshot on its behalf would be pure cost.
  // This gate is load-bearing beyond tidiness: without it the test suite (whose
  // sessions are all agent-less) span a PowerShell every 15s and that CPU was
  // enough to tip two timing-sensitive worker tests over.
  if (!s.agent) return [];
  if (!GREEN_STATUSES.has(s.status)) return [];
  if (!Number.isFinite(s.pid)) return [];
  try {
    const procs = processTree.snapshotNoWait();
    if (!procs) return []; // non-Windows, no good snapshot yet, too old, or the query failed — "cannot tell"
    return processTree.runningShellsUnder(procs, s.pid, agentsLib.mcpLaunchFor(s.agent));
  } catch {
    return [];
  }
}

/** Every launch the transcript still shows as running, UNAGED. Throws on a read failure - the
 *  badge below turns that into "nothing", the spawn reaper into "cannot tell" (#351). A
 *  session whose agent has no transcript channel, or that has no transcript yet, has none. */
async function readBackgroundTasks(s) {
  if (!agentsLib.hasBackgroundTasksInTranscript(s.agent)) return [];
  const tpath = await resolveSessionTranscriptPath(s.id);
  if (!tpath) return [];
  let hit = _bgTasksCache.get(s.id);
  const now = Date.now();
  // A known end (a wake-up's fire time, a monitor's timeout) is a property of NOW, so it is
  // applied on every return, cached or not - the same lesson as the age backstop above.
  // Every read refreshes the entry's place in the cap's order, cache hits included: a long-idle
  // session's transcript never grows, and evicting it would lose a launch older than a first read.
  if (hit && hit.path === tpath) touchBgCache(s.id, hit);
  if (hit && hit.path === tpath && (now - hit.checkedAt) < BG_TASKS_MIN_INTERVAL_MS) return notEndedTasks(hit.tasks, now);
  const size = fs.statSync(tpath).size;
  if (hit && hit.path === tpath && hit.size === size) {
    hit.checkedAt = now;
    return notEndedTasks(hit.tasks, now);
  }

  const fd = fs.openSync(tpath, 'r');
  try {
    // Carry on from the last read only when the file GREW and the bytes just before the
    // old end are still the ones we read; anything else (a new path, a rewrite, a jump
    // bigger than a first read) starts over from a fresh scanner.
    let from = -1;
    if (hit && hit.path === tpath && size > hit.size && size - hit.size <= BG_TASKS_FIRST_READ) {
      const g = Buffer.alloc(hit.guard.length);
      if (g.length) fs.readSync(fd, g, 0, g.length, hit.size - g.length);
      if (g.equals(hit.guard)) from = hit.size;
    }
    let fresh = false;
    if (from < 0) {
      hit = { path: tpath, size: 0, scanner: createBackgroundScanner(), circling: createCirclingScanner(), carry: Buffer.alloc(0), guard: Buffer.alloc(0), tasks: [], checkedAt: 0 };
      from = Math.max(0, size - BG_TASKS_FIRST_READ);
      fresh = from > 0;
    }
    const added = Buffer.alloc(size - from);
    if (added.length) fs.readSync(fd, added, 0, added.length, from);
    // Bytes, not text, until a line is whole: a read can end inside a UTF-8 character.
    let bytes = hit.carry.length ? Buffer.concat([hit.carry, added]) : added;
    // Drop the partial first line a tail always starts with.
    if (fresh) { const nl = bytes.indexOf(10); bytes = nl >= 0 ? bytes.subarray(nl + 1) : Buffer.alloc(0); }
    // A line still being written is held back until its newline arrives.
    const lastNl = bytes.lastIndexOf(10);
    // Bounded: a transcript writes whole lines, so a "line" this long is not one to scan.
    hit.carry = bytes.length - lastNl - 1 > BG_TASKS_FIRST_READ ? Buffer.alloc(0) : Buffer.from(bytes.subarray(lastNl + 1));
    if (lastNl >= 0) {
      const text = bytes.toString('utf8', 0, lastNl);
      hit.scanner.feed(text);
      // #468 R9 - the same lines, read once, also count repeated failures (lib/circling.js).
      if (hit.circling) hit.circling.feed(text);
    }
    hit.guard = Buffer.alloc(Math.min(BG_TASKS_GUARD, size));
    if (hit.guard.length) fs.readSync(fd, hit.guard, 0, hit.guard.length, size - hit.guard.length);
    hit.size = size;
  } finally { fs.closeSync(fd); }
  // Cache what the TRANSCRIPT says, unfiltered: the entry outlives many polls, so
  // baking a moment's freshness verdict into it is what froze the badge before.
  hit.tasks = hit.scanner.running();
  hit.checkedAt = Date.now();
  touchBgCache(s.id, hit);
  return notEndedTasks(hit.tasks, now);
}

async function sessionBackgroundTasks(s) {
  try {
    return freshBackgroundTasks(await readBackgroundTasks(s));
  } catch {
    return []; // never let a badge break the session list
  }
}

// Everything running in this session, from BOTH sources, in the one field the
// clients already render: commands Claude launched in the background (the
// transcript knows those) and shell commands alive right now (only the process
// tree knows those). Merged deliberately rather than added as a second field —
// to a reader they are the same fact, "work is running here", and merging means
// no client release was needed to surface the second source.
async function sessionRunningWork(s) {
  const [tasks, shells] = await Promise.all([
    sessionBackgroundTasks(s).catch(() => []),
    sessionRunningShells(s).catch(() => []),
  ]);
  // A backgrounded command IS a shell process, so a session running one would
  // otherwise be counted twice — once from the transcript, once from the tree.
  // The transcript entry is the better one (it carries the real description), so
  // the tree only contributes when the transcript found nothing.
  if (tasks.length) return tasks;
  // #313: the shell's own start time, so the chip can show an age, and a shell that
  // has outlived any turn by hours is MARKED stale rather than read as a live build.
  // Marked, not dropped: it is still a real process, and the user may want to kill it.
  const now = Date.now();
  return shells.map((sh) => {
    const startedAt = Number.isFinite(sh.startMs) ? sh.startMs : null;
    return {
      id: 'proc-' + sh.pid,
      description: 'shell command',
      startedAt,
      ...(startedAt && now - startedAt > BG_TASKS_MAX_AGE_MS ? { stale: true } : {}),
    };
  });
}

// WHICH conversation a session is currently showing, as an id both clients can compare.
//
// A client caches a transcript and needs to know when to throw that cache away. Claude
// gave it `claudeSessionId`, which changes on /clear — that is how the companion knows
// to reload (conversation_view didUpdateWidget, #35). Codex had no such field, so when
// the server legitimately started serving a DIFFERENT rollout, the companion had nothing
// to notice: it kept yesterday's turns beside a live terminal. Same missing fact the
// server itself lacked in 1.45.1, one layer up.
//
// Claude answers from the session (no disk). Any other agent derives it from its resolved
// transcript path — already resolved and memoised by sessionMetrics() on this same poll,
// so this adds a Map lookup, not a rollouts walk. A plain shell never touches the disk.
async function sessionConversationId(s) {
  if (s.claudeSessionId) return s.claudeSessionId;
  const adapter = getAdapter(s.agent);
  if (!s.agent || typeof adapter.conversationIdFromPath !== 'function') return null;
  const tpath = await resolveSessionTranscriptPath(s.id);
  return tpath ? agentsLib.conversationIdFromPath(s.agent, tpath) : null;
}

// 64kb, not 16kb: the body is now the WHOLE statusline payload (~1.2kb typically), and
// its size is not fully under our control — `workspace.added_dirs` and the repo block grow
// with the session. A 413 here fails silently (the pusher is deliberately quiet), which
// would look exactly like "metrics stopped working" with nothing in the log to say why.
// Still bounded — this is a localhost-only route, not an open upload.
// Codex reporting which conversation it is running, for which session.
//
// Localhost-only and unauthenticated, exactly like /api/claude-status: the reporter is a
// program Codex spawns on this machine, which has no credentials to present. Both facts
// it sends are already local knowledge — WT_SESSION_ID came from this server's own PTY
// environment, and the conversation id is a filename on this disk — so the route can
// only ever re-state something a local process already had.
app.post('/api/codex-session', express.json({ limit: '8kb' }), (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
  const conversationId = typeof b.conversationId === 'string' ? b.conversationId : '';
  // Both are used to build/compare filesystem paths downstream, so both are shape-checked
  // here rather than trusted — a UUID cannot contain a path separator.
  if (!_HOOK_UUID_RE.test(sessionId) || !_HOOK_UUID_RE.test(conversationId)) {
    return res.json({ ok: true, skipped: 'bad ids' });
  }
  if (_codexOwnership.get(sessionId) !== conversationId) {
    _codexOwnership.set(sessionId, conversationId);
    saveCodexOwnershipSoon();
    // A session moving to a new conversation invalidates the cached transcript path,
    // exactly as /clear does for Claude — without this the lens keeps serving the old
    // one until the discovered-path TTL happens to expire.
    const st = _notifyState.get(sessionId);
    if (st) { st.transcriptPath = ''; st.transcriptAt = 0; }
    console.log(`codex session ${sessionId} -> conversation ${conversationId}`);
  }
  res.json({ ok: true });
});

app.post('/api/claude-status', express.json({ limit: '64kb' }), (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  // Self-describing contract. scripts/install-statusline.js must know, BEFORE it points
  // this machine's status line at the raw-payload pusher, whether this server can read
  // one — and /api/version is behind auth, while this route is localhost-only and
  // unauthenticated. So the route that owns the contract reports it, on every reply: a
  // bare probe POST (no session_id) stores nothing and answers `accepts: 'raw'`.
  const sid = typeof b.session_id === 'string' ? b.session_id : '';
  if (!sid) return res.json({ ok: true, accepts: 'raw', skipped: 'no session_id' });
  // What every field of a status report MEANS lives in lib/metrics-claude.js, which
  // accepts BOTH the raw statusline payload scripts/wt-push-status.sh forwards and the
  // legacy flat push an un-updated machine still sends. This route only decides WHEN a
  // report is stored, never what it says.
  //
  // #69 — `fiveHResetAt` is no longer stubbed null here. It was stubbed on the belief
  // that Claude's push carried no reset time; a captured payload proved otherwise
  // (rate_limits.five_hour.resets_at, the same epoch-seconds field Codex reports), so the
  // worker's auto-resume timer now arms for Claude sessions with no per-agent change.
  const parsed = parseStatusPayload(b);
  if (!parsed) return res.json({ ok: true, skipped: 'unparseable' });
  const prev = claudeStatusMetrics.get(sid);
  const merged = mergeStatus(prev, parsed);
  // A report with no live reading (documented: before the first API call, and in the gap
  // right after /compact) must not stamp itself as the freshest truth — it would blank a
  // good reading and reset its age to now. Its STABLE fields still land, which is how the
  // context window survives a /compact. See mergeStatus.
  claudeStatusMetrics.set(sid, {
    ...merged,
    ts: hasReading(parsed) || !prev ? Date.now() : prev.ts,
  });
  if (claudeStatusMetrics.size > 200) pruneStatusMetrics();
  writeClaudeMetricsSoon();
  try { // #483 - the weekly reading, for the account auto-switch; never into the request path
    autoSwitchNoteReport(sid, parsed, usageLog.costFields(b), Date.now());
    considerAutoSwitch();
  } catch (e) { console.error(`[account-autoswitch] ${e.message}`); }
  try { // #425 - best effort; a cost line must never fail the report
    const cost = usageLog.costFields(b);
    const nowMs = Date.now();
    if (usageLog.shouldLogCost(_costLogged.get(sid), cost, nowMs)) {
      _costLogged.set(sid, { at: nowMs, usd: cost.total_cost_usd });
      if (_costLogged.size > 500) _costLogged.delete(_costLogged.keys().next().value);
      usageLog.appendRecord(SESSION_COST_FILE, usageLog.costRecord(
        { id: _wtIdByAgentSid.get(sid), agentSessionId: sid, cost, parsed, body: b }, nowMs));
    }
  } catch { /* never into the request path */ }
  res.json({ ok: true, accepts: 'raw' });
});

// --- Peer relay (Claude <-> Codex mediator) ---
// Localhost-only message bus so two agents running in separate PTY sessions
// on this host can ask each other for second opinions. State is in-memory
// and resets on server reload (which the protocol doc warns about).
// Rate limits exist to stop runaway back-and-forth burning tokens overnight.
const RELAY_MAX_TURNS = Math.max(1, parseInt(process.env.WT_RELAY_MAX_TURNS_PER_CONV, 10) || 6);
const RELAY_DAILY_MAX = Math.max(1, parseInt(process.env.WT_RELAY_DAILY_MAX, 10) || 50);
const RELAY_MAX_MSG_BYTES = Math.max(256, parseInt(process.env.WT_RELAY_MAX_MSG_BYTES, 10) || 16384);
const RELAY_LONGPOLL_MAX_MS = Math.max(1000, parseInt(process.env.WT_RELAY_LONGPOLL_MAX_MS, 10) || 30000);
const RELAY_QUEUE_MAX = Math.max(10, parseInt(process.env.WT_RELAY_QUEUE_MAX, 10) || 100);
const RELAY_CONV_IDLE_MS = 60 * 60 * 1000; // drop conversation records after 1h idle

// Per-agent inbox: each conversation is buffered until the asker closes it
// with more=false. A conv is "ready" once its last message has more=false.
// recv only returns messages from ready convs (so batched asks are delivered
// as one unit and the answerer doesn't reply mid-batch).
const _relayBoxes = new Map();       // agent -> { convs: Map<conv_id, {messages:[], ready:bool}>, waiters: [] }
const _relayConvs = new Map();       // conv_id -> { turns, lastTs, participants: Set }
let _relayDay = '';
let _relayDayUsed = 0;

function _relayToday() { return new Date().toISOString().slice(0, 10); }
function _relayCheckDay() {
  const today = _relayToday();
  if (today !== _relayDay) { _relayDay = today; _relayDayUsed = 0; }
}
function _relayBox(agent) {
  let box = _relayBoxes.get(agent);
  if (!box) { box = { convs: new Map(), waiters: [] }; _relayBoxes.set(agent, box); }
  return box;
}
function _relayBoxTotal(box) {
  let n = 0;
  for (const c of box.convs.values()) n += c.messages.length;
  return n;
}
function _relayBoxHasReady(box, convFilter) {
  for (const [id, c] of box.convs) {
    if (!c.ready) continue;
    if (convFilter && id !== convFilter) continue;
    return true;
  }
  return false;
}
function _relayDrain(box, convFilter) {
  const out = [];
  for (const [id, c] of [...box.convs]) {
    if (!c.ready) continue;
    if (convFilter && id !== convFilter) continue;
    for (const m of c.messages) out.push(m);
    box.convs.delete(id);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}
function _relayCleanConvs() {
  const now = Date.now();
  for (const [id, c] of _relayConvs) {
    if (now - c.lastTs > RELAY_CONV_IDLE_MS) _relayConvs.delete(id);
  }
}
function _relayValidAgent(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_.-]{1,32}$/.test(name);
}

app.post('/api/relay/send', express.json({ limit: '64kb' }), (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { from, to, message } = req.body || {};
  let conv_id = req.body?.conv_id;
  const more = req.body?.more === true; // true = batch open, withhold delivery; false/missing = ready to deliver
  if (!_relayValidAgent(from)) return res.status(400).json({ error: 'invalid from' });
  if (!_relayValidAgent(to)) return res.status(400).json({ error: 'invalid to' });
  if (from === to) return res.status(400).json({ error: 'from and to must differ' });
  if (typeof message !== 'string' || !message.length) return res.status(400).json({ error: 'message required' });
  if (Buffer.byteLength(message, 'utf8') > RELAY_MAX_MSG_BYTES) {
    return res.status(413).json({ error: 'message too large', max_bytes: RELAY_MAX_MSG_BYTES });
  }

  _relayCheckDay();
  if (_relayDayUsed >= RELAY_DAILY_MAX) {
    return res.status(429).json({
      error: 'daily-cap',
      daily_max: RELAY_DAILY_MAX,
      daily_used: _relayDayUsed,
      resets_at: _relayToday() + 'T24:00:00Z',
    });
  }

  let conv;
  if (conv_id) {
    if (typeof conv_id !== 'string' || conv_id.length > 64) return res.status(400).json({ error: 'invalid conv_id' });
    conv = _relayConvs.get(conv_id);
    if (!conv) return res.status(404).json({ error: 'conv not found (it may have expired)' });
    if (conv.turns >= RELAY_MAX_TURNS) {
      return res.status(429).json({
        error: 'conv-cap',
        conv_id,
        turns: conv.turns,
        max_turns: RELAY_MAX_TURNS,
        hint: 'this conversation hit its turn cap; start a new conv_id only if a fresh question is justified',
      });
    }
  } else {
    conv_id = crypto.randomUUID();
    conv = { turns: 0, lastTs: Date.now(), participants: new Set() };
    _relayConvs.set(conv_id, conv);
  }
  conv.turns += 1;
  conv.lastTs = Date.now();
  conv.participants.add(from);
  conv.participants.add(to);
  _relayDayUsed += 1;

  const box = _relayBox(to);
  // Bound total per-agent buffered messages: drop oldest from the largest buffered conv.
  if (_relayBoxTotal(box) >= RELAY_QUEUE_MAX) {
    let victim = null, victimSize = -1;
    for (const [id, c] of box.convs) {
      if (c.messages.length > victimSize) { victim = id; victimSize = c.messages.length; }
    }
    if (victim) {
      const c = box.convs.get(victim);
      c.messages.shift();
      if (c.messages.length === 0) box.convs.delete(victim);
    }
  }
  const entry = { conv_id, from, to, message, ts: Date.now(), turn: conv.turns, more };
  let cbuf = box.convs.get(conv_id);
  if (!cbuf) { cbuf = { messages: [], ready: false }; box.convs.set(conv_id, cbuf); }
  cbuf.messages.push(entry);
  cbuf.ready = !more;

  if (cbuf.ready) {
    // Wake a waiter that's interested in this conv (or any conv).
    for (let i = 0; i < box.waiters.length; i++) {
      const w = box.waiters[i];
      if (!w.convFilter || w.convFilter === conv_id) {
        box.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve();
        break;
      }
    }
  }

  res.json({
    ok: true,
    conv_id,
    turn: conv.turns,
    more,
    buffered: cbuf.messages.length,
    remaining_turns: Math.max(0, RELAY_MAX_TURNS - conv.turns),
    daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed),
  });
});

app.get('/api/relay/recv', (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  const agent = String(req.query.agent || '');
  if (!_relayValidAgent(agent)) return res.status(400).json({ error: 'invalid agent' });
  const convFilter = req.query.conv_id ? String(req.query.conv_id) : null;
  const waitMsRaw = parseInt(req.query.wait, 10);
  const waitMs = isNaN(waitMsRaw) ? 0 : Math.min(Math.max(0, waitMsRaw * 1000), RELAY_LONGPOLL_MAX_MS);
  _relayCheckDay();
  _relayCleanConvs();
  const box = _relayBox(agent);

  const immediate = _relayDrain(box, convFilter);
  if (immediate.length || waitMs === 0) {
    return res.json({ messages: immediate, daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed) });
  }

  const waiter = { convFilter };
  const p = new Promise((resolve) => { waiter.resolve = resolve; });
  waiter.timer = setTimeout(() => {
    const idx = box.waiters.indexOf(waiter);
    if (idx >= 0) box.waiters.splice(idx, 1);
    waiter.resolve();
  }, waitMs);
  if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
  box.waiters.push(waiter);
  req.on('close', () => {
    clearTimeout(waiter.timer);
    const idx = box.waiters.indexOf(waiter);
    if (idx >= 0) box.waiters.splice(idx, 1);
  });
  p.then(() => {
    if (res.writableEnded) return;
    const msgs = _relayDrain(box, convFilter);
    res.json({ messages: msgs, daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed) });
  });
});

app.get('/api/relay/status', (req, res) => {
  if (!isLocalhostReq(req)) return res.status(401).json({ error: 'Unauthorized' });
  _relayCheckDay();
  _relayCleanConvs();
  const queues = Object.create(null); // null-proto so a hostile agent name (e.g. __proto__) cannot pollute it
  for (const [name, box] of _relayBoxes) {
    let total = 0, ready = 0, pending = 0;
    for (const c of box.convs.values()) {
      total += c.messages.length;
      if (c.ready) ready += c.messages.length; else pending += c.messages.length;
    }
    queues[name] = { total, ready, pending, waiters: box.waiters.length };
  }
  const convs = [];
  for (const [id, c] of _relayConvs) {
    convs.push({ conv_id: id, turns: c.turns, max_turns: RELAY_MAX_TURNS, participants: [...c.participants], last_ts: c.lastTs });
  }
  res.json({
    limits: {
      max_turns_per_conv: RELAY_MAX_TURNS,
      daily_max: RELAY_DAILY_MAX,
      max_msg_bytes: RELAY_MAX_MSG_BYTES,
      longpoll_max_ms: RELAY_LONGPOLL_MAX_MS,
      queue_max: RELAY_QUEUE_MAX,
    },
    day: _relayDay || _relayToday(),
    daily_used: _relayDayUsed,
    daily_remaining: Math.max(0, RELAY_DAILY_MAX - _relayDayUsed),
    queues,
    conversations: convs,
  });
});

// --- Auth middleware ---
app.use((req, res, next) => {
  // Try cookie auth
  const cookies = parseCookies(req.headers.cookie);
  if (verifySessionToken(cookies[COOKIE_NAME])) {
    // Refresh cookie so active users stay logged in
    setAuthCookie(res, _USER);
    // Force password change if still using default
    if (needsPasswordChange() && req.path !== '/api/setup') {
      return res.send(SETUP_PAGE);
    }
    req._wtAuth = { mode: 'cookie', identity: `cookie:${_USER}`, label: _USER };
    return next();
  }
  // Try Bearer token auth (for cluster/API access)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (verifyApiToken(token)) {
      const tok = loadApiTokens()[token];
      req._wtAuth = { mode: 'bearer', identity: `bearer:${token}`, label: (tok && tok.label) || 'bearer' };
      return next();
    }
  }
  // Try query-string token (for WebSocket upgrades through cluster proxy)
  const qToken = req.query?.token;
  if (qToken && verifyApiToken(qToken)) {
    const tok = loadApiTokens()[qToken];
    req._wtAuth = { mode: 'bearer', identity: `bearer:${qToken}`, label: (tok && tok.label) || 'bearer' };
    return next();
  }
  // Issue #20: direct-mode WS — let the /ws/:id handler validate the `dt`
  // token itself (it knows the :id to verify against). We defer here to
  // avoid parsing the token twice. Only applies to /ws/ paths with ?dt=.
  if (req.path.startsWith('/ws/') && req.query?.dt) return next();
  // API/cluster/WS routes return 401, pages redirect to login
  if (req.path.startsWith('/api/') || req.path.startsWith('/cluster/') || req.path.startsWith('/ws/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login');
});

const SETUP_PAGE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Terminal — Setup</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; color: #e0e0e0; font-family: 'Segoe UI', sans-serif;
    display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; }
  .setup { background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 32px;
    width: 400px; max-width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
  h1 { color: #00d4aa; font-size: 22px; margin-bottom: 8px; }
  p { color: #888; font-size: 14px; margin-bottom: 20px; }
  .warn { background: #3a2a1a; border: 1px solid #da4; border-radius: 6px; padding: 10px 14px;
    color: #da4; font-size: 13px; margin-bottom: 20px; }
  label { display: block; color: #888; font-size: 12px; margin-bottom: 4px; margin-top: 14px; }
  input { width: 100%; background: #1a1a2e; color: #e0e0e0; border: 1px solid #0f3460;
    padding: 10px 14px; border-radius: 6px; font-size: 15px; }
  input:focus { border-color: #00d4aa; outline: none; }
  .btn { width: 100%; margin-top: 20px; padding: 12px; border: none; border-radius: 6px;
    background: #00d4aa; color: #1a1a2e; font-size: 16px; font-weight: 600; cursor: pointer; }
  .btn:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .error { color: #e94560; font-size: 13px; margin-top: 10px; display: none; }
  .req { color: #666; font-size: 11px; margin-top: 6px; }
</style>
</head><body>
<div class="setup">
  <h1>Set Your Password</h1>
  <p>You're using the default password. Please set a secure password before continuing.</p>
  <div class="warn">Default credentials are publicly known. Change your password now to secure your terminal.</div>
  <form id="form" onsubmit="return save(event)">
    <label>New Username</label>
    <input id="user" value="admin" autocomplete="username">
    <label>New Password</label>
    <input id="pass" type="password" required minlength="6" autocomplete="new-password" placeholder="Min 6 characters">
    <label>Confirm Password</label>
    <input id="pass2" type="password" required minlength="6" autocomplete="new-password" placeholder="Repeat password">
    <div class="req">Minimum 6 characters</div>
    <div id="error" class="error"></div>
    <button type="submit" class="btn">Save &amp; Continue</button>
  </form>
</div>
<script>
async function save(e) {
  e.preventDefault();
  const err = document.getElementById('error');
  const user = document.getElementById('user').value.trim();
  const pass = document.getElementById('pass').value;
  const pass2 = document.getElementById('pass2').value;
  if (!user) { err.textContent = 'Username is required'; err.style.display = 'block'; return; }
  if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters'; err.style.display = 'block'; return; }
  if (pass !== pass2) { err.textContent = 'Passwords do not match'; err.style.display = 'block'; return; }
  err.style.display = 'none';
  const btn = document.querySelector('.btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password: pass })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = 'Saved! Redirecting...';
      location.href = '/logout';
    } else {
      err.textContent = data.error || 'Failed to save';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Save & Continue';
    }
  } catch(e) {
    err.textContent = 'Connection error';
    err.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Save & Continue';
  }
}
</script>
</body></html>`;

app.post('/api/setup', express.json(), (req, res) => {
  if (!needsPasswordChange()) {
    return res.status(403).json({ error: 'Password already set' });
  }
  const { user, password } = req.body || {};
  if (!user || typeof user !== 'string' || user.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (DEFAULT_PASSWORDS.includes(password)) {
    return res.status(400).json({ error: 'Please choose a different password' });
  }

  // #264 - THE SAME GUARD AS `PUT /api/config`, ON THE ONE ROUTE A CORRUPT CONFIG OPENS.
  //
  // A `config.json` that exists but will not parse throws inside the FIRST branch of the
  // startup load, so the `config.default.json` fallback is never reached and `config` stays
  // `{}` - which takes `PASS` to the `'admin'` literal and makes `needsPasswordChange()`
  // true on an ESTABLISHED server. That is the gate above, so a corrupt file is exactly
  // what opens this route. Writing here would then replace the file with
  // `{user, password}` alone: cluster, publicUrl and every other setting gone.
  //
  // SAY WHAT THE CALLER ACTUALLY NEEDS, because the first draft of this comment said
  // "anybody who can reach the port" and "a caller who never authenticated", and both are
  // false. The auth middleware exempts `/api/setup` only AFTER `verifySessionToken`
  // succeeds; without a cookie - or a valid API token, since the `Bearer` and `?token=`
  // branches below it also `next()` - the request never reaches this handler at all.
  // What makes it a real exposure is narrower and quite bad enough: THE CORRUPTION ISSUES THE
  // CREDENTIALS. `PASS` and `_USER` both fall back to `'admin'`, the startup banner prints
  // `Auth: admin:***`, and one login later the caller is inside. "Authenticated with the
  // default credentials the corruption just created" is the honest description - and the
  // wrong version contradicted this change's own spec and CLAUDE.md entry, which is worse
  // than being merely imprecise.
  //
  // Refusing leaves the server on its default password until an operator fixes the file by
  // hand, and that is the right trade rather than a regrettable one: the alternative hands
  // the server over AND destroys the settings, while this costs a manual repair of a file
  // that is already broken. The startup half - whether a corrupt config should drop a
  // running server to `'admin'` at all - is deliberately NOT addressed here; it is a
  // separate question about startup, and this is the write path, which is where the
  // destruction happens.
  //
  // ABSENT still writes, and that is the whole point of this route: a genuine first run has
  // no config.json at all. The test is on `ok`, never on the object being empty.
  const base = readConfigResult();
  if (!base.ok) {
    console.error(`POST /api/setup refused: ${CONFIG_FILE} exists but will not parse (${base.error})`);
    return res.status(500).json({
      error: 'config.json could not be read, so saving would delete every other setting on '
        + 'this server. Fix or remove the file on the server, then set up again.',
    });
  }

  // Hash and save
  const hashed = hashPassword(password);
  const cfg = base.config;
  cfg.user = user.trim();
  cfg.password = hashed;
  writeConfig(cfg);

  // Update running credentials
  PASS = hashed;
  // Need to update USER too — but it's const, so we use a module-level let
  _USER = user.trim();

  console.log(`[${new Date().toISOString()}] Password changed via setup (user: ${_USER})`);
  res.json({ ok: true });
});

// --- API: config ---
app.get('/api/config', (req, res) => {
  // Return full config (already behind auth)
  const current = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      Object.assign(current, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    }
  } catch (e) {}
  // Fill in running values
  current.port = current.port || PORT;
  current.user = current.user || _USER;
  current.password = current.password || PASS;
  current.shell = current.shell || SHELL;
  current.defaultCwd = current.defaultCwd || getDefaultCwd();
  current.scanFolders = current.scanFolders || getScanFolders();
  current.defaultCommand = current.defaultCommand || getDefaultCommand();
  current.openInNewTab = current.openInNewTab !== undefined ? current.openInNewTab : liveConfig('openInNewTab', true);
  current.serverName = current.serverName || getServerName();
  current.serverColor = current.serverColor || '';
  current.scrollbackReplayLimit = current.scrollbackReplayLimit || getScrollbackReplayLimit();
  current.cluster = current.cluster || [];
  current.publicUrl = current.publicUrl || '';
  current.claudeHome = current.claudeHome || '';
  current.keepSessionsOpen = current.keepSessionsOpen !== undefined ? current.keepSessionsOpen : true;
  current.autoContinueOnApiError = current.autoContinueOnApiError !== undefined ? current.autoContinueOnApiError : true;
  // #137 turned this ON by default (#69 had shipped it opt-in, and the `false` that stood
  // here never followed), so this endpoint was reporting a setting the server did not
  // have: the worker runs it as true and docs/CONFIGURATION.md documents true. #240 - and
  // because PUT replaces rather than merges, anything that echoes this object back writes
  // the misreport to disk, which is how it reached the suite's gitignored config.test.json.
  // One definition now, in the module that already owns every other auto-resume rule.
  current.autoResumeOnReset = current.autoResumeOnReset !== undefined
    ? current.autoResumeOnReset : usageLimit.AUTO_RESUME_ON_RESET_DEFAULT;
  // #190 — may the worker TYPE the answer to a recognised startup selector (Claude's
  // folder-trust dialog and its siblings)? Off unless the owner says otherwise; the
  // default is owned by lib/blocking-prompt.js, which the worker reads too, for the
  // reason the comment above this line records.
  current.autoAnswerBlockingPrompt = current.autoAnswerBlockingPrompt !== undefined
    ? current.autoAnswerBlockingPrompt : blockingPrompt.AUTO_ANSWER_BLOCKING_PROMPT_DEFAULT;
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['projects', 'port', 'host', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName', 'serverColor', 'scrollbackReplayLimit', 'cluster', 'publicUrl', 'claudeHome', 'keepSessionsOpen', 'autoContinueOnApiError', 'autoResumeOnReset', 'autoAnswerBlockingPrompt', 'exclusiveViewer'];

app.put('/api/config', express.json({ limit: '64kb' }), (req, res) => { // 64 KB since #503: room for a projects list
  try {
    // The config exactly as it is ON DISK. Both the password rule below and the merge
    // at the bottom need it, and they must see the same bytes, so it is read once.
    //
    // #257 - AND A MERGE NEEDS A BASE IT ACTUALLY READ. An unreadable config.json used
    // to arrive here as `{}`, indistinguishable from a first run, and the merge below
    // then wrote a file containing only this request's keys: #242's replace bug, back
    // again, on the one input where it does the most damage. Refusing is the honest
    // answer - the file is still on disk, unmodified, for a human to look at, and a
    // caller now gets a different status code instead of a 200 that lost the cluster.
    //
    // ABSENT still writes. A missing config.json is a real first-run state and an empty
    // merge base is the correct one for it, so the test is on `ok`, never on the object
    // being empty - checking for `{}` would refuse the first save this server ever makes.
    const base = readConfigResult();
    if (!base.ok) {
      console.error(`PUT /api/config refused: ${CONFIG_FILE} exists but will not parse (${base.error})`);
      return res.status(500).json({
        error: 'config.json could not be read, so saving would delete every setting this '
          + 'dialog does not show. Fix or remove the file on the server, then save again.',
      });
    }
    const existing = base.config;
    // Only allow known config keys
    const sanitized = {};
    for (const key of ALLOWED_CONFIG_KEYS) {
      if (req.body[key] !== undefined) sanitized[key] = req.body[key];
    }
    // If password is masked, preserve existing password; otherwise hash the new one
    if (sanitized.password === '***' || !sanitized.password) {
      sanitized.password = existing.password || PASS;
    } else if (!sanitized.password.startsWith('$scrypt$')) {
      sanitized.password = hashPassword(sanitized.password);
    }
    // Basic type validation
    if (sanitized.port !== undefined) sanitized.port = parseInt(sanitized.port) || 7681;
    if (sanitized.serverColor !== undefined && sanitized.serverColor !== '' && !validServerColor(sanitized.serverColor)) {
      return res.status(400).json({ error: 'serverColor must be a #rrggbb colour' });
    }
    if (sanitized.scanFolders && !Array.isArray(sanitized.scanFolders)) sanitized.scanFolders = [String(sanitized.scanFolders)];
    // #503 - Mission Control's projects: refused whole when any entry is malformed (lib/projects.js).
    if (sanitized.projects !== undefined) {
      const v = projectsLib.validateProjects(sanitized.projects);
      if (!v.ok) return res.status(400).json({ error: v.error });
      sanitized.projects = v.projects;
    }
    if (sanitized.openInNewTab !== undefined) sanitized.openInNewTab = !!sanitized.openInNewTab;
    if (sanitized.keepSessionsOpen !== undefined) sanitized.keepSessionsOpen = !!sanitized.keepSessionsOpen;
    if (sanitized.autoContinueOnApiError !== undefined) sanitized.autoContinueOnApiError = !!sanitized.autoContinueOnApiError;
    if (sanitized.autoResumeOnReset !== undefined) sanitized.autoResumeOnReset = !!sanitized.autoResumeOnReset;
    if (sanitized.autoAnswerBlockingPrompt !== undefined) sanitized.autoAnswerBlockingPrompt = !!sanitized.autoAnswerBlockingPrompt;
    if (sanitized.scrollbackReplayLimit !== undefined) sanitized.scrollbackReplayLimit = Math.max(10240, parseInt(sanitized.scrollbackReplayLimit) || 102400);
    // Compare restart-sensitive keys against running values
    const RESTART_KEYS = { port: PORT, host: config.host || '127.0.0.1', shell: SHELL };
    const needsRestart = Object.entries(RESTART_KEYS).some(
      ([k, running]) => sanitized[k] !== undefined && String(sanitized[k]) !== String(running)
    );
    // #242 - MERGE over what is on disk. A PUT must never REPLACE the file.
    //
    // Neither settings dialog round-trips the config it loaded; both build a FRESH
    // object from their form fields. `/lobby` sends 10 of the 18 keys above and `/app`
    // sends 15, so a replace silently deletes every key the dialog has no control for -
    // and a single Save from `/lobby` erases `cluster` and `publicUrl`, collapsing the
    // cluster to one node and duplicating this server's own sessions in every merged
    // list. Those two are live, real values on this fleet today.
    //
    // ONE owner, and it is this one (#242's first done-when says to pick one, not both).
    // A client-side merge would have to be written into every client, could not reach a
    // client already deployed, and - the part that actually decides it - would merge
    // over the object GET SERVES, which is SYNTHESIZED: `GET /api/config` fills a
    // running value in for every key the file omits, so echoing it back MATERIALISES
    // defaults into config.json. That is #240's mechanism exactly. The file is the only
    // object that can be merged over without inventing keys, and only the server sees it.
    //
    // SHALLOW on purpose. `cluster` and `scanFolders` are arrays a client edits by
    // sending the WHOLE new array, so a deep merge would make removing a peer or a
    // scan folder impossible. Nothing either dialog renders is deleted by OMISSION - a
    // checkbox sends `false`, a cleared text field sends `''` - so shallow costs no
    // affordance that exists. What it does cost is stated plainly: a key already in the
    // file can no longer be REMOVED through this endpoint, only overwritten. Removing
    // one means editing config.json, which is the same privilege this endpoint needs
    // anyway.
    //
    // It settles the issue's third class too, in the safe direction. A key `GET` serves
    // but ALLOWED_CONFIG_KEYS does not carry (`enableRemoteExec`, `ntfy`, `push`,
    // `passAllEnv`, `persistScrollback`, `useConptyDll`) is now PRESERVED, while still
    // not being SETTABLE over HTTP - the allowlist above is untouched and still decides
    // what a body may write. Widening it instead would have let an authenticated PUT
    // turn on remote command execution; preserving can only ever leave that flag where
    // the administrator put it.
    writeConfig(Object.assign(existing, sanitized));
    res.json({
      ok: true,
      needsRestart,
      message: needsRestart
        ? 'Saved. Port, host, or shell changed — restart required.'
        : 'Saved. Changes are live.'
    });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: hostname ---
app.get('/api/hostname', (req, res) => {
  res.json({ hostname: getServerName() });
});

// --- API: auth token management (listing/deletion require auth) ---
// The AI agents this server can run, for the new-session picker and per-agent tinting.
// Served from the provider registry (lib/agents.js) so a client never hardcodes the
// list: adding a CLI agent there makes it appear here, in the picker, and in the
// sidebar colouring with no client release.
app.get('/api/agents', (req, res) => {
  res.json({ agents: agentsLib.listProviders(), default: agentsLib.DEFAULT_AGENT });
});

// #131 - the per-command lens policy. Published like /api/agents so adding or
// reclassifying a command needs no client release. See lib/commands.js for the
// measurement the classification rests on.
app.get('/api/commands', (req, res) => {
  // `quick` is the BUTTON ROW, already ordered (#188). It is published as its own
  // array rather than left for each client to filter and sort, because the order
  // is a decision lib/commands.js owns — the destructive row sorts last, away
  // from a thumb — and two clients re-deriving it would be two chances to disagree.
  // `commands` still carries the whole catalogue, so nothing that reads it breaks.
  res.json({
    commands: commandsLib.listCommands(),
    quick: commandsLib.quickCommands(),
    default: commandsLib.DEFAULT_LENS,
  });
});

app.get('/api/auth/tokens', (req, res) => {
  const tokens = loadApiTokens();
  const list = Object.entries(tokens).map(([token, info]) => ({
    token: token.substring(0, 8) + '...',
    tokenFull: token,
    label: info.label,
    created: info.created,
    expires: info.expires
  }));
  res.json(list);
});

app.delete('/api/auth/tokens/:token', (req, res) => {
  const tokens = loadApiTokens();
  if (tokens[req.params.token]) {
    delete tokens[req.params.token];
    saveApiTokens(tokens);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Token not found' });
});

// --- Cluster: register endpoint (requires Bearer token auth) ---
// Allows a remote server to register itself in our cluster config
app.post('/api/cluster/register', express.json({ limit: '16kb' }), (req, res) => {
  // Must authenticate with a valid API token (the remote server sends one it just received)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || !verifyApiToken(authHeader.substring(7))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { name, url, token, expires } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ error: 'name, url, token required' });
  // #415 - optional, from a sender that knows it (scripts/cluster-relink.js); otherwise the
  // renewer learns it from the peer. A malformed value is refused, never stored.
  if (expires !== undefined && !(Number.isFinite(expires) && expires > 0)) return res.status(400).json({ error: 'expires must be a timestamp in ms' });
  // Validate URL format
  try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  // #264 - the same guard again, and the damage here runs the other way. An unreadable
  // merge base makes `cfg.cluster` an empty array, so the peer NEVER looks present and the
  // write always fires - replacing the file with `{cluster:[...]}` alone. That drops `user`
  // and `password`, and the next restart boots this server on the default credentials.
  //
  // REFUSE THE WHOLE REGISTRATION, not just the config write. The token would still land in
  // cluster-tokens.json, so continuing would report `ok` for a peer whose entry never
  // reached the config - a half-done registration that looks complete, which is the shape
  // of failure this repo pays for most.
  const base = readConfigResult();
  if (!base.ok) {
    console.error(`POST /api/cluster/register refused: ${CONFIG_FILE} exists but will not parse (${base.error})`);
    return res.status(500).json({
      error: 'config.json could not be read, so registering would delete this server\'s own '
        + 'credentials. Fix or remove the file on the server, then register again.',
    });
  }

  // Add to cluster config if not already there
  const cfg = base.config;
  if (!cfg.cluster) cfg.cluster = [];
  if (!cfg.cluster.find(s => s.url === url)) {
    cfg.cluster.push({ name, url });
    writeConfig(cfg);
  }

  // Store the token for this remote server
  const clusterTokens = loadClusterTokens();
  clusterTokens[url] = { token, name, authenticated: Date.now(), ...(expires !== undefined ? { expires } : {}) };
  saveClusterTokens(clusterTokens);

  console.log(`[${new Date().toISOString()}] Cluster: registered remote server "${name}" (${url})`);
  res.json({ ok: true });
});

// --- Cluster: proxy to remote servers ---
const http = require('http');
const https = require('https');

app.get('/api/cluster/servers', (req, res) => {
  const clusterTokens = loadClusterTokens();
  const servers = getClusterConfig().map(s => ({
    name: s.name,
    url: s.url,
    hasToken: !!clusterTokens[s.url]
  }));
  res.json(servers);
});

/**
 * Mint a client token — the piece that lets a companion adopt a peer it
 * DISCOVERED rather than one it was configured with (#97).
 *
 * One endpoint, two roles, which is what keeps the two servers symmetric:
 *
 *   no `url`  -> MINT: the caller wants a token for THIS server. Only this
 *                server can mint its own tokens, so this is where it happens.
 *   with `url`-> PROXY: the caller wants a token for peer `url`. We already hold
 *                a token for that peer (cluster-tokens.json), so we spend our
 *                existing trust to ask the peer to mint a fresh one.
 *
 * Why not just hand over the token we already hold for the peer? Because that is
 * ONE shared credential: revoking a lost phone would also cut this server's own
 * cluster access, and one compromised server would yield working access to every
 * peer. A per-device token is revocable on its own.
 *
 * There is no recursion to guard against: the proxy branch always calls the peer
 * WITHOUT a `url`, so the peer can only take the mint branch.
 *
 * NOTE ON PRIVILEGE: the mint branch lets any already-authenticated caller
 * create a token that outlives the one they used. That is not an escalation of
 * capability — a caller with a valid token can already drive every API on this
 * server, including /api/exec — but it IS persistence, so the label is recorded
 * verbatim and shown in the tokens list precisely so an unexpected one is
 * visible and revocable.
 */
app.post('/api/cluster/client-token', express.json({ limit: '4kb' }), async (req, res) => {
  const { url, label } = req.body || {};
  // The label is stored and rendered; keep it to a conservative charset and
  // length rather than trusting a client string.
  const safeLabel = String(label || 'companion')
    .replace(/[^A-Za-z0-9 ._:-]/g, '')
    .slice(0, 48) || 'companion';

  if (!url) {
    const token = createApiToken(`client:${safeLabel}`);
    return res.json({ ok: true, token, expires: loadApiTokens()[token].expires }); // #415
  }

  const peer = getClusterConfig().find(s => s.url === url);
  if (!peer) return res.status(400).json({ error: 'Server not in cluster config' });
  const stored = loadClusterTokens()[url];
  if (!stored || !stored.token) {
    return res.status(409).json({ error: 'No token stored for that server yet' });
  }

  try {
    const r = await clusterFetch(url + '/api/cluster/client-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + stored.token
      },
      body: JSON.stringify({ label: safeLabel })
    });
    if (!r.ok) return res.status(502).json({ error: 'Peer refused to mint a token' });
    const data = JSON.parse(r.body);
    if (!data || typeof data.token !== 'string' || !data.token) {
      return res.status(502).json({ error: 'Peer returned no token' });
    }
    res.json({ ok: true, token: data.token, name: peer.name, url, ...(typeof data.expires === 'number' ? { expires: data.expires } : {}) });
  } catch (e) {
    res.status(502).json({ error: `Cannot reach server: ${e.message}` });
  }
});

// Authenticate to a remote server and store its token
app.post('/api/cluster/auth', express.json({ limit: '16kb' }), async (req, res) => {
  const { url, user, password } = req.body || {};
  if (!url || !user || !password) return res.status(400).json({ error: 'url, user, password required' });

  // Verify this URL is in our cluster config
  const server = getClusterConfig().find(s => s.url === url);
  if (!server) return res.status(400).json({ error: 'Server not in cluster config' });

  try {
    const tokenRes = await clusterFetch(url + '/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password, label: `cluster:${getServerName()}` })
    });
    if (!tokenRes.ok) return res.status(401).json({ error: 'Remote server rejected credentials' });
    const data = JSON.parse(tokenRes.body);
    const clusterTokens = loadClusterTokens();
    // #415 - no expiry here (/api/auth/token does not report one); the renewer learns it.
    clusterTokens[url] = { token: data.token, name: server.name, authenticated: Date.now() };
    saveClusterTokens(clusterTokens);

    // Auto-register back: create a token for the remote server and register ourselves there
    try {
      const myName = getServerName();
      const myUrl = liveConfig('publicUrl', null);
      if (myUrl) {
        const reverseToken = createApiToken(`cluster:${server.name}`);
        await clusterFetch(url + '/api/cluster/register', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + data.token
          },
          body: JSON.stringify({ name: myName, url: myUrl, token: reverseToken })
        });
      }
    } catch (e) {
      // Non-fatal — reverse registration is best-effort
      console.warn('Cluster reverse-register failed:', e.message);
    }

    res.json({ ok: true, name: server.name });
  } catch (e) {
    res.status(502).json({ error: `Cannot reach server: ${e.message}` });
  }
});

// --- #415: cluster tokens renew instead of silently expiring -----------------------
//
// PEER SIDE. The holder of a token this server minted asks what it knows of it, and
// exchanges it for a fresh one before it runs out. Both are authenticated by the token
// itself (presentedBearer): a holder can only ever learn about or renew its OWN token,
// which it could already use for everything, and the cluster proxy refuses to forward
// either (isTokenRoute). The old token keeps working for the grace period
// (lib/peer-tokens.js RENEW_GRACE_MS); a renewal also drops every expired entry.
app.get('/api/cluster/token', (req, res) => {
  const token = presentedBearer(req);
  if (!token) return res.status(400).json({ error: 'Ask with the bearer token itself' });
  const entry = loadApiTokens()[token];
  if (!entry) return res.status(401).json({ error: 'Unauthorized' });
  res.json(peerTokens.tokenInfo(entry));
});

app.post('/api/cluster/token/renew', (req, res) => {
  const token = presentedBearer(req);
  if (!token) return res.status(400).json({ error: 'Renew with the bearer token itself' });
  const tokens = loadApiTokens();
  const r = peerTokens.renewToken(tokens, token, Date.now());
  if (!r.ok) return res.status(401).json({ error: 'Unauthorized' });
  saveApiTokens(tokens);
  console.log(`[${new Date().toISOString()}] Cluster: renewed token ${JSON.stringify(String(tokens[r.token].label))} (old one works for the grace period)`);
  res.json({ ok: true, token: r.token, expires: r.expires });
});

// CALLER SIDE. Every RENEW_INTERVAL_MS, ask each configured peer what its token's expiry
// is NOW (a renewal whose answer was lost shows up here as a started grace) and renew
// any with less than 30 days left.
// One run at a time: the scheduled tick and a forced run never interleave their
// read-modify-writes of cluster-tokens.json.
let _peerTokenRun = Promise.resolve();
function runPeerTokenRenewal({ url = null, force = false } = {}) {
  const run = _peerTokenRun.then(async () => {
    const publicUrl = liveConfig('publicUrl', null);
    const peers = getClusterConfig()
      .filter(s => s && s.url && (!publicUrl || s.url !== publicUrl))
      .filter(s => !url || s.url === url);
    const results = await peerTokens.renewPeerTokens({
      peers, force,
      load: loadClusterTokensFresh,
      save: saveClusterTokens,
      request: async (peerUrl, method, p, token) => {
        const r = await clusterFetch(peerUrl + p, { method, headers: { Authorization: 'Bearer ' + token }, timeout: 10000 });
        return { status: r.status, body: r.body };
      },
    });
    const tokensNow = loadClusterTokens();
    for (const r of results) {
      if (r.action === 'none') continue;
      const st = peerTokens.peerTokenStatus(tokensNow[r.url], Date.now());
      const left = st.tokenDaysLeft === null ? 'expiry unknown' : `${st.tokenDaysLeft} days left`;
      console[r.ok ? 'log' : 'warn'](`[${new Date().toISOString()}] Cluster token ${r.name}: ${r.action} ${r.ok ? 'ok' : `FAILED (${r.error}${r.status ? `, HTTP ${r.status}` : ''})`}, ${left}${st.tokenExpiring ? ' - EXPIRING' : ''}`);
    }
    if (results.some(r => r.ok && /renew/.test(r.action))) invalidateClusterSessionsCache();
    return results;
  });
  _peerTokenRun = run.catch(() => {});
  return run;
}

app.post('/api/cluster/peer-tokens/renew', express.json({ limit: '4kb' }), async (req, res) => {
  const { url, force } = req.body || {};
  if (url !== undefined && typeof url !== 'string') return res.status(400).json({ error: 'url must be a string' });
  if (url && !getClusterConfig().some(s => s.url === url)) return res.status(400).json({ error: 'Server not in cluster config' });
  try {
    res.json({ ok: true, results: await runPeerTokenRenewal({ url: url || null, force: force === true }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

setTimeout(function peerTokenTick() {
  runPeerTokenRenewal().catch(e => console.warn('Cluster token renewal failed:', e.message));
  setTimeout(peerTokenTick, peerTokens.RENEW_INTERVAL_MS).unref();
}, 60 * 1000).unref();

// Remove stored token for a remote server
app.delete('/api/cluster/auth/:url', (req, res) => {
  const clusterTokens = loadClusterTokens();
  const url = decodeURIComponent(req.params.url);
  delete clusterTokens[url];
  saveClusterTokens(clusterTokens);
  res.json({ ok: true });
});

// Fetch all sessions across cluster.
//
// Cached per-user for CLUSTER_SESSIONS_TTL_MS so N concurrent browser tabs all
// share a single fan-out to peers (each call hits every peer with 2 GETs;
// without coalescing this becomes a polling storm that wedges the event loop
// and trips the monitor's health check).
const CLUSTER_SESSIONS_TTL_MS = 1500;
const _clusterSessionsCache = new Map(); // user -> { ts, promise }

// Drop the cached cluster-session list so the next /api/cluster/sessions call
// recomputes. Call after any local session mutation (create/delete/rename/
// reorder) — otherwise a just-created session is invisible in the sidebar until
// the TTL lapses (a session you create doesn't show for up to 1.5s). Cheap: the
// next fetch simply re-fans-out. Clears all users (a local mutation is visible
// to every viewer).
function invalidateClusterSessionsCache() { _clusterSessionsCache.clear(); }

// Throttle for verbose cluster-fan-out logs. We only emit when the session
// summary changes OR CLUSTER_LOG_MIN_GAP_MS has passed.
const CLUSTER_LOG_MIN_GAP_MS = 30000;
const _clusterLogState = new Map(); // key -> { ts, summary }
function _throttledClusterLog(key, summary, format) {
  const prev = _clusterLogState.get(key);
  const now = Date.now();
  if (prev && prev.summary === summary && now - prev.ts < CLUSTER_LOG_MIN_GAP_MS) return;
  _clusterLogState.set(key, { ts: now, summary });
  console.log(format(new Date().toISOString()));
}

// Each peer's last fetch state, keyed by name — the only state lib/peer-fetch-log.js needs.
const _peerFetchStates = new Map();

async function _computeClusterSessions(reqUser) {
  const result = [];
  // #56 — the local server's own account usage, rolled up from the sessions below. Kept
  // apart from `result` (which accumulates the peers' sessions too) so each server's block
  // is computed from ITS OWN reports only.
  const localShaped = [];

  // Local sessions (via worker)
  try {
    settlePendingQuestions(); // #441 - before the statuses are read, so they agree
    const { sessions: localList } = await workerClient.rpc('listSessions');
    reconcileBriefs(localList.map((s) => s.id)); // #298 - sessions that ended while we were down
    const localMetrics = await Promise.all(localList.map((s) => sessionMetrics(s).catch(() => null)));
    const localConvIds = await Promise.all(localList.map((s) => sessionConversationId(s).catch(() => null)));
    const localBgTasks = await Promise.all(localList.map((s) => sessionRunningWork(s).catch(() => [])));
    localList.forEach((s, i) => {
      localShaped.push({
        id: s.id, name: s.name, cwd: s.cwd, status: s.status,
        clients: s.clients || 0, pid: s.pid,
        lastActivity: s.lastActivity, autoCommand: s.autoCommand || '',
        // Which AI agent this session runs (null = plain shell) — the sidebar tints
        // each row by it. Remote peers already carry it in their own /api/sessions.
        agent: s.agent ?? null,
        claudeSessionId: s.claudeSessionId,
        // See the /api/sessions shaping — a client drops its cached transcript when
        // this changes. Peers carry their own on their /api/sessions, so the merge
        // below keeps theirs.
        agentSessionId: localConvIds[i],
        server: getServerName(), serverUrl: null,
        notifyLevel: getNotifyLevel(s.id),
        // #60 — the pin + its rank in the pinned group. Peers already carry both
        // on their own /api/sessions, so the spread above keeps them.
        ...favoriteFields(s.id),
        metrics: localMetrics[i],
        // #137 — the 5h wait period, DERIVED here (lib/usage-limit.js) rather than in
        // each client. Same trap as backgroundTasks below: this branch is shaped
        // field-by-field while the remote branch spreads a peer's row whole, so a
        // peer's capped sessions would show the badge and our own would not.
        usageLimit: usageLimitFields(s.id, localMetrics[i], s),
        // Background commands still running. This list is shaped field-by-field,
        // unlike the remote branch below (which spreads the peer's row whole), so
        // omitting it here would show a peer's builds but never our own.
        backgroundTasks: localBgTasks[i],
        // #79 — same trap as backgroundTasks above: peers carry waitingFor on their
        // own /api/sessions and the remote branch spreads their row whole, so leaving
        // it out here would flag a peer's blocked session and never one of ours.
        waitingFor: sessionWaitingFor(s),
        // #147 — and the same trap a THIRD time. The remote branch spreads a
        // peer's row whole, so a peer's sessions carried real readiness while
        // this server's own carried the `?? true` default — a client gating on
        // it would refuse to trust nobody and gate nobody local. Found in review
        // of PR #150, in a spot two comments above already warn about.
        agentReady: s.agentReady ?? true,
        // #190 — and the same trap a FOURTH time, for the field that says WHY a
        // session is not ready. A peer's blocked session would explain itself and
        // one of ours would show a bare spinner.
        blockedPrompt: s.blockedPrompt ?? null,
        // #316 — a panel or menu over the composer (worker-derived), for sessionReason.
        inMenu: s.inMenu === true,
        inMenuSince: s.inMenuSince ?? null,
        // #298 — the dashboard brief. Same helper as /api/sessions, so this branch cannot
        // be the fifth field forgotten here (the trap the four comments above record).
        brief: sessionBriefField(s),
        // #351 - the same helper as /api/sessions, so this branch cannot forget it either.
        spawn: spawnStore.field(s.id),
        // #468 - and the same for R9's evidence and the dispatcher's role.
        ...supervisorRowFields(s),
      });
    });
    // #313 - and the reason, derived from the SHAPED row by the same helper as
    // /api/sessions, so it can only ever read the fields both shapers publish.
    addSessionReasons(localShaped);
    result.push(...localShaped);
  } catch (e) {
    console.error('worker listSessions failed:', e.message);
  }

  // Remote sessions (parallel, with timeout) — skip self-reference
  const clusterTokens = loadClusterTokens();
  const publicUrl = liveConfig('publicUrl', null);
  const clusterCfg = getClusterConfig();
  const remoteServers = clusterCfg.filter(server => !publicUrl || server.url !== publicUrl);
  const remotePromises = remoteServers.map(async (server) => {
    const tokenEntry = clusterTokens[server.url];
    if (!tokenEntry) return { server: server.name, url: server.url, online: false, needsAuth: true, sessions: [], reason: 'no stored token' };
    try {
      const r = await clusterFetch(server.url + '/api/sessions', {
        headers: { 'Authorization': 'Bearer ' + tokenEntry.token },
        timeout: 3000
      });
      if (r.status === 401) {
        return { server: server.name, url: server.url, online: true, needsAuth: true, sessions: [], reason: 'HTTP 401' };
      }
      if (!r.ok) return { server: server.name, url: server.url, online: false, sessions: [], reason: `HTTP ${r.status}` };
      const remoteSessions = JSON.parse(r.body);
      // Fetch version from remote — and its CAPABILITIES, which ride the same answer.
      // A client must be able to ask "can the server that owns this session take this
      // write?" BEFORE offering the control; discovering it as a 404 means the user
      // sees the action flash on and snap off with no explanation. A peer too old to
      // answer (or one whose probe fails) reports none — the client then offers
      // nothing, which is the honest thing to do.
      let version = '', capabilities = [], resources = null, color = null, machineCapabilities = null;
      try {
        const vr = await clusterFetch(server.url + '/api/version', {
          headers: { 'Authorization': 'Bearer ' + tokenEntry.token }, timeout: 2000
        });
        if (vr.ok) {
          const v = JSON.parse(vr.body);
          version = `${v.version} (${v.hash})`;
          if (Array.isArray(v.capabilities)) capabilities = v.capabilities.filter(c => typeof c === 'string');
          // #152 — validated, never trusted verbatim: a buggy/compromised peer must not
          // be able to hand our clients a malformed field through this merge. A peer too
          // old to send it, or one whose shape fails the check, reports null — the client
          // renders "unknown", never a fabricated 0%.
          resources = resourcesLib.sanitizeResources(v.resources);
          // #315 - the peer's own colour, validated like everything else it hands us.
          color = validServerColor(v.serverColor);
          if (color) _peerColorCache.set(server.url, color);
          // #413 - validated by the same rule as our own; a peer too old to send it is null.
          if (Array.isArray(v.machineCapabilities)) machineCapabilities = workItems.machineCapabilities(v.machineCapabilities).capabilities;
        }
      } catch (e) {}
      // Issue #20: if this peer opts into direct-mode, mint a short-lived
      // HMAC token per session so the browser can WS straight to the peer.
      // HMAC key is our stored bearer for that peer (peer has same value in
      // its api-tokens.json, so it can verify without new key exchange).
      const directConnect = server.directConnect === true;
      const mapped = remoteSessions.map(s => {
        const base = { ...s, server: server.name, serverUrl: server.url };
        if (directConnect && tokenEntry.token) {
          try {
            const dt = mintDirectToken(tokenEntry.token, { sid: s.id, user: reqUser });
            const wsBase = server.url.replace(/^http/, 'ws').replace(/\/+$/, '');
            base.directUrl = `${wsBase}/ws/${encodeURIComponent(s.id)}?dt=${encodeURIComponent(dt)}`;
            base.directToken = dt;
          } catch (e) {
            // Mint failed — silently omit directUrl so client falls back to proxy
            console.warn(`[cluster/direct] mint failed for ${server.name}: ${e.message}`);
          }
        }
        return base;
      });
      return {
        server: server.name, url: server.url, online: true, needsAuth: false, version, capabilities, resources,
        color, machineCapabilities, directConnect, sessions: mapped,
        // #56 — the peer's OWN account usage. It reports the raw facts (each session's
        // metrics, now carrying `agent` + `ts`) on its /api/sessions, which is a bare array
        // and cannot carry a server-level block; the SAME roll-up rule is applied to them
        // here, so local and remote are one rule, not two. No extra fan-out GET, and a peer
        // too old to send `ts` simply reports nothing rather than a wrong number.
        usage: rollUpUsage(mapped),
      };
    } catch (e) {
      return { server: server.name, url: server.url, online: false, sessions: [], reason: e && e.message };
    }
  });

  const _tClusterFetch = _LATENCY_DEBUG ? performance.now() : 0;
  const remotes = await Promise.all(remotePromises);
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _tClusterFetch;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} cluster-sessions-fetch peers=${remotePromises.length} dur=${dur.toFixed(0)}ms`);
  }
  for (const r of remotes) {
    // #272 follow-up — the line below fires only for a peer WITH sessions, so a peer
    // dropping out of the merge (offline, 401, empty) used to log nothing at all. This
    // logs each peer's state TRANSITIONS, once each, never per poll (lib/peer-fetch-log.js).
    const transition = peerFetchLog.notePeerFetch(_peerFetchStates, r);
    if (transition) console.log(`[${new Date().toISOString()}] ${transition}`);
    if (r.sessions.length > 0) {
      const summary = r.sessions.map(s => {
        const ageMins = s.lastActivity ? Math.round((Date.now() - s.lastActivity) / 60000) : '?';
        return `"${s.name}"(${s.status}, ${ageMins}m ago)`;
      }).join(', ');
      _throttledClusterLog(`fetch:${r.server}`, `${r.online ? '1' : '0'}|${r.sessions.length}|${summary}`,
        (ts) => `[${ts}] Cluster fetch: ${r.server} (${r.online ? 'online' : 'offline'}) → ${r.sessions.length} sessions: ${summary}`);
    }
    result.push(...r.sessions);
  }

  // Get local version info (cached — no sync git per request). See _getGitInfo().
  const _gitInfo = _getGitInfo();
  const localVersion = `${SERVER_VERSION} (${_gitInfo.hash})`;

  // #56 — per-server account usage. The 5h/7d windows are ACCOUNT-wide, not per-session,
  // so they hang off the server, once, per agent (Claude and Codex bill separate quotas and
  // are never merged). `usage` is omitted entirely when nothing fresh was reported — the
  // clients then render nothing at all, never a misleading 0%.
  const localUsage = rollUpUsage(localShaped);

  return {
    sessions: result,
    servers: [
      {
        name: getServerName(), url: null, online: true, needsAuth: false, version: localVersion, capabilities: serverCapabilities(),
        color: getServerColor(),
        machineCapabilities: localMachineCapabilities(), // #413
        // #152 — machine-wide CPU%/memory, sampled independently of this request (see
        // the warm sampler above). Always present locally; a peer carries its own the
        // same way `usage` does below.
        resources: _resourceSampler.read(),
        ...(localUsage ? { usage: localUsage } : {}),
      },
      ...remotes.map(r => ({
        name: r.server, url: r.url, online: r.online, needsAuth: r.needsAuth,
        version: r.version || '', capabilities: r.capabilities || [], directConnect: r.directConnect === true,
        // An offline peer keeps the colour it last declared, so its rows do not change
        // colour just because it stopped answering.
        color: r.color || _peerColorCache.get(r.url) || null,
        machineCapabilities: r.machineCapabilities || null, // #413
        // #415 - days left on the token we hold for this peer; tokenExpiring under 14 days.
        ...peerTokens.peerTokenStatus(clusterTokens[r.url], Date.now()),
        ...(r.resources ? { resources: r.resources } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      }))
    ]
  };
}

// Direct-mode (issue #20): look up the current user from the session cookie so
// minted tokens bind to them. Cluster API calls via Bearer have no cookie —
// in that case we fall back to the configured server user.
function clusterReqUser(req) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const tok = cookies[COOKIE_NAME];
    if (!tok) return _USER;
    const dot = tok.lastIndexOf('.');
    if (dot === -1) return _USER;
    const payload = Buffer.from(tok.substring(0, dot), 'base64').toString();
    const colon = payload.indexOf(':');
    return colon > 0 ? payload.substring(0, colon) : _USER;
  } catch { return _USER; }
}
/** The cluster view (every server's sessions) through the short per-user cache. ONE path
 *  for GET /api/cluster/sessions and Mission Control (#503), so both read the same rows. */
function cachedClusterSessions(reqUser) {
  const now = Date.now();
  let entry = _clusterSessionsCache.get(reqUser);
  if (!entry || now - entry.ts > CLUSTER_SESSIONS_TTL_MS) {
    entry = { ts: now, promise: _computeClusterSessions(reqUser).catch((e) => {
      // On failure, evict so the next caller retries instead of getting cached error.
      if (_clusterSessionsCache.get(reqUser) === entry) _clusterSessionsCache.delete(reqUser);
      throw e;
    }) };
    _clusterSessionsCache.set(reqUser, entry);
  }
  return entry.promise;
}

app.get('/api/cluster/sessions', async (req, res) => {
  try {
    const payload = await cachedClusterSessions(clusterReqUser(req));
    res.json(payload);
  } catch (e) {
    console.error('cluster/sessions failed:', e.message);
    res.status(500).json({ error: 'Failed to fetch cluster sessions' });
  }
});

// Proxy API requests to remote servers
app.all('/cluster/:serverUrl/api/*', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const serverUrl = decodeURIComponent(req.params.serverUrl);
  const clusterTokens = loadClusterTokens();
  const tokenEntry = clusterTokens[serverUrl];
  if (!tokenEntry) return res.status(401).json({ error: 'Not authenticated to remote server' });

  const remotePath = '/api/' + req.params[0];
  // #415 - never forward the token routes. Through this proxy the HOLDER is this server:
  // a renewal would exchange OUR token for that peer and hand the fresh one to whoever
  // asked, leaving cluster-tokens.json with the superseded one. Judged on the path that is
  // actually SENT (clusterFetch re-parses it: dot segments, '#', tabs), never on params[0].
  if (peerTokens.isProxiedTokenRoute(serverUrl, remotePath)) return res.status(403).json({ error: 'Token routes are not proxied' });
  const contentType = req.headers['content-type'] || 'application/json';
  let body;
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    body = contentType.includes('json') ? JSON.stringify(JSON.parse(req.body.toString() || '{}')) : req.body;
  }
  try {
    const r = await clusterFetch(serverUrl + remotePath, {
      method: req.method,
      headers: {
        'Authorization': 'Bearer ' + tokenEntry.token,
        'Content-Type': contentType
      },
      body,
      timeout: 30000
    });
    // A mutating call to a PEER changes what OUR merged /api/cluster/sessions
    // says (that peer's sessions ride in it), so the 1.5s merged cache has to go
    // — otherwise a pin/rename/kill done on a peer appears to bounce back for up
    // to a poll. The peer invalidates its own cache in its own route; this is the
    // local half of the same fact. (#60)
    if (r.status < 400 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) invalidateClusterSessionsCache();
    res.status(r.status);
    try { res.json(JSON.parse(r.body)); } catch (e) { res.send(r.body); }
  } catch (e) {
    res.status(502).json({ error: `Remote server unreachable: ${e.message}` });
  }
});

// Proxy WebSocket to remote server (with transparent reconnection)
app.ws('/cluster/:serverUrl/ws/:id', (localWs, req) => {
  if (!authenticateWs(localWs, req)) return;

  const serverUrl = decodeURIComponent(req.params.serverUrl);
  const clusterTokens = loadClusterTokens();
  const tokenEntry = clusterTokens[serverUrl];
  if (!tokenEntry) { localWs.close(1008, 'Not authenticated to remote'); return; }

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/' + req.params.id + '?token=' + tokenEntry.token;
  const WebSocket = require('ws');
  const sessionId = req.params.id;
  const logPfx = `Cluster proxy ${serverUrl}/ws/${sessionId.substring(0, 8)}`;

  // Disable Nagle on local side of proxy
  if (localWs._socket) localWs._socket.setNoDelay(true);

  // Mutable remote connection — replaced on reconnect
  let remoteWs = null;
  let remoteAlive = false;
  let localClosed = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let proxyPingTimer = null;
  const buffered = [];
  const MAX_RECONNECT_ATTEMPTS = 10;
  const MAX_BUFFER_SIZE = 100;
  // #201 — a COUNT is not a memory bound, and this path never had a byte one. The
  // proxy relays frames verbatim; `handleMessage`'s app cap is applied by the REMOTE
  // peer, not here, so the only per-frame ceiling this buffer ever sees is the
  // transport's. That was the `ws` default (100 MB) until #201 set `WS_MAX_PAYLOAD`,
  // i.e. 100 entries could in principle hold 10 GB; it is 4 MiB now, which still
  // leaves 400 MiB per proxied session on the count alone. So bound the bytes too.
  // 4 MiB holds five maximal legitimate frames (786,432 bytes each — see the
  // WS_INPUT_MAX arithmetic) or many thousands of keystrokes, far more than a
  // reconnect window accumulates. Polarity deliberately matches the count bound:
  // when full the NEWEST write is refused rather than an older one evicted, so a
  // reconnect never replays a hole in the middle of what was typed.
  const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
  let bufferedBytes = 0;
  // The prefix guarantee above needs a LATCH, not a per-frame fit test - see
  // lib/reconnect-buffer.js. Set by the first refusal, cleared only by a flush.
  let bufferLatched = false;
  // #209 — what the latch above stops being counted. Once the buffer refuses, every
  // later write in the same outage is refused too and lands in NO array, so
  // `buffered.length` is not "what was lost" — it is only "what was held". The
  // give-up notice names the sum of the two, which is the only number that makes
  // "everything you typed while it was down" a true sentence. Reset with the latch.
  let refusedWrites = 0;
  let refusedBytes = 0;

  function connectRemote() {
    // #415 - the token held NOW, not the one held when the browser connected: a renewal
    // in between leaves that one with only its grace period to live.
    const held = loadClusterTokens()[serverUrl];
    const url = held && held.token ? wsUrl.replace(/\?token=.*$/, '?token=' + held.token) : wsUrl;
    const ws = new WebSocket(url, { rejectUnauthorized: false, perMessageDeflate: false });

    ws.on('open', () => {
      if (ws._socket) ws._socket.setNoDelay(true);
      remoteWs = ws;
      remoteAlive = true;
      reconnectAttempts = 0;
      const label = reconnectAttempts === 0 ? 'connected' : 'reconnected';
      console.log(`[${new Date().toISOString()}] ${logPfx}: ${label}`);
      // Flush buffered input
      for (const b of buffered) {
        try { ws.send(b.msg, { binary: b.isBinary }); } catch (e) {}
      }
      buffered.length = 0;
      bufferedBytes = 0;
      bufferLatched = false;
      refusedWrites = 0;
      refusedBytes = 0;
      // Ask the local client (browser) to re-send its resize dimensions so
      // the remote PTY matches the client's terminal size after reconnect.
      // Sending this to the remote would get it written to the PTY as input.
      try { localWs.send(JSON.stringify({ requestResize: true })); } catch (e) {}
      startProxyPing();
    });

    ws.on('message', (data, isBinary) => {
      if (localClosed) return;
      try { localWs.send(data, { binary: isBinary }); } catch (e) {}
    });

    ws.on('pong', () => { remoteAlive = true; });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      console.log(`[${new Date().toISOString()}] ${logPfx}: remote closed (${code} ${reasonStr})`);
      stopProxyPing();
      // Session-level closes: don't reconnect, propagate to browser
      if (code === 4000 || code === 4001) {
        try { localWs.close(code, reason); } catch (e) {}
        return;
      }
      // Unexpected close: try transparent reconnect
      if (!localClosed) attemptReconnect();
    });

    ws.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] ${logPfx}: remote error: ${err.message}`);
      stopProxyPing();
      // The 'close' event will fire after 'error', which triggers reconnect
    });
  }

  function attemptReconnect() {
    if (localClosed) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log(`[${new Date().toISOString()}] ${logPfx}: giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      // #209 — THE BUFFER IS DISCARDED HERE, AND UNTIL NOW IN SILENCE. Everything the
      // browser typed during the outage was ACCEPTED — it fit, so `decide` refused
      // nothing and #204's notice never fired — and then all of it goes with the socket
      // because the peer never came back. That is the opposite case from #204's and from
      // the user's side it is worse: nothing was ever refused, so there was no signal at
      // all. The backoff runs 500ms, 1s, 2s, 4s then 5s capped, so this lands ~37s in —
      // comfortably long enough to have typed a real prompt into a session that looked
      // merely laggy.
      //
      // ONE notice for the whole buffer, not one per write: this is a single event with
      // a single cause, and #204's own rule about a notice per keystroke being noise
      // applies with more force to a hundred of them arriving at once.
      //
      // `reason` uses the vocabulary #204 established, and a THIRD value rather than
      // reusing 'buffer-full': that one means "there was no room left", which is exactly
      // what did NOT happen here. `bytes` is the total actually lost, and `writes` says
      // how many separate things that was — a count is what makes "12 writes" legible
      // where a byte total alone is not. Both are additive; a client that reads neither
      // still renders the generic wording.
      //
      // ORDER IS THE WHOLE QUESTION. `ws` writes a data frame and a close frame through
      // the same `Sender` onto the same socket, in call order, so a `send` immediately
      // before a `close` is delivered first — asserted rather than assumed, in
      // tests/cluster-proxy-drop.spec.js.
      //
      // THE RULE IS THE MODULE'S, NOT THIS ROUTE'S. What was lost, that the buffer must
      // latch, and what it holds afterwards are three decisions about the buffer's own
      // behaviour — the same class `decide` already owns, and `lib/reconnect-buffer.js`
      // exists precisely so they are not two loose counters and an assignment sitting
      // beside it. `giveUp` also makes them testable without a socket or 37 seconds
      // (tests/reconnect-buffer.spec.js). Found in review of this change.
      //
      // `writes` is what was LOST, not what was HELD: once the buffer latched, every
      // later write in the outage was refused into no array at all.
      const loss = reconnectBuffer.giveUp({
        count: buffered.length,
        bytes: bufferedBytes,
        latched: bufferLatched,
        refusedCount: refusedWrites,
        refusedBytes,
      });
      // Adopt the state it returns, whole. `next.count` is 0 and `buffered` is the array
      // that count describes, so the two are cleared together or they disagree.
      buffered.length = 0;
      bufferedBytes = loss.next.bytes;
      bufferLatched = loss.next.latched;
      refusedWrites = loss.next.refusedCount;
      refusedBytes = loss.next.refusedBytes;
      // AND THIS SOCKET IS DONE, said before the close rather than after it. `close()`
      // moves the socket to CLOSING and `ws` keeps delivering `message` until the peer's
      // close frame arrives; the local handler now refuses to act on those, so a write
      // typed in that window cannot be quietly proxied or buffered. `next.latched`
      // above is the same guarantee expressed in the buffer's own state — belt and
      // braces on purpose, because the two protect different callers of the same gap.
      localClosed = true;
      if (loss.writes > 0) {
        // The clear above already makes a second report impossible by construction.
        // Nothing re-enters this branch today — `attemptReconnect` has one caller, at
        // most one remote socket is ever in flight, and `cleanup()`'s `close()` on an
        // already-closed socket emits nothing — so this is defensiveness, recorded as
        // such rather than dressed up as a path somebody measured.
        console.error(`[${new Date().toISOString()}] ${logPfx}: DISCARDING ${loss.writes} buffered write(s) (${loss.bytes} bytes) — peer never came back`);
        try { localWs.send(JSON.stringify({ inputDropped: true, bytes: loss.bytes, writes: loss.writes, reason: 'peer-unreachable' })); } catch (e) {}
      }
      try { localWs.close(1001, 'Remote unreachable'); } catch (e) {}
      return;
    }
    reconnectAttempts++;
    // Exponential backoff: 500ms, 1s, 2s, 4s, capped at 5s
    const delay = Math.min(5000, 500 * Math.pow(2, reconnectAttempts - 1));
    console.log(`[${new Date().toISOString()}] ${logPfx}: reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      if (!localClosed) connectRemote();
    }, delay);
  }

  // Ping remote every 20s to detect dead connections faster than the 30s server keepalive
  function startProxyPing() {
    stopProxyPing();
    proxyPingTimer = setInterval(() => {
      if (!remoteWs || remoteWs.readyState !== WebSocket.OPEN) return;
      if (!remoteAlive) {
        // Missed pong — connection is dead, force reconnect
        console.log(`[${new Date().toISOString()}] ${logPfx}: remote ping timeout, forcing reconnect`);
        try { remoteWs.terminate(); } catch (e) {}
        return;
      }
      remoteAlive = false;
      try { remoteWs.ping(); } catch (e) {}
    }, 20000);
  }

  function stopProxyPing() {
    if (proxyPingTimer) { clearInterval(proxyPingTimer); proxyPingTimer = null; }
  }

  function cleanup() {
    localClosed = true;
    stopProxyPing();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (remoteWs) { try { remoteWs.close(); } catch (e) {} }
  }

  // Start first connection
  connectRemote();

  localWs._wtAlive = true;
  localWs.on('pong', () => { localWs._wtAlive = true; });
  localWs.on('message', (msg, isBinary) => {
    // #209 — once this proxy has given up (or the browser has gone), a frame still
    // arriving is one the transport read before the close handshake finished. There is
    // nowhere for it to go: the remote is unreachable and the buffer that would have
    // held it is never flushed again. Refusing it here keeps it out of a buffer that
    // would silently swallow it.
    if (localClosed) return;
    // Absorb client heartbeats — don't forward to remote PTY
    const firstByte = Buffer.isBuffer(msg) ? msg[0] : (msg.length > 0 ? msg.charCodeAt(0) : 0);
    if (firstByte === 0x7B) {
      const str = Buffer.isBuffer(msg) ? msg.toString() : msg;
      if (str.startsWith('{"heartbeat":')) { localWs._wtAlive = true; return; }
    }
    if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      try { remoteWs.send(msg, { binary: isBinary }); } catch (e) {}
    } else {
      const size = Buffer.isBuffer(msg) ? msg.length : Buffer.byteLength(String(msg));
      const state = { count: buffered.length, bytes: bufferedBytes, latched: bufferLatched };
      const decision = reconnectBuffer.decide(state, size, { maxEntries: MAX_BUFFER_SIZE, maxBytes: MAX_BUFFER_BYTES });
      if (decision.admit) {
        buffered.push({ msg, isBinary });
        bufferedBytes += size;
      } else {
        // #204 — TELL THE BROWSER. The remote link is what is down; `localWs` is open
        // the whole time, so this refusal has somewhere to go and had no excuse for
        // being silent. Same frame the direct path already sends for its cap refusal,
        // so an app.html that predates this still renders it — the notice itself needs
        // no client release, only a server that sends it.
        //
        // app.html is the ONLY client on this path: the companion addresses each server
        // directly (`_wsUri(server, '/ws/<id>')`) and never proxies through a peer. That
        // is what keeps the `reason` handling below a one-file change.
        //
        // `bytes` here really is bytes; on the direct path the same field carries
        // UTF-16 code units. The field name is wrong there and kept for compatibility
        // (see the WS_INPUT_MAX block), and both are a size the user can compare
        // against what they typed, which is all either client does with it.
        //
        // `reason` is carried because the two refusals do not mean the same thing and
        // the notice must not say they do. The direct path's is "that write was too
        // large"; this one is "the link was down and there was no room left", which can
        // land on a 16-byte keystroke - and "too large to send (16 bytes)" is the kind of
        // confidently wrong message that teaches you to distrust the notice. Sent ONLY
        // here, so its absence keeps its existing meaning on the direct path and no
        // client needs to change to keep working.
        //
        // ONCE per outage — see `decide`. `try/catch` because a local socket that has
        // just died is the ordinary case here, not an exceptional one, and losing the
        // notice must never cost the refusal its latch.
        if (decision.notify) {
          console.error(`[${new Date().toISOString()}] ${logPfx}: input DROPPED while remote is down (${size} bytes); buffer full, latching`);
          try { localWs.send(JSON.stringify({ inputDropped: true, bytes: size, reason: 'buffer-full' })); } catch (e) {}
        }
        // Counted whether or not it was reported: the notice is once per outage, but
        // the LOSS is per write, and the give-up above has to be able to name the total.
        refusedWrites++;
        refusedBytes += size;
        // Everything from here on would replay BEHIND a gap, so refuse the rest too.
        bufferLatched = true;
      }
    }
  });
  localWs.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] ${logPfx}: local error: ${err.message}`);
    cleanup();
  });
  localWs.on('close', () => { cleanup(); });
});

// --- Git version info cache --------------------------------------------
// /api/version and /api/cluster/sessions both want the current git hash +
// staleness data. Each of them calls execSync('git ...') several times,
// and one of the calls (`git fetch --dry-run`) allows a 5s timeout which
// under network trouble blocks the Node event loop for up to 5s. Since
// peers cross-poll each other every 5s, the practical impact is severe:
// a single slow `git fetch --dry-run` on one peer blocks keystroke echo
// on every peer that cross-polls it. This was the top p99 offender.
//
// Fix: cache the expensive computation and recompute in the background.
//   - `dirty` — refreshed every 30s.
//   - Expensive keys (behind = `git fetch --dry-run` + `rev-list`) —
//     refreshed every 5 minutes, never on the request path.
// On request we just return the cached struct synchronously. If the
// cache is empty (first call) we schedule a full refresh and answer with
// what we have. Behind=-1 until ready.
//
// `hash` and `date` are NOT in that refresh: they name the BUILD this process runs, so they
// are read once at start (lib/build-id.js) and never follow the checkout. A hash that did
// would name the pulled commit while the old code still ran, and a deploy check comparing
// it to HEAD would pass for a server that was never reloaded.
const BUILD_ID = readBuildId(__dirname);
let _gitCache = null;       // { hash, date, behind, fetchedAt, dirty }
let _gitCacheTime = 0;
let _gitRefreshing = false;
let _gitBehindRefreshing = false;
let _gitBehindTime = 0;
const GIT_CACHE_TTL = 30 * 1000;        // refresh cheap keys every 30s
const GIT_BEHIND_TTL = 5 * 60 * 1000;   // refresh behind every 5 min

function _gitExecAsync(cmd, args, timeoutMs) {
  // All version/update-check git calls go through the hardened runner so they
  // can never prompt for credentials (which would hang git-credential-manager
  // forever in the headless service context and leak process trees until the
  // machine OOMs). See lib/git-safe.js.
  if (cmd === 'git') {
    return execGit(args, { cwd: __dirname, timeoutMs: timeoutMs || 3000 });
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: __dirname, encoding: 'utf8', windowsHide: true, timeout: timeoutMs || 3000 }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').trim());
    });
  });
}

async function _gitRefresh(includeBehind) {
  if (_gitRefreshing) return;
  _gitRefreshing = true;
  try {
    const dirtyRaw = await _gitExecAsync('git', ['status', '--porcelain']);
    let behind = _gitCache ? _gitCache.behind : -1;
    let fetchedAt = _gitCache ? _gitCache.fetchedAt : null;
    if (includeBehind && !_gitBehindRefreshing) {
      _gitBehindRefreshing = true;
      try {
        // #248 - the AGE of the ref `behind` is measured against, read FIRST and
        // unconditionally. `git fetch --dry-run` writes no refs and no FETCH_HEAD, so
        // this mtime is the last time somebody ran a REAL fetch or pull - which is the
        // only thing that moves `@{u}` - and it stays knowable even when the probe below
        // cannot reach the remote at all, where it is the more useful of the two numbers.
        // `--git-path` rather than a hardcoded `.git/FETCH_HEAD`: in a linked worktree
        // `.git` is a file, and git resolves it correctly.
        const fetchHeadPath = await _gitExecAsync('git', ['rev-parse', '--git-path', 'FETCH_HEAD']);
        fetchedAt = gitFreshness.readFetchedAt(
          fetchHeadPath ? path.resolve(__dirname, fetchHeadPath) : null,
        );
        // git fetch --dry-run with 5s timeout — in background so it NEVER
        // blocks the request path. Once it returns, the cached `behind`
        // updates and subsequent responses pick it up.
        const fetchOk = await _gitExecAsync('git', ['fetch', '--dry-run'], 5000);
        if (fetchOk !== null) {
          const count = gitFreshness.parseBehindCount(
            await _gitExecAsync('git', ['rev-list', 'HEAD..@{u}', '--count']),
          );
          // The rule, not an inline expression: a stale ref (or a count that never
          // happened) may not answer 0. What this replaces read
          // `(count != null && count !== '') ? (parseInt(count) || 0) : 0`, whose ELSE
          // branch published 0 for a rev-list that FAILED - which is what `@{u}` does on
          // a branch with no upstream.
          behind = gitFreshness.publishedBehind({ count, fetchedAt, now: Date.now() });
          _gitBehindTime = Date.now();
        } else {
          behind = -1;
        }
      } finally {
        _gitBehindRefreshing = false;
      }
    }
    _gitCache = {
      hash: BUILD_ID.hash,
      date: BUILD_ID.date,
      behind,
      fetchedAt,
      dirty: (dirtyRaw || '').length > 0,
    };
    _gitCacheTime = Date.now();
  } finally {
    _gitRefreshing = false;
  }
}

function _getGitInfo() {
  // Kick off a refresh if stale (non-blocking).
  const now = Date.now();
  const cheapStale = !_gitCache || (now - _gitCacheTime) > GIT_CACHE_TTL;
  const behindStale = !_gitCache || (now - _gitBehindTime) > GIT_BEHIND_TTL;
  if (cheapStale || behindStale) {
    // Fire and forget. Will complete within a few hundred ms typically,
    // up to the fetch-dry-run 5s timeout for the `behind` calc.
    _gitRefresh(behindStale).catch(() => {});
  }
  if (_gitCache) return _gitCache;
  // Cold start: no cached value at all. The build identity is already known (read at
  // start, above), so answer with it at once rather than reporting `unknown` until the
  // first async refresh lands. Behind=-1 and dirty=false until that refresh arrives.
  _gitCache = { hash: BUILD_ID.hash, date: BUILD_ID.date, behind: -1, fetchedAt: null, dirty: false };
  _gitCacheTime = Date.now();
  return _gitCache;
}

// Helper: fetch with timeout (works with http and https)
function clusterFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const timeout = opts.timeout || 5000;

    const reqOpts = {
      method: opts.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: Object.assign({}, opts.headers || {}),
      rejectUnauthorized: false // Tailscale certs are valid but we're lenient
    };
    if (opts.body) reqOpts.headers['Content-Length'] = Buffer.byteLength(opts.body);

    const r = lib.request(reqOpts, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, body }));
    });

    r.setTimeout(timeout, () => { r.destroy(); reject(new Error('Timeout')); });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// G8: the features THIS server implements — the ONE list. A client gates a
// per-session action on the capability of the server that OWNS that session,
// because the fleet is upgraded one box at a time and a mixed fleet is the NORMAL
// state, not an edge case (never assume a homogeneous cluster). Served two ways
// from this one function: verbatim on /api/version, and attached to every entry of
// `servers[]` on /api/cluster/sessions (a peer's own /api/version answer, fetched
// in the same fan-out) so a browser can tell, before it offers a control, whether
// the owning server can even take the write. 'fcm' is advertised only when a
// service account is configured — a server with no FCM key can still take device
// registrations but won't send FCM.
function serverCapabilities() {
  const caps = ['attention', 'clear', 'attention-clear', 'push-devices', 'transcript',
    'status-metrics', 'pending-question', 'subagent-trace', 'favorites-sync',
    // #72 — POST /api/claude-status understands the RAW statusline payload, not just
    // the legacy flat push. The compatibility runs one way only: this server reads both
    // shapes, but an OLDER server reads the raw one as four absent numbers and stores a
    // blank report over a good one. So scripts/install-statusline.js gates on this
    // capability and refuses to install the new pusher against a server without it —
    // the deploy order (server first, pusher second) is enforced, not documented.
    'claude-status-raw',
    // #131 - GET /api/commands publishes the per-command lens policy, so a client
    // knows which slash commands have a result it can render and which are TUI-only.
    // A client that does not see this capability keeps its built-in fallback table.
    'command-policy',
    // #152 - /api/version and /api/cluster/sessions' servers[] entries carry a
    // `resources` object (machine-wide CPU%/memory). A client gates on this to tell
    // "peer too old to report" apart from a genuine 0% — the same reason every other
    // capability here exists.
    'resources',
    // #152 levels 2/3 - GET /api/resources answers what web-terminal itself costs on this
    // box and what each session costs. A client gates its resources view on this so a
    // peer too old to answer shows "unknown" instead of a 404 the user reads as a broken
    // button - the same reason every other capability here exists.
    'session-resources',
    // #298 - session rows carry `brief` (the sessions dashboard), PATCH
    // /api/sessions/:id/brief pins a work item or opts a session out, and
    // GET /api/dashboard/closed lists sessions that ended in the last day.
    'session-brief',
    // #315 - /api/version and the cluster's servers[] carry this machine's `serverColor`.
    'server-color',
    // #314 - PATCH /api/sessions/:id/brief takes `hidden`; the brief publishes it.
    'session-hide',
    // #313 - every session row carries `reason` (lib/session-reason.js) and a brief
    // carries the agent's reported `wait`.
    'session-reason',
    // #320 - PATCH /api/sessions/:id/brief takes {clearWait: true}. Clients offer
    // "Not waiting" only where this is advertised: an older server would accept the
    // PATCH, ignore the key and answer 200, so the click would silently do nothing.
    'session-clear-wait',
    // #445 - PATCH /api/sessions/:id/brief takes {inboxDismiss: {add|remove}} and the
    // brief carries `inboxDismissed`. Where this is not advertised a client keeps a
    // dismissal on its own device only (an older server would ignore the key).
    'inbox-dismiss',
    // #331 - GET /api/machine: disk, memory, virtual memory, load and session count, for
    // the dashboard's Machines section. A client asks only a server that advertises it.
    'machine-profile',
    // #340 - session rows carry `handoff`, and POST/DELETE /api/sessions/:id/handoff
    // start and cancel one. An older server would 404 the button.
    'session-handoff',
    // #383 - GET /api/sessions/:id/digest: a model-written summary of one inbox wait.
    // A client asks only a server that advertises it; an older peer would 404 the route.
    'inbox-digest',
    // #389 - GET /api/claude-account and POST .../switch, .../save: this machine's
    // Claude login. The companion offers "Switch account" only where it is advertised.
    'claude-account',
    // #413 - GET /api/work-items/:ref[/events] (the work-item event log) and
    // `machineCapabilities` on /api/version, /api/machine and the cluster's servers[].
    'work-items',
    // #502 - GET /api/work-items/:ref/meta and /api/work-items/meta?refs=: a work item's
    // details from its tracker (lib/tracker-meta.js). Any server answers, from its own cache.
    'work-item-meta',
    // #501 - GET /api/mc/* (Mission Control). Only the authority answers; a peer says which.
    'mission-control',
    // #504/#505 - GET /api/mc/subjects[/:key], `stage` on report items and `counts.stages` on
    // /api/mc/projects. An older authority would 404 the subjects routes.
    'mc-subjects',
    // #506 - GET /api/mc/now, POST /api/mc/todo[/:id] and POST /api/mc/later (lib/mc-needs.js).
    'mc-needs',
    // #522 - action waits: GET /api/mc/now `actions` (My to-do) and POST /api/mc/actions/done.
    'mc-actions',
    // #512 - POST /api/mc/start and GET /api/mc/machines (Start work).
    'mc-start',
    // #523 - GET /api/mc/lines, POST /api/mc/lines/move, `line` on subjects, `?line=`, `lines`
    // on /api/mc/now, a report's optional `line` and Start work's `line`/`lineName`.
    'mc-lines',
    // #547 - POST /api/mc/tell, and `answeredIn` on a wait the person answered in another session.
    'mc-tell'];
  // #412/#428 - GET /api/leases (forwarded to the lease authority). The companion's Leases
  // section asks only a server that advertises it: an older one would 404, which must
  // never read as "nobody holds anything". Like 'fcm', only where it is configured: a
  // server with no leases.authority would answer every read with a 503.
  const leasesCfg = liveConfig('leases', undefined);
  if (leasesCfg && typeof leasesCfg === 'object' && leasesCfg.authority) caps.push('leases');
  if (fcmConfigured()) caps.push('fcm');
  return caps;
}

// --- API: version info (for cluster version checking) ---
// Reads from the 30s cache so the endpoint never blocks. See _getGitInfo()
// for the caching strategy. Peer cross-polling (every 5s from each browser)
// previously drove `git fetch --dry-run` on the hot path which blocked the
// event loop for up to 5s under network trouble.
app.get('/api/version', (req, res) => {
  const info = _getGitInfo();
  res.json({
    // `version` is the RELEASE number (moves when the owner cuts one). The BUILD is
    // `hash` + `date`: the commit this process was started from and that commit's date,
    // fixed at start (lib/build-id.js), so they say what code is RUNNING, not what the
    // checkout now holds. A deploy check compares `hash` to the commit it expects.
    version: SERVER_VERSION,
    hash: info.hash,
    date: info.date,
    behind: info.behind,
    // #248 — when the ref `behind` was measured against was last actually updated, in ms
    // since the epoch, or null when that cannot be read. ADDITIVE: an older peer parsing
    // this response ignores a field it does not know, and `behind` keeps its existing
    // shape (a count, or -1 for "could not tell"). It is published alongside rather than
    // folded into `behind` because it answers a different question - `behind` is "how far
    // back am I", this is "how much is that claim worth" - and a caller that sees
    // `behind: -1` needs it to tell "the remote is unreachable" from "nobody has fetched
    // here since Friday".
    fetchedAt: info.fetchedAt !== undefined ? info.fetchedAt : null,
    dirty: info.dirty,
    serverName: getServerName(),
    serverColor: getServerColor(),
    // #413 - what this machine is for (config), or null when the list is malformed.
    machineCapabilities: localMachineCapabilities(),
    // The version of the WORKER actually attached right now — not the one on disk.
    // A hot reload restarts only server.js, so `version` and `worker` move
    // independently, and a worker-side feature can be merged, pulled and reported
    // shipped while the old worker keeps running it inertly (#185: WORKER_VERSION
    // 0.6.2 -> 0.7.0 for #179). Reading it off disk instead would answer the wrong
    // question, and this costs nothing — the worker already sends it at handshake.
    // null when no worker is attached, which is itself the answer.
    worker: workerClient.workerVersion(),
    capabilities: serverCapabilities(),
    // #152 — rides this existing answer (already fetched once per peer by the cluster
    // fan-out below) rather than opening a second endpoint or a second round trip.
    resources: _resourceSampler.read(),
  });
});

// --- API: resource detail (#152 levels 2 and 3) ---
// The machine-wide reading (level 1) rides /api/version and the cluster merge above,
// because it is free. THIS endpoint is the expensive half: it spawns a whole-machine
// process query (~370 ms) to answer "what is web-terminal itself costing here?" and
// "which session should I close?".
//
// It is ON DEMAND on purpose, and that is the single most load-bearing decision in the
// feature. The sidebar polls three servers continuously; putting a process query on that
// path would spawn PowerShell every couple of seconds on every box forever, to compute
// numbers nobody is looking at (the house precedent is the session recap — same rule,
// same reason). Both clients call this only while a resources view is actually open.
//
// `machine` is repeated here rather than made a second source of truth: it comes from the
// same warm sampler as /api/version, so a client that only wants this endpoint gets a
// complete picture in one request instead of having to join two.
//
// A peer's answer is reached through the existing generic /cluster/:url/api/* proxy — no
// new fan-out (#152 hint 3), and no fan-out AT ALL for the companion, which already talks
// to every server directly.
app.get('/api/resources', async (req, res) => {
  try {
    let sessions = [];
    try {
      const r = await workerClient.rpc('listSessions');
      sessions = (r && r.sessions) || [];
    } catch (e) {
      // The worker being unreachable costs the per-session slice, not the whole answer:
      // the machine reading is ours and still true.
    }
    const roots = sessions
      .filter(s => typeof s.pid === 'number' && s.pid > 0)
      .map(s => ({ key: 's:' + s.id, rootPid: s.pid }));
    // A session's pid is only as good as the moment it was read: the shell may have
    // exited since, and Windows hands the number straight back out to something else.
    // Naming the shells a session root may legitimately BE — the standard ones plus
    // whatever this box is configured to spawn, so the guard cannot silently blank an
    // unusual setting — makes a stranger's tree unreportable rather than reported.
    const rootNames = processTree.sessionRootNames(spawnShellName());
    // One snapshot pair answers every group, including web-terminal's own tree (rooted by
    // climbing OUR ancestry to the monitor — nothing here has to be told a pid).
    const reading = await processTree.readTrees(roots, { selfPid: process.pid, rootNames });

    // The body is shaped by a PURE function so the degraded answer — the one that only
    // shows up on a box that cannot run the query — is as testable as the happy one.
    // `machine` (level 1) is passed in from the warm sampler and survives a failed
    // process query, because it never depended on one.
    res.json(processTree.shapeReport({
      machine: _resourceSampler.read(),
      reading,
      sessions,
      ts: Date.now(),
      cpuCount: os.cpus().length,
    }));
  } catch (e) {
    console.error('resources failed:', e.message);
    res.status(500).json({ error: 'Failed to read resources' });
  }
});

// --- API: machine profile (#331) ---
// Everything the dashboard's Machines section shows for THIS server, in one answer:
// "which machine should I open a new session on?". Rules and costs are in
// lib/machine-profile.js. ON DEMAND like /api/resources: commit and the drive list cost a
// CIM query, so both clients ask only while the section is open, and the module caches
// it for a minute. CPU and memory come from the warm sampler and cost nothing.
// `?part=sessions` (#421, the companion's new-session sheet) skips the CIM query: commit
// and drives come back unknown (null), the session count and level at once.
//
// The query is awaited for at most MACHINE_QUERY_WAIT_MS. Past that the answer goes out
// with those fields unknown and the query keeps running into the cache for the next poll:
// a hung PowerShell must not hold the request (#280).
const MACHINE_QUERY_WAIT_MS = 8000;
/** The GET /api/machine body; also what a lease's `needs` is checked against (#412). */
async function readMachineProfile({ withOs = true } = {}) {
  // Both slow halves run TOGETHER and share one bound: the worker's RPC is capped at
  // the same wait as the query, so a stalled worker event loop (seconds, fleet-wide)
  // costs the session count and never holds the whole answer for the default 30s.
  let timer;
  const [sessions, osPart] = await Promise.all([
    workerClient.rpc('listSessions', {}, MACHINE_QUERY_WAIT_MS)
      .then((r) => countedSessions(r && r.sessions), () => null), // #475
    withOs ? Promise.race([
      machineProfile.readOsPart(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), MACHINE_QUERY_WAIT_MS); }),
    ]) : null,
  ]);
  clearTimeout(timer);
  const host = machineProfile.hostFacts();
  return machineProfile.shapeProfile({
    name: getServerName(),
    resources: _resourceSampler.read(),
    os: osPart,
    cpuCount: host.cpuCount,
    uptimeSec: host.uptimeSec,
    sessions,
    maxSessions: SESSIONS_SOFT_LIMIT,
    ts: Date.now(),
  });
}
app.get('/api/machine', async (req, res) => {
  try {
    // #413 - what this machine is FOR (config `machineCapabilities`), for a dispatcher
    // picking the least-loaded machine that has X. null + the reason when malformed.
    const caps = workItems.machineCapabilities(liveConfig('machineCapabilities', null));
    const profile = await readMachineProfile({ withOs: req.query.part !== 'sessions' });
    res.json({ ...profile, capabilities: caps.capabilities, capabilitiesError: caps.error });
  } catch (e) {
    console.error('machine profile failed:', e.message);
    res.status(500).json({ error: 'Failed to read the machine profile' });
  }
});

// --- API: #502 a work item's details, from its tracker (lib/tracker-meta.js) ---
// The rules and the cache are the lib; this is the I/O: tokens, base URLs, the cache file.
// Any server answers, from its own cache. Under WT_TEST the suite points both trackers at a
// local fake (WT_MC_GITHUB_API / WT_MC_ADO_URL) and never reads a real token.
const MC_TRACKER_CACHE_FILE = process.env.WT_MC_TRACKER_CACHE_FILE || path.join(__dirname, 'mc-tracker-cache.json');
let _mcGhToken = { at: 0, value: null };
/** GitHub token: GITHUB_TOKEN / GH_TOKEN, else `gh auth token` (cached 10 min), else none
 *  (anonymous: a public repo still answers). Never logged, never sent anywhere but GitHub. */
async function mcGithubToken() {
  if (process.env.WT_TEST === '1') return process.env.WT_MC_GITHUB_TOKEN || null;
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (Date.now() - _mcGhToken.at < 10 * 60 * 1000) return _mcGhToken.value;
  _mcGhToken = { at: Date.now(), value: null };
  try {
    const { stdout } = await _execFileP('gh', ['auth', 'token'], { timeout: 5000, windowsHide: true });
    _mcGhToken.value = String(stdout).trim() || null;
  } catch { /* gh missing or not logged in: anonymous */ }
  return _mcGhToken.value;
}
/** The ADO org: config `mc.ado.org`, else the supervisor's `supervisor.ado.org`. */
function mcAdoOrg() {
  const mc = liveConfig('mc', null);
  const org = mc && mc.ado && mc.ado.org;
  if (typeof org === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(org)) return org;
  const sup = supervisorCfg().ado;
  return (sup && sup.org) || null;
}
const mcTrackerMeta = trackerMeta.createTrackerMeta({
  store: trackerMeta.createMetaStore({ file: MC_TRACKER_CACHE_FILE }),
  adoOrg: mcAdoOrg,
  read: trackerMeta.createReader({
    fetchJson: trackerMeta.httpFetchJson(),
    githubApi: (process.env.WT_TEST === '1' && process.env.WT_MC_GITHUB_API) || 'https://api.github.com',
    adoBase: (process.env.WT_TEST === '1' && process.env.WT_MC_ADO_URL) || 'https://dev.azure.com',
    githubToken: mcGithubToken,
    adoOrg: mcAdoOrg,
    // The supervisor's reader (one PAT reader, never two); the suite's own under WT_TEST.
    adoPat: async () => (process.env.WT_TEST === '1' ? (process.env.WT_MC_ADO_PAT || null) : adoPat()),
  }),
});
const mcRepoParam = (req) => (typeof req.query.repo === 'string' ? req.query.repo : undefined);
// Registered BEFORE /api/work-items/:ref, which would otherwise read "meta" as a ref.
app.get('/api/work-items/meta', async (req, res) => {
  const raw = typeof req.query.refs === 'string' ? req.query.refs : '';
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return res.status(400).json({ error: 'refs is required: a comma-separated list of work-item refs' });
  if (parts.length > trackerMeta.MAX_BATCH) return res.status(400).json({ error: `at most ${trackerMeta.MAX_BATCH} refs` });
  const repo = mcRepoParam(req);
  if (repo !== undefined && repo !== '' && !trackerMeta.parseRef('#1', { repo })) return res.status(400).json({ error: 'repo must be owner/repo' });
  const refs = [];
  for (const p of parts) {
    const r = trackerMeta.parseRef(p, { repo });
    if (!r) return res.status(400).json({ error: `not a work-item ref: ${p.slice(0, 60)} (ado:123, #123 or owner/repo#123)` });
    if (!refs.some((x) => x.key === r.key)) refs.push(r);
  }
  try {
    const metas = await mcTrackerMeta.getMany(refs);
    const items = {};
    for (const m of metas) items[m.key] = m;
    res.json({ items, generatedAt: Date.now() });
  } catch (e) {
    console.error(`[tracker-meta] batch: ${e.message}`);
    res.status(500).json({ error: 'could not read the tracker details' });
  }
});
app.get('/api/work-items/:ref/meta', async (req, res) => {
  const r = trackerMeta.parseRef(req.params.ref, { repo: mcRepoParam(req) });
  if (!r) return res.status(400).json({ error: 'not a work-item ref (ado:123, #123 or owner/repo#123); repo, when given, is owner/repo' });
  if (r.unqualified) return res.status(400).json({ error: 'a bare #N names no repo: ask for owner/repo#N, or pass ?repo=owner/repo' });
  try {
    res.json({ ...(await mcTrackerMeta.get(r)), generatedAt: Date.now() });
  } catch (e) {
    console.error(`[tracker-meta] ${r.key}: ${e.message}`);
    res.status(500).json({ error: 'could not read the tracker details' });
  }
});

// --- API: #503/#504/#505 Mission Control: subjects, runs, projects and areas ---
/** A cluster row's git origin, for lib/projects.js: this server's own sessions have one it can
 *  read; a peer's cwd is on the peer, so its project comes from its folder (`paths`), else from
 *  the items it reported (originFromItems, #524). One rule for the Mission Control view and
 *  /api/mc/ask. */
function mcRowOrigin(s) {
  return s.server === getServerName() && !s.serverUrl ? originForCwd(s.cwd) : null;
}
// Answered by the authority only (lib/mc-authority.js); every other server says which one.
// ONE view feeds every route below: the cluster view (cachedClusterSessions), every server's
// closed strip (this one's from the brief store, each peer's GET /api/dashboard/closed), the
// tracker details (their own cache: a poll never waits on a tracker for more than
// MC_META_WAIT_MS) and the stored stage history. The rules are lib/mc-subjects.js,
// lib/mc-stage.js and lib/projects.js; this is the I/O.
const MC_STATE_FILE = process.env.WT_MC_STATE_FILE || path.join(__dirname, 'mc-state.json');
const mcState = mcStateLib.createMcState({ file: MC_STATE_FILE });
const MC_VIEW_TTL_MS = 3000;
const MC_PEER_CLOSED_TTL_MS = 30 * 1000;
const MC_META_WAIT_MS = 1500;
const _mcPeerClosed = new Map(); // peer url -> {at, closed, ok}
const _mcViewCache = new Map(); // request user -> {ts, promise}
const _mcPromptEpisodes = createPromptEpisodes();

/** A peer's closed strip, cached; a failed read keeps the last copy and says it is not ok. */
async function mcPeerClosed(url, token) {
  const hit = _mcPeerClosed.get(url);
  if (hit && Date.now() - hit.at < MC_PEER_CLOSED_TTL_MS) return hit;
  let entry = null;
  try {
    const r = await clusterFetch(`${url}/api/dashboard/closed`, { headers: { Authorization: `Bearer ${token}` }, timeout: 3000 });
    const j = r.ok ? JSON.parse(r.body) : null;
    if (j && Array.isArray(j.closed)) entry = { at: Date.now(), closed: j.closed.filter((c) => c && typeof c === 'object' && typeof c.id === 'string'), ok: true };
  } catch { /* unreachable or not JSON: not ok, below */ }
  if (!entry) entry = { at: Date.now(), closed: hit ? hit.closed : [], ok: false };
  _mcPeerClosed.set(url, entry);
  return entry;
}

async function _computeMcView(reqUser) {
  const cfg = projectsLib.validateProjects(liveConfig('projects', undefined));
  if (!cfg.ok) return { error: `config.json projects is not valid: ${cfg.error}` };
  const cluster = await cachedClusterSessions(reqUser);
  const now = Date.now();
  const me = getServerName();
  const rows = (Array.isArray(cluster.sessions) ? cluster.sessions : []).map((s) => ({ ...s, origin: mcRowOrigin(s) }));
  const closed = briefLib.liveClosed(briefStore().closed, now).map((rec) => ({ server: me, serverUrl: null, rec, origin: originForCwd(rec.cwd) }));
  const tokens = loadClusterTokens();
  const peers = (Array.isArray(cluster.servers) ? cluster.servers : []).filter((s) => s && s.url);
  const peerAnswers = await Promise.all(peers.map(async (p) => {
    const tok = tokens[p.url];
    if (!p.online || p.needsAuth || !tok || !tok.token) return { name: p.name, ok: false, closed: [] };
    const c = await mcPeerClosed(p.url, tok.token);
    return { name: p.name, ok: c.ok, closed: c.closed.map((rec) => ({ server: p.name, serverUrl: p.url, rec, origin: null })) };
  }));
  for (const a of peerAnswers) closed.push(...a.closed);
  const servers = [{ name: me, ok: true }, ...peerAnswers.map((a) => ({ name: a.name, ok: a.ok }))];

  // #512 - a session started from Start work is on its project and subjects from birth.
  // The bindings that still reach a listed session are kept alive (a long run keeps its own).
  const usedBindings = new Set();
  const nodes = mcBinding.applyBindings(mcSubjects.sessionNodes({ rows, closed, now }), mcState.bindings(), usedBindings);
  mcState.touchBindings(usedBindings);
  // #506 - when each prompt on screen came up: its card's one id while it stays up.
  _mcPromptEpisodes.observe(nodes, now);
  const refs = mcSubjects.trackerKeys(nodes).map((k) => trackerMeta.parseRef(k)).filter((r) => r && !r.unqualified);
  // Start the reads (cold and stale) and wait a little; whatever has not arrived is served
  // as the cache holds it now, and arrives on a later poll.
  // A failed read never fails the view: the cache answers for it below.
  const reads = mcTrackerMeta.getMany(refs).catch((e) => console.error(`[mc] tracker details: ${e.message}`));
  await Promise.race([reads, new Promise((r) => { const t = setTimeout(r, MC_META_WAIT_MS); if (t.unref) t.unref(); })]);
  const metaByKey = {};
  for (const m of await Promise.all(refs.map((r) => mcTrackerMeta.peek(r)))) metaByKey[m.key] = m;
  // #523 - the parent chain the line rule climbs (lib/mc-lines.js readParents): one more short
  // wait shared by every level; what has not arrived by then lands on a later poll.
  await mcLines.readParents({ metaByKey, parseRef: trackerMeta.parseRef, getMany: mcTrackerMeta.getMany, peek: mcTrackerMeta.peek,
    waitMs: MC_META_WAIT_MS, log: (m) => console.error(`[mc] tracker details (parents): ${m}`) });
  const view = mcSubjects.buildView({ nodes, metaByKey, projects: cfg.projects, stageStore: mcState, lineOverrides: mcState.lineOverrides(), now });
  const boundOf = new Map(nodes.map((n) => [n.id, n.boundProject]));
  // #532 - the dispatcher is the supervisor, not a session of any project.
  const sessions = rows.filter((s) => !mcSubjects.isSupervisor(s)).map((s) => ({ cwd: s.cwd, origin: s.origin, items: s.brief && s.brief.items, bound: boundOf.get(s.id) }));
  // Computed once: GET /api/mc/projects serves it, and its area ids are what ?area= takes.
  const projectsOut = projectsLib.projectsView({ projects: cfg.projects, sessions, subjects: view.subjects, waits: view.waits });
  // #523 - one row per line of work (GET /api/mc/lines, /api/mc/now).
  const linesOut = mcLines.linesView({ subjects: view.subjects, projects: cfg.projects, waits: view.waits });
  return { ...view, nodes, servers, projectsOut, linesOut, configuredLines: mcLines.configuredLines(cfg.projects), generatedAt: now };
}
/** The view through a short cache: one compute in flight at a time, and its answer reused for
 *  MC_VIEW_TTL_MS after it ARRIVES (a slow compute never overlaps the next). */
function cachedMcView(reqUser) {
  const now = Date.now();
  let entry = _mcViewCache.get(reqUser);
  if (!entry || (entry.doneAt !== null && now - entry.doneAt > MC_VIEW_TTL_MS)) {
    const e = { doneAt: null, promise: null };
    e.promise = _computeMcView(reqUser).then((v) => { e.doneAt = Date.now(); return v; }, (err) => {
      if (_mcViewCache.get(reqUser) === e) _mcViewCache.delete(reqUser);
      throw err;
    });
    _mcViewCache.set(reqUser, e);
    entry = e;
  }
  return entry.promise;
}
/** `?project=` / `?area=`: absent, or one short string. */
function mcFilterParam(v, max = 80) {
  if (v === undefined || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || v.length > max) return { ok: false };
  return { ok: true, value: v };
}

app.get('/api/mc/projects', async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    res.json({ projects: v.projectsOut, generatedAt: v.generatedAt });
  } catch (e) {
    console.error(`[mc] projects: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

/** #522 - a subject's action card carries its Done record, as My to-do's does
 *  (lib/mc-needs.js withDone): both screens agree on whether Done is offered. The cached view
 *  is shared, so this copies, never mutates. */
function mcSubjectsWithDone(subjects) {
  const done = mcNeeds.pruneActionsDone(mcState.actionsDone(), Date.now());
  return subjects.map((s) => (s.needsYou && s.needsYou.kind === 'action' ? { ...s, needsYou: mcNeeds.withDone(s.needsYou, done) } : s));
}
/** #546 - the same for the waits that name no item (a card of kind action carries its Done record; a
 *  question card its questions, as on Now and a subject's page: the card at the top of a line or
 *  project page is the question's only place). A copy: the cached view is shared. */
async function mcWaitsWithFaces(waits) {
  const done = mcNeeds.pruneActionsDone(mcState.actionsDone(), Date.now());
  const faced = await mcCardFaces(waits.map((w) => w.card));
  return waits.map((w, i) => ({ ...w, card: w.card.kind === 'action' ? mcNeeds.withDone(w.card, done) : faced[i] }));
}

app.get('/api/mc/subjects', async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const project = mcFilterParam(req.query.project);
  const area = mcFilterParam(req.query.area);
  const line = mcFilterParam(req.query.line, 300);
  if (!project.ok || !area.ok) return res.status(400).json({ error: 'project and area must each be one id of at most 80 characters' });
  if (!line.ok) return res.status(400).json({ error: 'line must be one line id of at most 300 characters' });
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    const f = mcSubjects.filterView(v, { project: project.value, area: area.value, line: line.value }, { projectsView: v.projectsOut });
    res.json({ subjects: mcSubjectsWithDone(f.subjects), runs: f.runs, waits: await mcWaitsWithFaces(f.waits), servers: v.servers, stages: mcStage.STAGES, generatedAt: v.generatedAt });
  } catch (e) {
    console.error(`[mc] subjects: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

app.get('/api/mc/subjects/:key', async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const raw = String(req.params.key || '');
  if (!raw || raw.length > 300) return res.status(400).json({ error: 'a subject key is required (owner/repo#123, ado:123)' });
  // A tracker ref in any spelling (AB#, case) names its canonical key; anything else is
  // matched as given (a subject of one session: `<key>@<session id>`).
  const r = trackerMeta.parseRef(raw);
  const key = r && !r.unqualified ? r.key : raw;
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    const subject = v.subjects.find((x) => x.key === key);
    if (!subject) return res.status(404).json({ error: 'no session touched that work item in the last 7 days' });
    const out = { ...mcSubjectsWithDone([subject])[0] }; // a copy: the cached view is shared
    // #531: its needs-you card shows its questions as the card on Now does.
    if (out.needsYou && out.needsYou.kind === 'question') out.needsYou = (await mcCardFaces([out.needsYou]))[0];
    res.json({ subject: out, runs: v.runs.filter((x) => x.subjects.includes(subject.key)), stages: mcStage.STAGES, generatedAt: v.generatedAt });
  } catch (e) {
    console.error(`[mc] subject: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

// --- API: #523 Mission Control: lines of work ---
// The rule is lib/mc-lines.js (which line each work item is on, the lines view, what a Move
// may target); the lines come from the same view as the subjects (cachedMcView). A Move is the
// person's override, stored on the authority (mc-state.json lineOverrides) and winning over
// every rule; `line: null` hands the item back to the rules.
app.get('/api/mc/lines', async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const project = mcFilterParam(req.query.project);
  if (!project.ok) return res.status(400).json({ error: 'project must be one id of at most 80 characters' });
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    res.json({ lines: mcLines.filterLines(v.linesOut, { project: project.value }),
      configured: mcLines.filterLines(v.configuredLines, { project: project.value }), generatedAt: v.generatedAt });
  } catch (e) {
    console.error(`[mc] lines: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

app.post('/api/mc/lines/move', express.json({ limit: '4kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const raw = typeof b.subject === 'string' ? b.subject : '';
  if (!raw || raw.length > 300) return res.status(400).json({ error: 'subject is required: a subject key from /api/mc/subjects' });
  const r = trackerMeta.parseRef(raw);
  const key = r && !r.unqualified ? r.key : raw;
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    if (!v.subjects.some((s) => s.key === key)) return res.status(404).json({ error: 'no session touched that work item in the last 7 days' });
    const cfg = projectsLib.validateProjects(liveConfig('projects', undefined));
    const t = mcLines.moveTarget({ line: b.line, name: b.name }, { projects: cfg.ok ? cfg.projects : [], lines: v.linesOut });
    if (!t.ok) return res.status(400).json({ error: t.error });
    if (!mcState.setLineOverride(key, t.line)) return res.status(500).json({ error: 'the move could not be saved' });
    _mcViewCache.clear();
    const after = await cachedMcView(clusterReqUser(req));
    const subject = after.subjects && after.subjects.find((s) => s.key === key);
    res.json({ subject: key, line: subject ? subject.line : null, generatedAt: Date.now() });
  } catch (e) {
    console.error(`[mc] lines move: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

// --- API: #506 Mission Control: Answer now vs My to-do ---
// The rules are lib/mc-needs.js (what waits on the person, the rank and its why, what each
// to-do action may do, the park message); the cards come from the same view as the subjects
// (cachedMcView), and the to-dos and "later"s live in mc-state.json (lib/mc-state.js), on
// the authority only. Moving a card to My to-do tells its session ONCE, through the gated
// prompt of the session's own server (deliverGatedPrompt, the supervisor's path): the to-do
// is written to disk BEFORE the message goes out, so nothing ever sends it twice, and a
// refusal (a draft, a turn running) is answered, never retried on its own (#479).
const MC_TODO_ID_RE = /^t-[0-9a-f]{16}$/;

/** Change one stored to-do: `{todo, ok}` (ok: stored, on disk when [writeNow]; a failed write
 *  leaves the stored list as it was), or null when it is gone. */
function mcUpdateTodo(id, fn, writeNow) {
  const before = mcState.todos();
  const list = before.slice();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = fn(list[i]);
  const ok = mcState.setTodos(mcNeeds.pruneTodos(list, Date.now()), { now: writeNow });
  if (!ok) mcState.setTodos(before);
  return { todo: list[i], ok };
}

/** Send to-do [todo]'s park message (its body was fixed when the to-do was made) and record
 *  the answer. An error here is "it may have landed": never sent again. */
async function mcPark(todo) {
  const body = (todo.park && todo.park.body) || {};
  let out;
  try {
    out = await deliverGatedPrompt({ server: todo.server, id: todo.sessionId, text: body.text, expectWaitAt: body.expectWaitAt }, 'mission-control');
  } catch (e) {
    console.error(`[mc] park message: ${e.message}`);
    out = { uncertain: true };
  }
  const now = Date.now();
  const u = mcUpdateTodo(todo.id, (t) => mcNeeds.parkResult(t, out, now), true);
  return u ? u.todo : mcNeeds.parkResult(todo, out, now);
}

// #531 - a question card shows its questions. The wait's own words ("answer a question") say
// nothing: the questions are on the session's screen, so each question card's pending question is
// read from ITS server (in-process, or a peer's route with the stored token) and its face
// (lib/mc-questions.js faceOf) rides the card as `questions`. Read once per card (the id names the
// wait), kept 30 s; a poll waits at most MC_FACE_WAIT_MS for the reads it started and serves what
// the cache holds, the rest arrives on the next poll. An unreadable one is `questions: null` and
// the card says its text could not be read here. Never a write, never a model run.
const MC_FACE_WAIT_MS = 1500;
const mcFaces = mcQuestions.createFaceCache();
const mcFaceReads = new Map(); // card id -> the read in flight (a second poll shares it)

async function mcCardFaces(cards, { keep = null } = {}) {
  const now = Date.now();
  const list = cards.filter((c) => c && c.kind === 'question' && c.sessionId);
  // Drop the faces of waits that are gone: judged against EVERY pending card (a deferred question is no answer-now card but its subject page still shows it).
  if (keep) mcFaces.prune(new Set(keep.filter((c) => c && c.kind === 'question' && c.sessionId).map((c) => c.id)));
  const reads = [];
  for (const c of list) {
    if (mcFaces.get(c.id, now).known) continue;
    if (!mcFaceReads.has(c.id)) {
      const p = (async () => {
        const q = await mcSessionRead({ id: c.sessionId, serverUrl: c.serverUrl || null }, sessionPendingQuestion, 'pending-question');
        mcFaces.set(c.id, mcQuestions.faceOf(c, q && q.pending && q.question ? q.question : null), Date.now());
      })().catch((e) => { console.error(`[mc] card face: ${e.message}`); }).finally(() => mcFaceReads.delete(c.id));
      mcFaceReads.set(c.id, p);
    }
    reads.push(mcFaceReads.get(c.id));
  }
  if (reads.length) {
    let timer;
    await Promise.race([Promise.all(reads), new Promise((r) => { timer = setTimeout(r, MC_FACE_WAIT_MS); })]);
    clearTimeout(timer);
  }
  const at = Date.now();
  return cards.map((c) => (c && c.kind === 'question' && c.sessionId ? { ...c, questions: mcFaces.get(c.id, at).face || null } : c));
}

app.get('/api/mc/now', async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    const now = Date.now();
    const n = mcNeeds.buildNow({ nodes: v.nodes, view: v, todos: mcState.todos(), later: mcNeeds.pruneLater(mcState.later(), now),
      actionsDone: mcNeeds.pruneActionsDone(mcState.actionsDone(), now), now });
    res.json({ answerNow: await mcCardFaces(n.answerNow, { keep: n.pending }), actions: n.actions, todo: n.todo, moving: n.moving, projects: v.projectsOut, lines: v.linesOut, generatedAt: v.generatedAt });
  } catch (e) {
    console.error(`[mc] now: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

app.post('/api/mc/todo', express.json({ limit: '8kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const inp = mcNeeds.todoInput(req.body);
  if (inp.error) return res.status(400).json({ error: inp.error });
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    // From here to the record on disk nothing awaits: a second press finds this to-do.
    const now = Date.now();
    const todos = mcState.todos();
    const existing = todos.find((t) => t.cardId === inp.cardId);
    if (existing) {
      // Its session was already told (or refused): moving the card again never tells it twice.
      let todo = existing;
      if (existing.state === 'back') {
        const u = mcUpdateTodo(existing.id, (t) => ({ ...t, state: 'open', backAt: null, doneAt: null, text: inp.text || t.text }), true);
        if (!u || !u.ok) return res.status(500).json({ error: 'could not record the to-do' });
        todo = u.todo;
      }
      return res.json({ todo: mcNeeds.publicTodo(todo), parked: mcNeeds.parkedAnswer(todo, { already: true }), generatedAt: now });
    }
    const card = mcNeeds.pendingCards({ nodes: v.nodes, view: v, now }).find((c) => c.id === inp.cardId);
    if (!card) return res.status(404).json({ error: 'that card no longer waits on you' });
    const notTodo = mcNeeds.todoRefusal(card);
    if (notTodo) return res.status(notTodo.status).json({ error: notTodo.error });
    const todo = mcNeeds.newTodo(card, { id: `t-${crypto.randomBytes(8).toString('hex')}`, text: inp.text, now });
    // On disk BEFORE the message goes out; a failed write sends nothing.
    if (!mcState.setTodos(mcNeeds.pruneTodos([...todos, todo], now), { now: true })) {
      mcState.setTodos(todos);
      return res.status(500).json({ error: 'could not record the to-do' });
    }
    const done = todo.park.state === 'sending' ? await mcPark(todo) : todo;
    res.json({ todo: mcNeeds.publicTodo(done), parked: mcNeeds.parkedAnswer(done), generatedAt: Date.now() });
  } catch (e) {
    console.error(`[mc] todo: ${e.message}`);
    res.status(500).json({ error: 'could not record the to-do' });
  }
});

app.post('/api/mc/todo/:id', express.json({ limit: '8kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const id = String(req.params.id || '');
  const action = req.body && typeof req.body === 'object' ? req.body.action : undefined;
  const t = MC_TODO_ID_RE.test(id) ? mcState.todos().find((x) => x.id === id) : null;
  const r = mcNeeds.applyAction(t, action, Date.now());
  if (r.error) return res.status(r.status).json({ error: r.error });
  try {
    // A retried park is marked `sending` on disk before it goes out, like the first one.
    const u = mcUpdateTodo(id, () => r.todo, Boolean(r.park));
    if (!u || !u.ok) return res.status(500).json({ error: 'could not change the to-do' });
    if (!r.park) return res.json({ todo: mcNeeds.publicTodo(u.todo), generatedAt: Date.now() });
    const done = await mcPark(u.todo);
    res.json({ todo: mcNeeds.publicTodo(done), parked: mcNeeds.parkedAnswer(done), generatedAt: Date.now() });
  } catch (e) {
    console.error(`[mc] todo action: ${e.message}`);
    res.status(500).json({ error: 'could not change the to-do' });
  }
});

app.post('/api/mc/later', express.json({ limit: '8kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const inp = mcNeeds.laterInput(req.body);
  if (inp.error) return res.status(400).json({ error: inp.error });
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    const now = Date.now();
    if (!mcNeeds.pendingCards({ nodes: v.nodes, view: v, now }).some((c) => c.id === inp.cardId)) {
      return res.status(404).json({ error: 'that card no longer waits on you' });
    }
    const until = now + inp.hours * 60 * 60 * 1000;
    if (!mcState.setLater({ ...mcNeeds.pruneLater(mcState.later(), now), [inp.cardId]: { until, at: now } })) {
      return res.status(500).json({ error: 'could not put the card off' });
    }
    res.json({ cardId: inp.cardId, until, generatedAt: now });
  } catch (e) {
    console.error(`[mc] later: ${e.message}`);
    res.status(500).json({ error: 'could not put the card off' });
  }
});

// --- API: #522 Mission Control: Done on an action (the person did what a session waits for) ---
// POST /api/mc/actions/done {cardId} -> {cardId, done: {delivered, refused?, reason?, uncertain?,
// already?}, generatedAt}. The rules are lib/mc-needs.js (actionDonePlan, the fixed text); the
// message goes through the gated prompt of the session's own server (deliverGatedPrompt, as the
// park does), so it never lands on an unsent draft (#479). It is recorded ON DISK before it goes
// out and is never sent twice; a refusal is answered and kept, and Done may be pressed again.
app.post('/api/mc/actions/done', express.json({ limit: '8kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const inp = mcNeeds.actionDoneInput(req.body);
  if (inp.error) return res.status(400).json({ error: inp.error });
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    // From here to the record on disk nothing awaits: a second press finds the record.
    const now = Date.now();
    const card = mcNeeds.pendingCards({ nodes: v.nodes, view: v, now }).find((c) => c.id === inp.cardId);
    // The records /api/mc/now reads (pruned): what the person saw is what Done decides on.
    const before = mcNeeds.pruneActionsDone(mcState.actionsDone(), now);
    // Own keys only: a cardId of "constructor" must not read the prototype.
    const plan = mcNeeds.actionDonePlan(card, Object.hasOwn(before, inp.cardId) ? before[inp.cardId] : undefined);
    if (plan.error) return res.status(plan.status).json({ error: plan.error });
    if (plan.already) return res.json({ cardId: inp.cardId, done: mcNeeds.doneAnswer(plan.already, { already: true }), generatedAt: now });
    if (!mcState.setActionsDone(mcNeeds.pruneActionsDone({ ...before, [inp.cardId]: mcNeeds.actionSending(now) }, now), { now: true })) {
      mcState.setActionsDone(before);
      return res.status(500).json({ error: 'could not record the Done' });
    }
    let out;
    try {
      out = await deliverGatedPrompt({ server: card.server, id: card.sessionId, ...mcNeeds.actionDoneBody(card) }, 'mission-control');
    } catch (e) {
      console.error(`[mc] done message: ${e.message}`);
      out = { uncertain: true };
    }
    const rec = mcNeeds.actionDoneResult(out, Date.now());
    mcState.setActionsDone({ ...mcState.actionsDone(), [inp.cardId]: rec }, { now: true });
    res.json({ cardId: inp.cardId, done: mcNeeds.doneAnswer(rec), generatedAt: Date.now() });
  } catch (e) {
    console.error(`[mc] done: ${e.message}`);
    res.status(500).json({ error: 'could not mark it done' });
  }
});

// --- API: #547 Mission Control: Tell it (a wait the person answered in another session) ---
// POST /api/mc/tell {cardId} -> {cardId, tell: {delivered, refused?, reason?, uncertain?}, generatedAt}
// A reported wait whose card says it may have been answered in ANOTHER session (`answeredIn`, lib/mc-subjects.js
// answeredElsewhere) is told so: one fixed message (lib/mc-needs.js tellText) naming that session, what the
// person typed there and its last reply (the recap's, read from its own server; unreadable = left out),
// through the gated prompt of the waiting session's own server (deliverGatedPrompt, as the park does), so it
// never lands on an unsent draft (#479) and is refused `stale` once the session has reported again. Nothing
// is recorded: the message is a note, not a state change (a system turn clears no wait: if the session ends
// its turn without reporting, the card returns marked and Tell it can be pressed again). 400 bad body - 404 the card is gone - 409 not marked / not the authority (mcRefusal).
app.post('/api/mc/tell', express.json({ limit: '8kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const inp = mcNeeds.tellInput(req.body);
  if (inp.error) return res.status(400).json({ error: inp.error });
  try {
    const v = await cachedMcView(clusterReqUser(req));
    if (v.error) return res.status(500).json({ error: v.error });
    const card = mcNeeds.pendingCards({ nodes: v.nodes, view: v, now: Date.now() }).find((c) => c.id === inp.cardId);
    const plan = mcNeeds.tellPlan(card);
    if (plan.error) return res.status(plan.status).json({ error: plan.error });
    const a = card.answeredIn;
    const from = v.nodes.find((x) => x && !x.closed && x.id === a.sessionId && x.server === a.server);
    const recap = await mcSessionRead({ id: a.sessionId, serverUrl: a.serverUrl || null }, sessionRecap, 'recap');
    const reply = recap && !recap.error && recap.reply && typeof recap.reply.text === 'string' ? recap.reply.text : null;
    let out;
    try {
      out = await deliverGatedPrompt({ server: card.server, id: card.sessionId, ...mcNeeds.tellBody(card, { said: from ? from.promptText : null, reply }) }, 'mission-control');
    } catch (e) {
      console.error(`[mc] tell message: ${e.message}`);
      out = { uncertain: true };
    }
    res.json({ cardId: inp.cardId, tell: mcNeeds.tellAnswer(out), generatedAt: Date.now() });
  } catch (e) {
    console.error(`[mc] tell: ${e.message}`);
    res.status(500).json({ error: 'could not tell the session' });
  }
});

// --- API: #511 Mission Control Ask - a read-only Analyst (lib/mc-analyst.js) ---
// POST /api/mc/ask {question, scope: {kind: all|project|subject|session, id}}
//   -> {answer, sources: [Source], dataAge: {oldestAt, newestAt}, cut, scope, model, generatedAt}
//   400 bad body · 404 unknown session/subject/project · 409/503 not the authority (mcRefusal)
//   503 {status:'unavailable', reason: disabled|no-cli|busy} · 502 {status:'failed', reason: timeout|error|bad-output}
// A tools-off model call over a capped bundle of what this server already knows: the cluster
// rows' briefs, recaps for a narrow scope (a local one in-process, a peer's over its own route)
// and the tracker CACHE (never a tracker read). It never types into a session. Config
// `mcAnalyst` ({enabled, model, command, timeoutMs}) is NOT in ALLOWED_CONFIG_KEYS: `command` is
// something this server EXECUTES (the inbox digest's rule).
function mcAnalystConfig() {
  const live = liveConfig('mcAnalyst', {});
  const c = live && typeof live === 'object' && !Array.isArray(live) ? { ...live } : {};
  // Test seams, under WT_TEST only: the suite points the runner at a fake CLI.
  if (process.env.WT_TEST === '1' && process.env.WT_MC_ANALYST_COMMAND) {
    try { c.command = JSON.parse(process.env.WT_MC_ANALYST_COMMAND); } catch { /* ignore a bad override */ }
  }
  if (process.env.WT_TEST === '1' && process.env.WT_MC_ANALYST_TIMEOUT_MS) c.timeoutMs = Number(process.env.WT_MC_ANALYST_TIMEOUT_MS);
  return c;
}
const mcAnalystService = mcAnalyst.createAnalyst({
  getConfig: mcAnalystConfig,
  scratchDir: () => { fs.mkdirSync(SCRATCH_DIRS.analyst, { recursive: true }); return SCRATCH_DIRS.analyst; },
});
/** One read of a session's own route: this server's in-process ([local], `{status, body}`), a
 *  peer's over `/api/sessions/:id/<route>` with the stored token. A failure is `{error}`. */
async function mcSessionRead(row, local, route) {
  try {
    if (!row.serverUrl) {
      const r = await local(row.id);
      return r.status === 200 ? r.body : { error: (r.body && r.body.error) || 'no such session' };
    }
    const t = loadClusterTokens()[row.serverUrl];
    if (!t || !t.token) return { error: 'no token for that server' };
    const r = await clusterFetch(`${row.serverUrl}/api/sessions/${encodeURIComponent(row.id)}/${route}`, { headers: { Authorization: `Bearer ${t.token}` }, timeout: 4000 });
    return r.ok ? JSON.parse(r.body) : { error: `HTTP ${r.status}` };
  } catch { return { error: 'the server did not answer' }; }
}
/** A session's recap for the bundle: this server's in-process, a peer's over its own route. */
function mcAskRecap(row) {
  return mcSessionRead(row, sessionRecap, 'recap');
}
app.post('/api/mc/ask', express.json({ limit: '16kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const v = mcAnalyst.validateAsk(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (v.scope.kind === 'subject') {
    // A tracker ref in any spelling names its canonical key (the subjects route's rule).
    const ref = trackerMeta.parseRef(v.scope.id);
    if (ref && !ref.unqualified) v.scope.id = ref.key;
  }
  const cfg = projectsLib.validateProjects(liveConfig('projects', undefined));
  if (!cfg.ok) return res.status(500).json({ error: `config.json projects is not valid: ${cfg.error}` });
  if (v.scope.kind === 'project' && v.scope.id !== projectsLib.OTHER_ID && !cfg.projects.some((p) => p.id === v.scope.id)) {
    return res.status(404).json({ error: 'no such project' });
  }
  let picked;
  try {
    const { sessions } = await cachedClusterSessions(clusterReqUser(req));
    const rows = (Array.isArray(sessions) ? sessions : []).map((s) => ({ ...s,
      project: projectsLib.projectOfSession({ cwd: s.cwd, origin: mcRowOrigin(s), items: s.brief && s.brief.items }, cfg.projects) }));
    picked = mcAnalyst.selectSessions(rows, v.scope);
  } catch (e) {
    console.error(`[mc] ask: ${e.message}`);
    return res.status(500).json({ error: 'could not read the cluster sessions' });
  }
  if (!picked.length) {
    if (v.scope.kind === 'session') return res.status(404).json({ error: 'no such session in the cluster' });
    if (v.scope.kind === 'subject') return res.status(404).json({ error: 'no session reports that work item' });
    return res.json(mcAnalyst.emptyAnswer(v.scope, Date.now()));
  }
  try {
    const recaps = new Map();
    await Promise.all(mcAnalyst.recapTargets(picked, v.scope).map(async (r) => { recaps.set(r.id, await mcAskRecap(r)); }));
    // The tracker CACHE only (#504's peek: never a tracker read; a copy never read is the blank Meta).
    const metas = new Map();
    await Promise.all(mcAnalyst.itemKeys(picked).map(async (key) => {
      const ref = trackerMeta.parseRef(key);
      if (ref && !ref.unqualified) metas.set(key, await mcTrackerMeta.peek(ref));
    }));
    const metaOf = (key) => metas.get(key) || null;
    const now = Date.now();
    const bundle = mcAnalyst.buildBundle({ rows: picked, metaOf, recaps, now });
    const prompt = mcAnalyst.buildPrompt({ question: v.question, scope: v.scope, bundle, now });
    const out = await mcAnalystService.ask({ question: v.question, scope: v.scope, bundle, prompt });
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error(`[mc] ask: ${e.message}`);
    res.status(500).json({ error: 'the question could not be answered' });
  }
});

// --- API: #512 Mission Control: Start work ---
// GET /api/mc/machines ranks the cluster's machines for a new session (lib/mc-start.js
// machinesView) from the cluster view this server already holds plus each one's restart hold.
// POST /api/mc/start creates the session through the ordinary create path - this server's own
// (createSessionFrom) or a peer's POST /api/sessions with the stored cluster token, as the
// cluster proxy sends it - and records its binding (lib/mc-binding.js) HERE, on the authority,
// so /api/mc/subjects shows it under its subject before it reports anything.
const MC_START_PEER_TIMEOUT_MS = 15000;

/** `{held, reason}` for every server of the cluster view whose restart hold could be read. */
async function mcMachineHolds(servers) {
  const tokens = loadClusterTokens();
  const holds = {};
  await Promise.all(servers.map(async (s) => {
    if (!s.url) { holds[s.name] = _maint.hold ? { held: true, reason: _maint.hold.reason } : { held: false }; return; }
    const tok = tokens[s.url];
    if (!s.online || s.needsAuth || !tok || !tok.token) return;
    try {
      const r = await clusterFetch(`${s.url}/api/maintenance/status`, { headers: { Authorization: `Bearer ${tok.token}` }, timeout: 3000 });
      const j = r.ok ? JSON.parse(r.body) : null;
      if (j && typeof j === 'object') holds[s.name] = j.hold ? { held: true, reason: typeof j.hold.reason === 'string' ? j.hold.reason : null } : { held: false };
    } catch { /* not read: the machine is shown, never suggested */ }
  }));
  return holds;
}

app.get('/api/mc/machines', async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  try {
    const cluster = await cachedClusterSessions(clusterReqUser(req));
    const servers = (Array.isArray(cluster.servers) ? cluster.servers : []).filter((s) => s && typeof s.name === 'string');
    const view = mcStart.machinesView({ servers, rows: cluster.sessions, holds: await mcMachineHolds(servers) });
    res.json({ ...view, generatedAt: Date.now() });
  } catch (e) {
    console.error(`[mc] machines: ${e.message}`);
    res.status(500).json({ error: 'could not read the cluster sessions' });
  }
});

app.post('/api/mc/start', express.json({ limit: '16kb' }), async (req, res) => {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return res.status(refused.status).json(refused.json);
  const cfg = projectsLib.validateProjects(liveConfig('projects', undefined));
  if (!cfg.ok) return res.status(500).json({ error: `config.json projects is not valid: ${cfg.error}` });
  // #523 - a line the person picked that config does not name (a parent's, a run's) is one the
  // view shows now: read it only then.
  let viewLines = [];
  if (req.body && typeof req.body.line === 'string' && !mcLines.configLineById(cfg.projects, req.body.line)) {
    try { const lv = await cachedMcView(clusterReqUser(req)); viewLines = (lv && lv.linesOut) || []; } catch { /* unknown lines are refused below */ }
  }
  const parsed = mcStart.parseStart(req.body, { projects: cfg.projects, parseRef: trackerMeta.parseRef, lines: viewLines });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  // Where: this server, or a peer of its cluster config by name (never a url from the body).
  const me = getServerName();
  let peer = null;
  if (v.server !== me) {
    const publicUrl = liveConfig('publicUrl', null);
    peer = getClusterConfig().find((s) => s && s.name === v.server && s.url && (!publicUrl || s.url !== publicUrl)) || null;
    if (!peer) return res.status(400).json({ error: `no machine named ${JSON.stringify(v.server.slice(0, 60))} in this cluster` });
  }
  try {
    // The name's gloss is the tracker title: a cold read is waited on as a poll waits on one
    // (MC_META_WAIT_MS), then the session is named from whatever the cache holds.
    const refs = v.subjects.map((s) => trackerMeta.parseRef(s.key)).filter((r) => r && !r.unqualified);
    const reads = mcTrackerMeta.getMany(refs).catch((e) => console.error(`[mc] start: tracker details: ${e.message}`));
    await Promise.race([reads, new Promise((r) => { const t = setTimeout(r, MC_META_WAIT_MS); if (t.unref) t.unref(); })]);
    const titles = {};
    for (const r of refs) {
      const m = await mcTrackerMeta.peek(r);
      if (m && m.title) titles[r.key] = m.title;
    }
    const plan = mcStart.startPlan(v, { titles, command: mcStart.startCommand(liveConfig('mc', null)) });
    if (plan.error) return res.status(400).json({ error: plan.error });
    const body = { name: plan.name, cwd: v.cwd, autoCommand: plan.autoCommand, goal: plan.goal };
    let created;
    if (!peer) {
      const r = await createSessionFrom({ body, socket: null });
      if (r.status !== 200) return res.status(r.status).json({ error: `${me}: ${(r.json && r.json.error) || 'the session was not created'}` });
      created = r.json;
    } else {
      const tok = loadClusterTokens()[peer.url];
      if (!tok || !tok.token) return res.status(409).json({ error: `this server is not signed in to ${peer.name}: link it under Settings, Cluster` });
      let r;
      try {
        r = await clusterFetch(`${peer.url}/api/sessions`, {
          method: 'POST', headers: { Authorization: `Bearer ${tok.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), timeout: MC_START_PEER_TIMEOUT_MS,
        });
      } catch (e) {
        console.error(`[mc] start on ${peer.name}: ${e.message}`);
        return res.status(502).json({ error: `${peer.name} did not answer (see this server's log)` });
      }
      let j = null;
      try { j = JSON.parse(r.body); } catch { /* not JSON: said below */ }
      if (!r.ok || !j || typeof j.id !== 'string') {
        const why = (j && typeof j.error === 'string' && j.error.slice(0, 300)) || `HTTP ${r.status}`;
        // A peer's refusal of the request keeps its code (503: its restart hold); its 401 (our
        // token) must not read as the CALLER's sign-in failing, so that and the rest are a 502.
        return res.status([400, 404, 409, 503].includes(r.status) ? r.status : 502).json({ error: `${peer.name}: ${why}` });
      }
      created = j;
    }
    mcState.setBinding(created.id, { project: v.project.id, subjects: v.subjects, hunt: v.hunt, server: peer ? peer.name : me, at: Date.now(), ...(v.line ? { line: v.line } : {}) });
    // The next poll must show it: the cluster view and the MC view are both re-read.
    invalidateClusterSessionsCache();
    _mcViewCache.clear();
    console.log(`[mc] started ${created.id} on ${peer ? peer.name : me} for ${v.project.id}${v.hunt ? ' (hunt)' : ''} ${v.subjects.map((s) => s.key).join(' ')}`);
    res.json({
      server: peer ? peer.name : me, serverUrl: peer ? peer.url : null, sessionId: created.id,
      name: created.name || plan.name, agent: created.agent ?? null, agentReady: created.agentReady ?? true,
      project: v.project.id, subjects: v.subjects.map((s) => s.key), hunt: v.hunt, line: v.line, generatedAt: Date.now(),
    });
  } catch (e) {
    console.error(`[mc] start: ${e.message}`);
    res.status(500).json({ error: 'could not start the session' });
  }
});

// --- API: #510 Mission Control: questions with context on demand (lib/mc-questions.js) ---
// GET  /api/mc/questions/:cardId/context?level=ask|context|everything
//   -> {level, text, sections: [{title, body}], sources, ask, cardId, generatedAt}   (no model run)
// POST /api/mc/questions/:cardId/followup {option: index|null, question}  -> the ask's shape + option
// POST /api/mc/questions/:cardId/suggest  -> {options: [{label, consequence}], sources, canSend, model, generatedAt}
// cardId = an Answer-now card's id (#506); 404 once that card no longer waits. Built on demand:
// nothing here runs on a poll, and NOTHING here types into the waiting session - the follow-ups
// and suggestions are the Analyst's tools-off runs (mcAnalystService, #511); only the person's
// final pick reaches the session, through the companion's existing answer path.

/** The card and what it is read from: `{card, row, ask, meta}`, or `{status, json}` to answer. */
async function mcQuestionCard(req) {
  const refused = mcRefusal(supervisorAuthority());
  if (refused) return { status: refused.status, json: refused.json };
  const cardId = mcQuestions.cardIdOf(req.params.cardId);
  if (!cardId) return { status: 400, json: { error: 'cardId must be the id of an Answer-now card' } };
  const v = await cachedMcView(clusterReqUser(req));
  if (v.error) return { status: 500, json: { error: v.error } };
  const card = mcNeeds.pendingCards({ nodes: v.nodes, view: v, now: Date.now() }).find((c) => c.id === cardId);
  if (!card) return { status: 404, json: { error: 'that card no longer waits on you' } };
  const { sessions } = await cachedClusterSessions(clusterReqUser(req));
  const row = (Array.isArray(sessions) ? sessions : []).find((s) => s && s.id === card.sessionId && (s.server || '') === (card.server || '')) || null;
  // A question on screen: its options are the live AskUserQuestion's (the route the session
  // screen's overlay reads). Unreadable -> the ask is the card's words.
  let pending = null;
  if (card.kind === 'question' && row) {
    const q = await mcSessionRead(row, sessionPendingQuestion, 'pending-question');
    pending = q && q.pending && q.question ? q.question : null;
  }
  // The tracker CACHE only (#504's peek: never a tracker read).
  let meta = null;
  const ref = card.subjectKey ? trackerMeta.parseRef(card.subjectKey) : null;
  if (ref && !ref.unqualified) meta = await mcTrackerMeta.peek(ref);
  return { card, row, ask: mcQuestions.askOf(card, pending), meta };
}

app.get('/api/mc/questions/:cardId/context', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const level = mcQuestions.levelOf(req.query.level);
  if (!level) return res.status(400).json({ error: `level must be one of ${mcQuestions.LEVELS.join(', ')}` });
  try {
    const q = await mcQuestionCard(req);
    if (q.status) return res.status(q.status).json(q.json);
    let digest = null;
    let recap = null;
    if (level !== 'ask' && q.row) {
      // A digest only as cached: peek never starts a model run.
      const d = await mcSessionRead(q.row, (id) => sessionDigest(id, { peek: true }), 'digest?peek=1');
      digest = d && d.status === 'ready' ? d : null;
    }
    let turns = null;
    if (level === 'everything' && q.row) [recap, turns] = await Promise.all([mcAskRecap(q.row), mcLastTurns(q.row)]);
    const now = Date.now();
    const out = mcQuestions.buildContext({ card: q.card, level, ask: q.ask, row: q.row, meta: q.meta, digest, recap, turns, now });
    res.json({ ...out, cardId: q.card.id, generatedAt: now });
  } catch (e) {
    console.error(`[mc] question context: ${e.message}`);
    res.status(500).json({ error: 'the question context could not be read' });
  }
});

/** The waiting session's newest turns, newest LAST (#531): this server's in-process
 *  (`readTranscriptPage`), a peer's over its own /transcript route. Null when they cannot be
 *  read. The recap is a one-glance card (its reply is cut at 280 characters); what explains a
 *  question's terms is the agent's words before it asked, so the Analyst and the Everything level
 *  read the turns themselves (lib/mc-questions.js lastTurns caps them). */
const MC_TURNS_READ = 60;
async function mcLastTurns(row) {
  const r = await mcSessionRead(row, async (id) => {
    const page = await readTranscriptPage(id, null, MC_TURNS_READ);
    return page ? { status: 200, body: { messages: page.turns } } : { status: 404, body: { error: 'no transcript for session' } };
  }, `transcript?limit=${MC_TURNS_READ}`);
  return r && Array.isArray(r.messages) ? r.messages : null;
}

/** The Analyst's bundle for card [q]: the asking session's (its recap included), its last turns,
 *  then the card. */
async function mcQuestionBundle(q, now) {
  const rows = q.row ? [q.row] : [];
  const recaps = new Map();
  let turns = null;
  if (q.row) {
    const [recap, last] = await Promise.all([mcAskRecap(q.row), mcLastTurns(q.row)]);
    recaps.set(q.row.id, recap);
    turns = last;
  }
  const metas = new Map();
  await Promise.all(mcAnalyst.itemKeys(rows).map(async (key) => {
    const ref = trackerMeta.parseRef(key);
    if (ref && !ref.unqualified) metas.set(key, await mcTrackerMeta.peek(ref));
  }));
  const bundle = mcAnalyst.buildBundle({ rows, metaOf: (key) => metas.get(key) || null, recaps, now });
  return mcQuestions.withAskBlock(bundle, { card: q.card, ask: q.ask, now, turns });
}

app.post('/api/mc/questions/:cardId/followup', express.json({ limit: '16kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const q = await mcQuestionCard(req);
    if (q.status) return res.status(q.status).json(q.json);
    const input = mcQuestions.followupInput(req.body, q.ask);
    if (!input.ok) return res.status(400).json({ error: input.error });
    const now = Date.now();
    const bundle = await mcQuestionBundle(q, now);
    const scope = { kind: 'session', id: q.card.sessionId };
    const prompt = mcQuestions.followupPrompt({ bundle, input, scope, now });
    const out = await mcAnalystService.ask({
      kind: 'followup', question: `${input.option}|${input.question}`, scope, bundle, prompt,
      shape: (parsed, s) => ({ answer: parsed.answer, sources: s.sources, dataAge: bundle.dataAge, cut: bundle.cut, scope,
        option: input.option, model: s.model, generatedAt: s.generatedAt }),
    });
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error(`[mc] question followup: ${e.message}`);
    res.status(500).json({ error: 'the question could not be answered' });
  }
});

app.post('/api/mc/questions/:cardId/suggest', express.json({ limit: '1kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const q = await mcQuestionCard(req);
    if (q.status) return res.status(q.status).json(q.json);
    const now = Date.now();
    const bundle = await mcQuestionBundle(q, now);
    const scope = { kind: 'session', id: q.card.sessionId };
    const prompt = mcQuestions.suggestPrompt({ bundle, scope, now });
    const existing = q.ask.options.map((o) => o.label);
    const out = await mcAnalystService.ask({
      kind: 'suggest', question: '', scope, bundle, prompt,
      parse: (stdout, offered) => mcQuestions.parseSuggestions(stdout, offered, existing),
      shape: (parsed, s) => ({ options: parsed.options, sources: s.sources, canSend: q.ask.canSuggest, model: s.model, generatedAt: s.generatedAt }),
    });
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error(`[mc] question suggest: ${e.message}`);
    res.status(500).json({ error: 'no options could be suggested' });
  }
});

// --- API: #413 the work-item event log ---
// Every session that touched an item, on THIS machine: when, and how its work on it ended.
// `/events` is the raw list; the bare route adds the newest snapshot and the hand-off
// brief, and with ?cluster=1 merges every peer's answer (peers are asked without it).
app.get('/api/work-items/:ref/events', (req, res) => {
  const key = workItemKeyOr400(req, res);
  if (!key) return;
  try {
    const v = localWorkItemView(key);
    res.json({ key, machine: v.machine, events: v.events });
  } catch (e) {
    console.error(`[work-items] events ${key}: ${e.message}`);
    res.status(500).json({ error: 'could not read the work-item log' });
  }
});
app.get('/api/work-items/:ref', async (req, res) => {
  const key = workItemKeyOr400(req, res);
  if (!key) return;
  try {
    res.json(req.query.cluster === '1' ? await clusterWorkItemView(key) : localWorkItemView(key));
  } catch (e) {
    console.error(`[work-items] view ${key}: ${e.message}`);
    res.status(500).json({ error: 'could not read the work-item log' });
  }
});

// --- API: upload image, return path for bracketed-paste insert ---
// Claude Code's paste handler detects absolute image paths in pasted text and
// reads the file directly via readFileBytesSync, so we don't touch the Windows
// clipboard at all — that path was unreliable and only worked locally. The
// path-paste flow works for remote cluster sessions too: the request hits the
// remote server, the file is saved on the remote disk, and the remote Claude
// Code reads its own local file.
app.post('/api/clipboard-image', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  try {
    const ct = req.headers['content-type'] || 'image/png';
    const ext = ct.includes('jpeg') || ct.includes('jpg') ? '.jpg' : '.png';
    const filename = `clip-${Date.now()}${ext}`;
    const filepath = path.join(CLIPBOARD_DIR, filename);
    fs.writeFileSync(filepath, req.body);
    res.json({ ok: true, path: filepath });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// #90 — a file DROPPED onto the compose bar is uploaded here and then delivered
// to the agent as a path, exactly like a pasted image above.
//
// Why the bytes must travel at all: the agent runs on THIS machine, so the path
// the dropping device sees is meaningless for a remote cluster session — it would
// name a file the agent cannot open, and would silently name the WRONG file if a
// same-named one happened to exist here. Uploading makes a drop behave identically
// whether the session is local or on a peer.
app.post('/api/upload-file', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty body' });
    try { if (!fs.existsSync(DROPPED_DIR)) fs.mkdirSync(DROPPED_DIR); } catch (e) {}
    const filepath = freeDropPath(safeDropName(req.headers['x-filename']));
    fs.writeFileSync(filepath, req.body);
    res.json({ ok: true, path: filepath });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: list sessions ---
/** The rows GET /api/sessions serves: shaped, with their #313 reasons. The ONE list builder
 *  for this server's sessions - the route sends it, and the supervisor (#467) reads its own
 *  server through it, so a local row is exactly the row a peer serves (a reason included). */
async function sessionsListRows() {
  // Phase-timed - see _logSlowSessions. `runningWork` is the one that can
  // spawn a PowerShell (processTree.snapshot), so it is the phase most worth
  // telling apart from the rest when this route goes slow.
  const _t0 = performance.now();
  settlePendingQuestions(); // #441 - before the statuses are read, so they agree
  const { sessions: list } = await workerClient.rpc('listSessions');
  reconcileBriefs(list.map((s) => s.id)); // #298 - sessions that ended while we were down
  const _tRpc = performance.now();
  const listMetrics = await Promise.all(list.map((s) => sessionMetrics(s).catch(() => null)));
  const _tMetrics = performance.now();
  const listConvIds = await Promise.all(list.map((s) => sessionConversationId(s).catch(() => null)));
  const _tConv = performance.now();
  const listBgTasks = await Promise.all(list.map((s) => sessionRunningWork(s).catch(() => [])));
  const _tWork = performance.now();
  _logSlowSessions({
    rpc: _tRpc - _t0,
    metrics: _tMetrics - _tRpc,
    convIds: _tConv - _tMetrics,
    runningWork: _tWork - _tConv,
  }, _tWork - _t0);
  const shaped = list.map((s, i) => ({
    id: s.id, name: s.name, cwd: s.cwd,
    clients: s.clients || 0, pid: s.pid, status: s.status,
    lastActivity: s.lastActivity, autoCommand: s.autoCommand || '',
    // Which AI agent this session runs (null = plain shell). Drives the sidebar
    // tint and the chat lens; see GET /api/agents for the catalogue.
    agent: s.agent ?? null,
    claudeSessionId: s.claudeSessionId,
    // Agent-neutral conversation identity. Equals claudeSessionId for Claude; for an
    // agent whose transcript is discovered (Codex) it is the rollout UUID. A client
    // drops its cached transcript when this changes — see sessionConversationId.
    // Deliberately NOT folded into claudeSessionId: app.html shows the Fork button on
    // that field and forks with `claude --resume <id>`, so a Codex id there would offer
    // a fork that cannot work.
    agentSessionId: listConvIds[i],
    notifyLevel: getNotifyLevel(s.id),
    // #60 — favorite (pin) + its rank. Server-side so every device sees one
    // truth; a peer's favorites ride to the cluster list on THIS array.
    ...favoriteFields(s.id),
    // #137 — is this session sitting out its 5h window, when does it come back,
    // and is a resume actually armed for it. One server-side derivation
    // (lib/usage-limit.js), shared with the worker's arming gate.
    //
    // #227 — this used to end "so the badge can never claim something the timer
    // disagrees with". IT COULD, AND IT DID, all night: sharing a MODULE is not
    // sharing an ANSWER, and the derivation here saw only a subset of the worker's
    // gates. `armed` now carries the worker's own autoResumeArmed instead.
    usageLimit: usageLimitFields(s.id, listMetrics[i], s),
    // #65 — compaction in progress. Unlike apiError, this rides the poll (and
    // the cluster merge) so a client opening/reconnecting mid-compaction still
    // sees the indicator, and the poll-seed agrees with the live 'compacting'
    // push instead of clearing it. Worker-owned (sessionSummary), live-pushed too.
    compacting: s.compacting || false,
    compactingSince: s.compactingSince ?? null,
    // #147 — is the agent's composer up? Rides the poll AND the cluster merge, not
    // just the live push, so a client that opens a session mid-boot (or reconnects,
    // or is looking at a peer's session) starts from the truth instead of assuming.
    // `?? true` is the deliberate failure mode: an older worker sends no such field,
    // and reading that as "starting" would refuse submit on every session it owns.
    agentReady: s.agentReady ?? true,
    // #190 — WHY it is not ready, when the worker recognised the screen. Rides the
    // poll and the cluster merge for the same reason `agentReady` does: a client
    // that opens a session mid-block must start from the truth, and null (an older
    // worker, or nothing recognised) reads as an ordinary boot.
    blockedPrompt: s.blockedPrompt ?? null,
    // #316 — a panel or menu over the composer (worker-derived), for sessionReason.
    inMenu: s.inMenu === true,
    inMenuSince: s.inMenuSince ?? null,
    metrics: listMetrics[i],
    // Background commands still running (`run_in_background`). Rides the poll and
    // the cluster merge like `compacting`, so a peer's builds are visible too. The
    // STATUS is untouched — a session can be idle and still be building.
    backgroundTasks: listBgTasks[i],
    // #79 — WHAT this session is blocked on ('question' | 'permission' | null), so
    // the chat lens can say so instead of looking identical to an idle session.
    // Derived server-side (lib/waiting-for.js) precisely so both clients and the
    // cluster merge agree with the status dot rather than each re-deriving it.
    waitingFor: sessionWaitingFor(s),
    // #298 — what this session is working on, for the sessions dashboard: work items
    // and their states, what it is doing now, what it just did. One helper for both
    // shapers (sessionBriefField); null for a session no hook has spoken for.
    brief: sessionBriefField(s),
    // #351 - who started it, for a session POSTed here (null = no verdict, never auto-closed).
    // One helper for both shapers, like `brief` above.
    spawn: spawnStore.field(s.id),
    // #468 - R9's evidence and the dispatcher's role. One helper for both shapers.
    ...supervisorRowFields(s),
  }));
  // #313 - WHY a non-working session is not working (lib/session-reason.js).
  addSessionReasons(shaped);
  return shaped;
}

app.get('/api/sessions', async (req, res) => {
  try {
    const shaped = await sessionsListRows();
    // Log when a remote server fetches our sessions (Bearer = cluster call).
    // Throttled to avoid hammering the disk: only logs on change or after
    // CLUSTER_LOG_MIN_GAP_MS. Without this, peer polling produces multiple
    // log lines per second and stalls the event loop on synchronous fs writes.
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      const summary = shaped.map(s => {
        const ageMins = s.lastActivity ? Math.round((Date.now() - s.lastActivity) / 60000) : '?';
        return `"${s.name}"(${s.status}, ${ageMins}m ago, ${s.clients} clients)`;
      }).join(', ');
      _throttledClusterLog('served', `${shaped.length}|${summary}`,
        (ts) => `[${ts}] Sessions served to cluster caller: ${shaped.length} sessions: ${summary}`);
    }
    res.json(shaped);
  } catch (e) {
    console.error('listSessions failed:', e.message);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// --- Test helper: artificially age a session's lastActivity (test mode only) ---
if (process.env.WT_TEST) {
  app.post('/api/test/age-session/:id', express.json(), async (req, res) => {
    const ageMinutes = req.body?.ageMinutes || 10;
    const aged = Date.now() - (ageMinutes * 60 * 1000);
    // #37: allow aging each clock independently so a test can leave one fresh —
    // e.g. hookOnly ages lastHookActivity (stale hook) while lastActivity (PTY
    // output) stays recent, the exact "busy build/subagent" case.
    const rpcArgs = { id: req.params.id };
    if (req.body?.hookOnly) {
      rpcArgs.lastHookActivity = aged;
    } else if (req.body?.activityOnly) {
      rpcArgs.lastActivity = aged;
    } else {
      rpcArgs.lastActivity = aged;
      rpcArgs.lastHookActivity = aged;
    }
    try {
      const result = await workerClient.rpc('ageSession', rpcArgs);
      res.json({ ok: true, aged, ...rpcArgs, ...result });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'session not found' });
      res.status(500).json({ error: e.message });
    }
  });
  // #351 - run the spawn reaper's sweep NOW, with an idle threshold of the caller's choosing
  // (milliseconds). The suite server's own 5-minute sweep keeps the real threshold, so a short
  // one never reaches another spec's sessions.
  app.post('/api/test/spawn-reaper-sweep', express.json(), async (req, res) => {
    const idleMs = Number(req.body?.idleMs);
    try { res.json(await spawnReaperSweep({ idleMs: idleMs > 0 ? idleMs : undefined, fail: req.body?.fail })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  // #351 - the time lever for the spawn verdict, the way age-session is for lastActivity: move a
  // session's classify window / viewed clock back by `ms`. A spec says "this was created 7 hours
  // ago" instead of sleeping for the classify window, which a host that stalls its processes for
  // seconds (measured on Home) turns into a coin flip.
  // #359 - set the restart hold's state outright, so a spec can drive what only a real
  // restart produces (tracked sessions whose processes changed) through the real tick.
  app.post('/api/test/maintenance-state', express.json({ limit: '64kb' }), async (req, res) => {
    _maint = { hold: req.body?.hold || null, back: req.body?.back || null, off: req.body?.off || null };
    saveMaint();
    await maintTick();
    res.json({ ok: true });
  });
  app.post('/api/test/spawn-age/:id', express.json(), (req, res) => {
    const ok = spawnStore.shift(req.params.id, Number(req.body?.ms));
    res.status(ok ? 200 : 404).json({ ok });
  });
}

// --- API: execute command and return output ---
// M3: opt-in (enableRemoteExec config key, default false), per-token sliding-window
// rate limit (30/min), audit logged to logs/exec-audit.log. The route is only
// registered when the feature is enabled, so it returns 404 when disabled.
const EXEC_RATE_MAX = 30;               // 30 calls/min/token
const EXEC_RATE_WINDOW_MS = 60 * 1000;  // 1 minute
const _execRateBuckets = new Map();     // identity -> [timestamps...]

function _execRateCheck(identity) {
  const now = Date.now();
  let arr = _execRateBuckets.get(identity);
  if (!arr) { arr = []; _execRateBuckets.set(identity, arr); }
  // Drop timestamps outside the sliding window.
  while (arr.length && arr[0] <= now - EXEC_RATE_WINDOW_MS) arr.shift();
  if (arr.length >= EXEC_RATE_MAX) {
    const retryMs = EXEC_RATE_WINDOW_MS - (now - arr[0]);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  arr.push(now);
  return { allowed: true };
}

// #311 - which device sent each prompt (lib/device-ops.js). Overridable so the suite
// never writes into the production log.
const DEVICE_OPS_FILE = process.env.WT_DEVICE_OPS_FILE || path.join(__dirname, 'logs', 'device-ops.jsonl');
// #425 - attach / mode switch / detach per client, so time on the phone vs a desktop is known.
const DEVICE_VIEWS_FILE = process.env.WT_DEVICE_VIEWS_FILE || path.join(__dirname, 'logs', 'device-views.jsonl');
function logView(event, ws, id, extra) {
  usageLog.appendRecord(DEVICE_VIEWS_FILE, usageLog.viewRecord(event,
    { id, mode: ws._wtBackground ? 'background' : 'active', src: ws._wtSrc, server: getServerName(), ...(extra || {}) }, Date.now()));
}
const EXEC_AUDIT_FILE = process.env.WT_EXEC_AUDIT_FILE || path.join(__dirname, 'logs', 'exec-audit.log');
const EXEC_AUDIT_DIR = path.dirname(EXEC_AUDIT_FILE);
function _execAudit(entry) {
  // Tolerate log-write errors — never fail the request because of logging.
  try {
    try { fs.mkdirSync(EXEC_AUDIT_DIR, { recursive: true }); } catch {}
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(EXEC_AUDIT_FILE, line, 'utf8');
  } catch (e) {
    try { console.warn('[exec-audit] write failed:', e.message); } catch {}
  }
}

function _registerExecRoute() {
  app.post('/api/exec', express.json({ limit: '64kb' }), (req, res) => {
    const auth = req._wtAuth || { identity: 'unknown', label: 'unknown' };
    const rl = _execRateCheck(auth.identity);
    if (!rl.allowed) {
      res.set('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ error: 'rate limit exceeded (30 calls/min/token)' });
    }
    const command = req.body?.command;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'command is required' });
    }
    if (command.length > 4096) {
      return res.status(400).json({ error: 'command too long (max 4096 chars)' });
    }
    const cwd = req.body?.cwd ? String(req.body.cwd).substring(0, 260) : undefined;
    const timeout = Math.min(Math.max(parseInt(req.body?.timeout) || 30000, 1000), 120000);

    const cmdSha256 = crypto.createHash('sha256').update(command).digest('hex');
    const clientIp = (req.ip || req.connection?.remoteAddress || '').toString();
    const startedAt = Date.now();

    const child = execFile(SHELL, ['-c', command], {
      cwd: cwd || DEFAULT_CWD,
      timeout,
      maxBuffer: 1024 * 1024,
      env: buildSafeEnv(),
      windowsHide: true
    }, (err, stdout, stderr) => {
      const exitCode = err ? (err.code === 'ETIMEDOUT' ? -1 : (err.code || 1)) : 0;
      _execAudit({
        ts: new Date(startedAt).toISOString(),
        label: auth.label,
        cmdSha256,
        clientIp,
        exitCode,
        durationMs: Date.now() - startedAt,
      });
      res.json({ stdout, stderr, exitCode });
    });
  });
}

const _execEnabled = (liveConfig('enableRemoteExec', false) === true) || process.env.WT_ENABLE_REMOTE_EXEC === '1';
if (_execEnabled) {
  _registerExecRoute();
  console.log(`[${new Date().toISOString()}] /api/exec is ENABLED (enableRemoteExec=true) — rate-limited 30/min/token, audited to logs/exec-audit.log`);
}

// --- API: prepare this machine for a restart (#359) ---
// Behind the auth middleware like every /api route. `prepare` starts the hold and tells
// every agent session; `status` is the honest answer to "can I restart now?".
app.post('/api/maintenance/prepare', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    if (_maint.hold) return res.status(409).json({ error: 'a restart hold is already on', ...(await maintStatus()) });
    const { sessions } = await workerClient.rpc('listSessions');
    // Checked again: another prepare may have landed while the list was read.
    if (_maint.hold) return res.status(409).json({ error: 'a restart hold is already on', ...(await maintStatus()) });
    // A "back" notice still on its way is kept: a prepare straight after a restart must
    // not swallow the notice for the restart that just happened.
    _maint = { off: null, hold: maintLib.startHold({ reason: req.body?.reason, now: Date.now(), bootAt: machineBootAt(), worker: workerClient.workerIdentity(), sessions }), back: _maint.back };
    saveMaint();
    console.log(`[maintenance] restart hold started (${_maint.hold.reason}) over ${sessions.length} session(s)`);
    await maintTick();
    res.json(await maintStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/maintenance/status', async (req, res) => {
  try { res.json(await maintStatus()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// The answer to the restart question (#407), reported as STATE by the session itself
// (wt-maintenance.js answer) - never read from what it wrote. Behind the auth middleware
// like its siblings; lib/maintenance.js validates the body and decides the status code.
app.post('/api/maintenance/answer', express.json({ limit: '4kb' }), (req, res) => {
  const r = maintLib.noteAnswer(_maint.hold, req.body, Date.now());
  if (r.status !== 200) return res.status(r.status).json({ error: r.error });
  _maint.hold = r.hold;
  saveMaint();
  console.log(`[maintenance] ${req.body.sessionId}: answered ${r.answer}`);
  res.json({ ok: true, answer: r.answer, ...(r.answer === 'later' ? { minutes: r.minutes } : {}) });
});
// Cancelling tells the sessions the hold had asked that the restart is off (typed once each
// is idle at its composer; the tick carries on with any that are not yet).
app.delete('/api/maintenance', (req, res) => {
  const had = !!_maint.hold;
  if (had) console.log(`[maintenance] restart hold cancelled (${_maint.hold.reason})`);
  // No hold: nothing to cancel, and the notices still owed (called off, back) are kept.
  if (had) {
    _maint = { hold: null, back: null, off: maintLib.backList(_maint.hold, Date.now()) };
    saveMaint();
  }
  maintTick();
  res.json({ ok: true, cancelled: had });
});

// --- API: cluster resource leases (#412) ---
// lib/leases.js owns the rules, lib/lease-broker.js the file, the forward to the authority
// and the sweeps, lib/lease-cleanup.js what a release kills and removes. Every route is
// below the auth middleware; ids and bodies are validated in those modules. `leases` in
// config.json is NOT in ALLOWED_CONFIG_KEYS: its cleanup roots say what this server may
// delete, so it is set by editing the file, never over HTTP.
const LEASES_FILE = process.env.WT_LEASES_FILE || path.join(__dirname, 'leases.json');
const LEASE_RECORDS_FILE = process.env.WT_LEASE_RECORDS_FILE || path.join(__dirname, 'lease-records.json');
const leaseBroker = createLeaseBroker({
  stateFile: LEASES_FILE,
  recordsFile: LEASE_RECORDS_FILE,
  checkoutDir: __dirname,
  protectPaths: () => [process.env.WT_WORKER_DATA_DIR].filter(Boolean),
  leasesConfig: () => liveConfig('leases', undefined),
  cluster: () => getClusterConfig(),
  publicUrl: () => liveConfig('publicUrl', null),
  serverName: () => getServerName(),
  clusterToken: (url) => {
    const want = String(url || '').replace(/\/+$/, '').toLowerCase();
    const hit = Object.entries(loadClusterTokens()).find(([u]) => u.replace(/\/+$/, '').toLowerCase() === want);
    if (!hit) return null;
    return typeof hit[1] === 'string' ? hit[1] : (hit[1] && hit[1].token) || null;
  },
  fetch: clusterFetch,
  listLocalSessionIds: async () => (await workerClient.rpc('listSessions', {}, MACHINE_QUERY_WAIT_MS)).sessions.map((s) => s.id),
  readMachine: readMachineProfile,
  // Null until the worker has told us its pid: a pid record is then refused, never accepted
  // with the one pid whose kill would end every PTY on the machine left off the list.
  protectedPids: () => {
    const w = workerClient.workerIdentity();
    return w && Number.isInteger(w.pid) ? [process.pid, process.ppid, w.pid].filter(Number.isInteger) : null;
  },
});
const leaseJson = express.json({ limit: '8kb' });
app.get('/api/leases', leaseBroker.routes.list);
app.post('/api/leases', leaseJson, leaseBroker.routes.create);
app.post('/api/leases/holder-ended', leaseJson, leaseBroker.routes.holderEnded);
app.get('/api/leases/local-sessions', leaseBroker.routes.localSessions);
app.get('/api/leases/records', leaseBroker.routes.records);
app.post('/api/leases/released-notice', leaseJson, leaseBroker.routes.releasedNotice);
app.get('/api/leases/:id', leaseBroker.routes.get);
app.post('/api/leases/:id/heartbeat', leaseJson, leaseBroker.routes.heartbeat);
app.post('/api/leases/:id/record', leaseJson, leaseBroker.routes.record);

// --- #466 Supervisor phase 1 (docs/SUPERVISOR-DESIGN.md) ------------------------------------
// Every server: its own journal (GET /api/journal) and the gated prompt route. The lease
// authority only: the cluster work graph, polled each minute, and GET /api/supervisor/state.
// READ-ONLY: nothing here acts on a session. The rules are lib/supervisor.js,
// lib/session-journal.js and lib/safe-prompt.js; this is the I/O.
const SUPERVISOR_LOG_FILE = process.env.WT_SUPERVISOR_LOG_FILE || path.join(HANDOFF_DIR, 'supervisor-log.jsonl');
function supervisorLog(line) {
  try { workItemLog.appendLines(SUPERVISOR_LOG_FILE, [{ at: Date.now(), ...line }], { maxBytes: journalLib.MAX_BYTES }); } catch (err) {
    console.error(`[supervisor] log write failed: ${err.message}`);
  }
}

// This server's own journal, after [since] (epoch ms, exclusive). The supervisor pages it.
app.get('/api/journal', (req, res) => {
  const since = Number(req.query.since);
  const limit = Number(req.query.limit);
  const page = journalLib.pageAfter(workItemLog.readLines(SESSIONS_JOURNAL_FILE), Number.isFinite(since) ? since : -Infinity,
    Number.isFinite(limit) ? limit : journalLib.PAGE_MAX);
  res.json({ machine: getServerName(), ...page });
});

// The gated prompt (lib/safe-prompt.js): typed only when every gate the check-in and the
// restart hold apply says it is safe; answers delivered, or refused with why. One at a time
// per session, and the row is read TWICE - once for the rule, once right before typing - so
// a turn, a question or a menu that came up during the awaits is never typed into.
const _gatedPromptBusy = new Set();
// The last refusal logged per session: a caller that retries every scan (the supervisor) would
// otherwise write one line a minute while a session stays busy, and the capped log would trim
// away the `wake` lines supervisorSeed reads to never wake twice.
const _gatedPromptRefused = new Map();
/// Type one gated prompt into local session [id] (lib/safe-prompt.js). [body] is the route's
/// `{text, tag?, expectWaitAt?}`; [by] names the caller for the log. Returns `{status, json}`:
/// the route sends it as is, and the supervisor (#467) calls it directly for its own server's
/// sessions, so a local wake passes exactly the gates a peer's does.
async function gatedPrompt(id, body, by) {
  // #469 - a text this server builds for itself: the close-out names its own wt-closeout.js.
  const p = safePrompt.promptOf(body, { closeout: closeoutLib.closeoutText(CLOSEOUT_CLI) });
  if (p.error) return { status: 400, json: { error: p.error } };
  const refuse = (why, status = 409) => {
    if (_gatedPromptRefused.get(`${id}|${by}`) !== why) supervisorLog({ event: 'prompt-refused', id, why, by });
    _gatedPromptRefused.set(`${id}|${by}`, why);
    return { status, json: { delivered: false, refused: why } };
  };
  if (_gatedPromptBusy.has(id)) return refuse('busy');
  _gatedPromptBusy.add(id);
  try {
    const { sessions } = await workerClient.rpc('listSessions');
    if (!sessions.some((s) => s.id === id)) return { status: 404, json: { error: 'session not found' } };
    const ctx = () => ({ brief: getBriefEntry(id) || {}, hold: Boolean(_maint.hold), busy: _checkInBusy || _autoScanBusy,
      inputAt: _lastInputAt.get(id), startedAt: CHECKIN_STARTED_AT, now: Date.now(), cfg: checkInCfg(),
      expectWaitAt: p.expectWaitAt === undefined ? null : p.expectWaitAt, draft: composerHasDraft(id) });
    const row = await handoffRowFor(id, sessions);
    // #469 - the close-out is asked once per done, and only of a session still done.
    const own = () => (p.template === 'closeout' ? closeoutLib.askRefusal(getBriefEntry(id)) : null);
    const why = safePrompt.promptRefusal(row, ctx()) || own();
    if (why) return refuse(why);
    const cur = await workerClient.rpc('getSession', { id });
    const fresh = { ...row, ...cur, waitingFor: sessionWaitingFor(cur), brief: sessionBriefField(cur) || row.brief };
    const whyNow = safePrompt.promptRefusal(fresh, ctx()) || own();
    if (whyNow) return refuse(whyNow);
    if (((getBriefEntry(id) || {}).turnAt || null) !== ((row.brief && row.brief.turnAt) || null)) return refuse('not-idle');
    // typePrompt refuses a draft too (#479, its backstop): name it, never as an outage.
    if (!typePrompt(id, p.prompt)) return composerHasDraft(id) ? refuse('draft') : refuse('worker-unavailable', 503);
    // #469 - the ask is state on this server's brief: the row carries it to the authority, and
    // the answer route (wt-closeout.js) fills it in.
    if (p.template === 'closeout') setBriefEntry(id, { ...(getBriefEntry(id) || briefLib.emptyEntry()), closeout: closeoutLib.askedRecord(Date.now()) });
    // #522 - a prompt that ENDS the wait it answers (Mission Control's Done): a tagged prompt is
    // a system turn, so nothing else clears it, and the owner-wait push, the inbox and the
    // subject's counts would keep it. Only that wait (its `at`), never one reported since.
    if (p.clearWait) {
      const cleared = briefLib.clearWait(getBriefEntry(id), p.expectWaitAt);
      if (cleared) setBriefEntry(id, cleared);
    }
    // Typed text is input: the check-in and the hand-off scan leave the session alone for their
    // quiet period, so neither types its own prompt behind this one.
    _lastInputAt.set(id, Date.now());
    _gatedPromptRefused.delete(`${id}|${by}`);
    supervisorLog({ event: 'prompt-delivered', id, by, bytes: Buffer.byteLength(p.prompt, 'utf8') });
    return { status: 200, json: { delivered: true } };
  } catch (e) {
    if (/not found/i.test(e.message)) return { status: 404, json: { error: 'session not found' } };
    console.error(`gated prompt failed: ${e.message}`);
    return { status: 500, json: { error: 'Failed to prompt session' } };
  } finally { _gatedPromptBusy.delete(id); }
}
app.post('/api/sessions/:id/prompt', express.json({ limit: '8kb' }), async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  const out = await gatedPrompt(id, req.body, (req._wtAuth && req._wtAuth.label) || null);
  res.status(out.status).json(out.json);
});

// #469 - the supervisor's close (lib/closeout.js closeRefusal), re-checked HERE, on the
// session's own server, right before the kill: the authority's scan is up to a minute old, and
// a person may have opened the session since. Never the owner's session; only after the clean
// close-out it names. The slow reads come first and the last look last, with nothing awaited
// between the look and the kill (the #351 reaper's order).
async function gatedClose(id, closeoutAt, by) {
  const refuse = (why) => {
    if (_gatedPromptRefused.get(`${id}|close|${by}`) !== why) supervisorLog({ event: 'close-refused', id, why, by });
    _gatedPromptRefused.set(`${id}|close|${by}`, why);
    return { status: 409, json: { closed: false, refused: why } };
  };
  if (_gatedPromptBusy.has(id)) return refuse('busy');
  _gatedPromptBusy.add(id);
  try {
    let cur = await workerClient.rpc('getSession', { id });
    const work = await reaperRunningWork(cur);
    const { sessions } = await workerClient.rpc('listSessions');
    cur = await workerClient.rpc('getSession', { id });
    const brief = getBriefEntry(id) || {};
    const why = closeoutLib.closeRefusal({
      row: cur, brief, by: (spawnStore.metaOf(id) || {}).by || null, viewers: activeViewerCount(id), favorite: favoriteFields(id).favorite,
      work, hold: Boolean(_maint.hold), handoff: checkInLib.handoffBlock(brief), closeoutAt,
      typing: checkInLib.typedRecently(_lastInputAt.get(id), CHECKIN_STARTED_AT, Date.now(), checkInCfg().typingQuietMin),
      draft: composerHasDraft(id),
      children: sessions.filter((s) => s.id !== id && (spawnStore.field(s.id) || {}).parentId === id).length,
    });
    if (why) return refuse(why);
    await killLocalSession(id, 'closed-out');
    _gatedPromptRefused.delete(`${id}|close|${by}`);
    supervisorLog({ event: 'closed-out', id, by });
    return { status: 200, json: { closed: true } };
  } catch (e) {
    if (/not found/i.test(e.message)) return { status: 404, json: { error: 'session not found' } };
    console.error(`gated close failed: ${e.message}`);
    return { status: 500, json: { error: 'Failed to close session' } };
  } finally { _gatedPromptBusy.delete(id); }
}
app.post('/api/sessions/:id/close', express.json({ limit: '1kb' }), async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  const at = req.body && req.body.closeoutAt;
  if (!Number.isInteger(at) || at <= 0) return res.status(400).json({ error: 'closeoutAt must be the "at" of the clean close-out it acts on (epoch ms)' });
  const out = await gatedClose(id, at, (req._wtAuth && req._wtAuth.label) || null);
  res.status(out.status).json(out.json);
});

/** Is this server the lease authority (lib/leases.js)? The supervisor runs only there. */
function supervisorAuthority() {
  return leasesLib.resolveAuthority(liveConfig('leases', undefined), getClusterConfig(), liveConfig('publicUrl', null), getServerName());
}
const _sup = { graph: null, sightings: {}, verdicts: {}, journal: {}, cursors: {}, known: new Set(), localJournal: null, at: 0, busy: false,
  // #467: absence sightings of wait targets, target answers, outside lookups and baselines,
  // the action keys delivered, per-session action times, the owner ladder, recent actions.
  absent: {}, resolutions: {}, lookups: {}, baselines: {}, done: new Set(), acts: {}, ladder: {}, actions: [], refused: {}, seeded: false };
/** config.json `supervisor`. Under WT_TEST only, two env seams shorten the clock, so a spec
 *  proves the two-scan orphan rule in seconds instead of sleeping five minutes. */
function supervisorCfg() {
  const c = supervisorLib.supervisorConfig(liveConfig('supervisor', null));
  if (process.env.WT_TEST === '1') {
    const every = Number(process.env.WT_SUPERVISOR_EVERY_MS), confirm = Number(process.env.WT_SUPERVISOR_ORPHAN_CONFIRM_MS);
    if (every > 0) c.everyMs = every;
    if (confirm > 0) c.orphanConfirmMs = confirm;
  }
  return c;
}

/** This server's own sessions as the graph reads them: the same spawn and brief helpers as
 *  /api/sessions, so a field cannot mean one thing here and another there. */
async function supervisorLocalRows() {
  // #467 - the rows GET /api/sessions serves, never a slimmer copy: R4 reads `reason`, which a
  // hand-built row lacked, so a wait on the owner on THIS server was never pushed.
  return sessionsListRows();
}

/** Every in-scope server's sessions, and the journal lines it wrote since the last poll.
 *  A server that does not answer is `ok: false` - the graph reads that as "unknown". */
async function supervisorPoll(cfg) {
  const me = getServerName();
  const out = [];
  try { out.push({ name: me, ok: true, sessions: await supervisorLocalRows() }); }
  catch (e) { out.push({ name: me, ok: false, reason: `worker: ${e.message}`, sessions: [] }); }
  try {
    // Read again only when the file changed: a 2 MB journal is not re-read every minute.
    let st = null;
    try { st = fs.statSync(SESSIONS_JOURNAL_FILE); } catch { /* absent: no lines yet */ }
    const sig = st ? `${st.size}:${st.mtimeMs}` : 'none';
    if (!_sup.localJournal || _sup.localJournal.sig !== sig) {
      _sup.journal[me] = journalLib.trimEvents(workItemLog.readLines(SESSIONS_JOURNAL_FILE), Date.now());
      _sup.localJournal = { sig };
    }
  } catch (e) { console.error(`[supervisor] local journal: ${e.message}`); }
  const tokens = loadClusterTokens();
  const publicUrl = liveConfig('publicUrl', null);
  const peers = getClusterConfig().filter((s) => s && s.url && (!publicUrl || s.url !== publicUrl) && s.name !== me && !supervisorLib.isExcluded(s.name, cfg));
  const answers = await Promise.all(peers.map(async (server) => {
    const tok = tokens[server.url] && tokens[server.url].token;
    if (!tok) return { name: server.name, ok: false, reason: 'no stored token', sessions: [] };
    const headers = { 'Authorization': `Bearer ${tok}` };
    let entry;
    try {
      const r = await clusterFetch(`${server.url}/api/sessions`, { headers, timeout: 8000 });
      if (!r.ok) return { name: server.name, ok: false, reason: `HTTP ${r.status}`, sessions: [] };
      const rows = JSON.parse(r.body);
      if (!Array.isArray(rows)) return { name: server.name, ok: false, reason: 'not a session list', sessions: [] };
      entry = { name: server.name, ok: true, sessions: rows };
    } catch (e) { return { name: server.name, ok: false, reason: (e && e.message) || 'unreachable', sessions: [] }; }
    // Its journal, from where the last poll stopped. A peer too old to have one answers 404:
    // its sessions still count, its history is simply not known.
    const read = await journalLib.readPeerJournal({
      cursor: _sup.cursors[server.name], fromMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
      fetchPage: (since) => clusterFetch(`${server.url}/api/journal?since=${since}`, { headers, timeout: 8000 }),
    });
    if (read.events.length) _sup.journal[server.name] = journalLib.trimEvents(journalLib.mergeEvents(_sup.journal[server.name], read.events), Date.now());
    if (Number.isFinite(read.cursor)) _sup.cursors[server.name] = read.cursor;
    entry.journal = read.status;
    return entry;
  }));
  return [...out, ...answers];
}

async function supervisorScan() {
  const cfg = supervisorCfg();
  if (!cfg.enabled || _sup.busy) return;
  if (supervisorAuthority().mode !== 'self') {
    if (_sup.graph) Object.assign(_sup, { graph: null, sightings: {}, verdicts: {}, journal: {}, cursors: {}, known: new Set(), localJournal: null,
      absent: {}, resolutions: {}, lookups: {}, baselines: {} });
    return;
  }
  if (Date.now() - _sup.at < cfg.everyMs) return;
  _sup.busy = true; _sup.at = Date.now();
  try {
    const servers = await supervisorPoll(cfg);
    const graph = supervisorLib.buildGraph(servers, Date.now());
    // A lead is judged only if it was ever seen in scope (live or journalled): one on an
    // excluded server, or one this supervisor never saw, is "unknown", never an orphan.
    const known = supervisorLib.knownIds(_sup.known, graph, journalLib.foldJournal(_sup.journal));
    const { sightings, verdicts } = supervisorLib.noteOrphans(_sup.sightings, graph, { ...cfg, known });
    // Logged on a CHANGE only, with its inputs: a verdict, and a server that stops or starts answering.
    for (const n of graph.nodes) {
      const was = _sup.verdicts[n.id], now = verdicts[n.id];
      if ((was && was.state) !== (now && now.state)) {
        supervisorLog({ event: 'orphan', id: n.id, server: n.server, state: now ? now.state : 'cleared', parentId: n.parentId,
          since: now ? now.since : null, complete: graph.complete });
      }
    }
    const before = new Map(((_sup.graph && _sup.graph.servers) || []).map((s) => [s.name, s.ok]));
    for (const s of graph.servers) {
      if (before.get(s.name) !== s.ok) supervisorLog({ event: 'server', server: s.name, ok: s.ok, reason: s.reason });
    }
    Object.assign(_sup, { graph, sightings, verdicts, known });
    // #467 - phase 2 acts on what the graph says: R1 wake on fact, R2 tell an orphan, R4 owner.
    await supervisorAct(cfg, graph, verdicts, known);
  } catch (e) {
    console.error(`[supervisor] scan: ${e.message}`);
  } finally { _sup.busy = false; }
}
// --- #467 Supervisor phase 2: wake on fact (R1), tell an orphan (R2), reach the owner (R4) ---
// The rules are lib/supervisor.js (planActions, ownerPlan), lib/wait-target.js (resolveLocal,
// fromLookup) and lib/quiet-hours.js; this is the I/O. Every prompt goes through the gated
// prompt of the session's OWN server (gatedPrompt here, POST /api/sessions/:id/prompt on a
// peer), which re-checks every gate and refuses a wait that changed since (expectWaitAt).
const _execFileP = require('util').promisify(execFile);

/** What is already done, from the supervisor's own log, read once: a restart neither wakes a
 *  session twice for one wait nor pushes an owner wait it pushed an hour ago. */
function supervisorSeed() {
  if (_sup.seeded) return;
  _sup.seeded = true;
  let lines = [];
  try { lines = workItemLog.readLines(SUPERVISOR_LOG_FILE); } catch { return; }
  for (const l of lines) {
    if (!l || typeof l !== 'object') continue;
    if ((l.event === 'wake' || l.event === 'orphan-told') && typeof l.key === 'string') _sup.done.add(l.key);
    // #469 - a close-out asked (and counted toward maxAsks), a session closed: never twice.
    if (['closeout-ask', 'closeout-close'].includes(l.event) && typeof l.key === 'string') {
      _co.done.add(l.key);
      if (l.event === 'closeout-ask' && typeof l.id === 'string' && Number.isFinite(l.at)) (_co.asks[l.id] = _co.asks[l.id] || []).push(l.at);
    }
    const keys = l.event === 'owner-push' && typeof l.key === 'string' ? [l.key]
      : l.event === 'owner-summary' && Array.isArray(l.keys) ? l.keys.filter((k) => typeof k === 'string') : [];
    for (const k of keys) {
      if (!Number.isFinite(l.at)) continue;
      const e = _sup.ladder[k] || { firstAt: l.at, lastAt: null, n: 0, held: false };
      e.lastAt = Math.max(e.lastAt || 0, l.at); e.n += 1;
      _sup.ladder[k] = e;
    }
  }
}

/** The recent actions, shown inline on the session they touched (GET /api/supervisor/state).
 *  #475 - every action carries the case it served and, for an answer given for the owner, how
 *  to undo it, as fields of their own (null when none): the Supervisor's feed shows both. */
function supervisorNote(a) {
  _sup.actions.push({ ...a, caseId: a.caseId || null, undo: a.undo || null });
  if (_sup.actions.length > 200) _sup.actions.splice(0, _sup.actions.length - 200);
}

/** `gh` with JSON output. Under WT_TEST only, WT_SUPERVISOR_GH_SCRIPT runs a node script in
 *  its place, so a spec answers for GitHub. Never throws: `{ok, json}` or `{ok: false, stderr}`. */
async function supervisorGh(args) {
  const fake = process.env.WT_TEST === '1' ? process.env.WT_SUPERVISOR_GH_SCRIPT : null;
  const [cmd, argv] = fake ? [process.execPath, [fake, ...args]] : ['gh', args];
  try {
    const { stdout } = await _execFileP(cmd, argv, { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { ok: true, json: JSON.parse(stdout) };
  } catch (e) {
    return { ok: false, stderr: String((e && (e.stderr || e.message)) || '') };
  }
}

// The ADO token: ADO_PAT from this process, else from the User scope of the registry (a
// server started by a scheduled task does not inherit it). Cached 10 min; never logged.
let _adoPat = { at: 0, value: null };
async function adoPat() {
  if (process.env.ADO_PAT) return process.env.ADO_PAT;
  if (Date.now() - _adoPat.at < 10 * 60 * 1000) return _adoPat.value;
  _adoPat = { at: Date.now(), value: null };
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await _execFileP('reg', ['query', 'HKCU\\Environment', '/v', 'ADO_PAT'], { timeout: 5000, windowsHide: true });
    const m = /ADO_PAT\s+REG_(?:EXPAND_)?SZ\s+(\S+)/.exec(stdout);
    _adoPat.value = m ? m[1] : null;
  } catch { /* not set */ }
  return _adoPat.value;
}

/** GET one ADO REST path under the configured org. 404 is 'gone'; anything else that is not
 *  JSON (a sign-in page, a 401, a timeout) is 'unknown'. Under WT_TEST only,
 *  WT_SUPERVISOR_ADO_URL replaces https://dev.azure.com. */
async function supervisorAdo(pathAndQuery, cfg) {
  const org = cfg.ado && cfg.ado.org;
  if (!org) return { state: 'unknown' };
  const pat = await adoPat();
  if (!pat) return { state: 'unknown' };
  const base = (process.env.WT_TEST === '1' && process.env.WT_SUPERVISOR_ADO_URL) || 'https://dev.azure.com';
  try {
    const r = await fetch(`${base}/${encodeURIComponent(org)}/${pathAndQuery}`, {
      headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, Accept: 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return { state: 'gone' };
    if (r.status !== 200) return { state: 'unknown' };
    return { ok: true, json: await r.json() };
  } catch { return { state: 'unknown' }; }
}

/** A target's name in a sentence ("PR o/r#12"), for a "not found" fact. */
function targetLabel(t) {
  if (t.kind === 'pr') return `PR ${t.repo}#${t.number}`;
  if (t.kind === 'ci') return `CI for ${t.repo} ${t.pr ? `PR ${t.pr}` : `run ${t.runId}`}`;
  return t.ref;
}

/** One outside lookup: `{kind, json}` for lib/wait-target.js fromLookup, or `{state}`. */
async function supervisorLookup(t, cfg) {
  const gh = async (kind, args) => {
    const r = await supervisorGh(args);
    return r.ok ? { kind, json: r.json } : { state: waitTargetLib.ghFailure(r.stderr) };
  };
  const ghRepo = t.kind === 'workitem' ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(t.ref) : null;
  if (t.kind === 'workitem' && ghRepo) return gh('gh-issue', ['issue', 'view', ghRepo[2], '--repo', ghRepo[1], '--json', 'state']);
  if (t.kind === 'workitem') {
    const m = /^ado:(\d+)$/.exec(t.ref);
    if (!m) return { state: 'unknown' }; // a bare #123 whose repo was never known
    const r = await supervisorAdo(`_apis/wit/workitems/${m[1]}?fields=System.State&api-version=7.1`, cfg);
    return r.ok ? { kind: 'ado-wi', json: r.json } : r;
  }
  if (t.provider === 'github') {
    if (t.kind === 'pr') return gh('gh-pr', ['pr', 'view', String(t.number), '--repo', t.repo, '--json', 'state,reviews']);
    if (t.pr) return gh('gh-checks', ['pr', 'view', String(t.pr), '--repo', t.repo, '--json', 'statusCheckRollup']);
    return gh('gh-run', ['run', 'view', t.runId, '--repo', t.repo, '--json', 'status,conclusion']);
  }
  // ADO: a repo is "repo" or "project/repo"; a project-scoped call needs the project.
  const project = t.repo.includes('/') ? t.repo.split('/')[0] : (cfg.ado && cfg.ado.project);
  let r, kind;
  if (t.kind === 'pr') { kind = 'ado-pr'; r = await supervisorAdo(`_apis/git/pullrequests/${t.number}?api-version=7.1`, cfg); }
  else if (!project) return { state: 'unknown' };
  else if (t.pr) {
    kind = 'ado-builds';
    r = await supervisorAdo(`${encodeURIComponent(project)}/_apis/build/builds?branchName=${encodeURIComponent(`refs/pull/${t.pr}/merge`)}&queryOrder=queueTimeDescending&$top=20&api-version=7.1`, cfg);
  } else { kind = 'ado-build'; r = await supervisorAdo(`${encodeURIComponent(project)}/_apis/build/builds/${t.runId}?api-version=7.1`, cfg); }
  return r.ok ? { kind, json: r.json } : r;
}

/** Every wakeable session's target answer, this scan (R1's input). */
async function supervisorResolve(cfg, graph, verdicts, known) {
  const now = Date.now();
  const nodes = graph.nodes.filter(supervisorLib.wakeable);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const find = (id) => byId.get(id) || byId.get((graph.aliases || {})[id]) || null;
  const ids = [];
  for (const n of nodes) {
    const t = n.wait.target;
    if (t.kind === 'session') ids.push(t.id);
    if (t.kind === 'child') ids.push(...t.ids);
  }
  const ab = supervisorLib.noteAbsent(_sup.absent, ids, graph, { confirmMs: cfg.orphanConfirmMs, known });
  _sup.absent = ab.sightings;
  const out = {};
  const live = new Set();
  let lookups = 0;
  for (const n of nodes) {
    const t = n.wait.target;
    let r = waitTargetLib.resolveLocal(t, { waiter: n, find, absence: (id) => ab.states[id] || 'unknown', leadVerdict: verdicts[n.id] || null, now });
    if (!r) {
      const lk = waitTargetLib.lookupKey(t);
      const bkey = `${n.id}|${n.wait.at}|${lk}`;
      live.add(bkey);
      let c = _sup.lookups[lk];
      // One lookup answers every wait on the same target; at most lookupsPerScan a scan.
      if ((!c || now - c.at >= cfg.resolveEveryMs) && lookups < cfg.lookupsPerScan) {
        lookups++;
        c = { at: now, ...(await supervisorLookup(t, cfg)) };
        _sup.lookups[lk] = c;
      }
      if (!c) r = { state: 'unknown', fact: '' };
      else if (c.state) r = { state: c.state, fact: c.state === 'gone' ? `${targetLabel(t)} was not found` : '' };
      else {
        const base = Object.prototype.hasOwnProperty.call(_sup.baselines, bkey) ? _sup.baselines[bkey] : null;
        r = waitTargetLib.fromLookup(c.kind, c.json, { target: t, since: n.wait.at, baseline: base });
        if (base === null && r.sig !== null && r.sig !== undefined) _sup.baselines[bkey] = r.sig;
      }
    }
    const was = _sup.resolutions[n.id];
    if (!was || was.state !== r.state || was.waitAt !== n.wait.at) {
      supervisorLog({ event: 'wait-state', id: n.id, server: n.server, waitAt: n.wait.at, kind: t.kind, state: r.state, ...(r.fact ? { fact: r.fact } : {}) });
    }
    out[n.id] = { state: r.state, fact: r.fact || '', waitAt: n.wait.at };
  }
  _sup.resolutions = out;
  for (const k of Object.keys(_sup.baselines)) if (!live.has(k)) delete _sup.baselines[k];
  for (const [k, c] of Object.entries(_sup.lookups)) if (now - c.at > 60 * 60 * 1000) delete _sup.lookups[k];
}

/** #498 - a refusal from a session's own server, as `{why}`. Its 404 "session not found" is
 *  that server ANSWERING that it has no such session: the one refusal that is proof the session
 *  is gone (`gone`), so a card about it retires. A 404 with any other body (an older peer with
 *  no such route) proves nothing. */
function supRefusal(status, json) {
  const j = json && typeof json === 'object' ? json : {};
  const why = j.refused || j.error || `HTTP ${status}`;
  return status === 404 && j.error === 'session not found' ? { why, gone: true } : { why };
}

/** Type one planned prompt through the gated prompt of the session's own server.
 *  `{delivered}`, `{uncertain}` (the request went out and no answer came: it may have
 *  landed, so it is never sent again), or `{why}`. */
const supervisorDeliver = (a) => deliverGatedPrompt(a, 'supervisor');
/** The one way a server-built prompt reaches a session on ANY server: gatedPrompt here, POST
 *  /api/sessions/:id/prompt on a peer (with this server's stored token). [by] names the caller
 *  in this server's log (the supervisor, #506 Mission Control's park message). */
async function deliverGatedPrompt(a, by) {
  // #469: a.template names a text the session's own server builds (the close-out).
  const body = { ...(a.template ? { template: a.template } : { text: a.text }), tag: 'supervisor', ...(a.expectWaitAt ? { expectWaitAt: a.expectWaitAt } : {}),
    ...(a.clearWait && a.expectWaitAt ? { clearWait: true } : {}) };
  if (a.server === getServerName()) {
    const out = await gatedPrompt(a.id, body, by);
    return out.json && out.json.delivered ? { delivered: true } : supRefusal(out.status, out.json);
  }
  const peer = getClusterConfig().find((x) => x && x.name === a.server && x.url);
  if (!peer) return { why: 'no-such-server' };
  const tok = (loadClusterTokens()[peer.url] || {}).token;
  if (!tok) return { why: 'no stored token' };
  try {
    const r = await clusterFetch(`${peer.url}/api/sessions/${encodeURIComponent(a.id)}/prompt`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), timeout: 20000 });
    let j = {};
    try { j = JSON.parse(r.body); } catch { /* not JSON */ }
    if (r.ok && j.delivered) return { delivered: true };
    return supRefusal(r.status, j);
  } catch (e) {
    // Refused at connect: nothing was sent. A timeout: it may have been typed.
    if (e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH')) return { why: 'unreachable' };
    return { uncertain: true };
  }
}

/** R4's push for a session on [server] (any machine): through this server's own push
 *  transport, naming the session's server so the phone opens the right one. */
function ownerPush(id, server, name, text) {
  const local = server === getServerName();
  let click;
  if (local) {
    click = sessionClickUrl(id);
    _nstate(id).lastAttention = notifyPush.makeAttention('owner-wait', { reason: text, name });
  } else {
    const peer = getClusterConfig().find((x) => x && x.name === server && x.url);
    click = peer ? `${String(peer.url).replace(/\/+$/, '')}/app/${encodeURIComponent(id)}` : undefined;
  }
  return deliverPush('owner-wait', { id, name, reason: text, serverName: server, click })
    .catch((e) => console.error('notify(owner-wait) failed:', e.message));
}

async function supervisorAct(cfg, graph, verdicts, known) {
  supervisorSeed();
  await supervisorResolve(cfg, graph, verdicts, known);
  const now = Date.now();
  for (const [id, ts] of Object.entries(_sup.acts)) {
    const keep = ts.filter((t) => now - t < 60 * 60 * 1000);
    if (keep.length) _sup.acts[id] = keep; else delete _sup.acts[id];
  }
  const plan = supervisorLib.planActions({ graph, verdicts, resolutions: _sup.resolutions, done: _sup.done, acts: _sup.acts, now, cfg });
  const planned = new Set();
  for (const a of plan) {
    planned.add(a.key);
    const ev = a.rule === 'R1' ? 'wake' : 'orphan-told';
    if (!cfg.wake) {
      if (_sup.refused[a.key] !== 'off') { _sup.refused[a.key] = 'off'; supervisorLog({ event: `${ev}-off`, key: a.key, id: a.id, server: a.server }); }
      continue;
    }
    const d = await supervisorDeliver(a);
    if (d.delivered || d.uncertain) {
      _sup.done.add(a.key);
      (_sup.acts[a.id] = _sup.acts[a.id] || []).push(now);
      supervisorLog({ event: ev, key: a.key, id: a.id, server: a.server, rule: a.rule, text: a.text, ...(d.uncertain ? { uncertain: true } : {}) });
      supervisorNote({ at: now, id: a.id, server: a.server, rule: a.rule, text: a.text, outcome: d.delivered ? 'delivered' : 'uncertain' });
    } else if (_sup.refused[a.key] !== d.why) {
      // A refusal is retried next scan; logged only when its reason changes.
      _sup.refused[a.key] = d.why;
      supervisorLog({ event: `${ev}-refused`, key: a.key, id: a.id, server: a.server, why: d.why });
    }
  }
  for (const k of Object.keys(_sup.refused)) if (!planned.has(k)) delete _sup.refused[k];
  // #468 - what the rules could not settle: cases for the dispatcher, or for the owner.
  try { await supervisorDispatch(cfg, graph, verdicts); } catch (e) { console.error(`[supervisor] dispatch: ${e.message}`); }
  // #498 - a card whose session is proven gone leaves the owner's queue by itself.
  try { supervisorRetireCards(cfg, graph); } catch (e) { console.error(`[supervisor] retire cards: ${e.message}`); }
  // #469 - R5: a done session is asked to close out, then closed (an agent's) or marked (the owner's).
  try { await supervisorCloseout(cfg, graph); } catch (e) { console.error(`[supervisor] close-out: ${e.message}`); }
  const quiet = quietNow(now).quiet;
  if (quiet && !_sup.quietFrom) _sup.quietFrom = now;
  if (!cfg.ownerPush) { if (!quiet) _sup.quietFrom = null; return; }
  const o = supervisorLib.ownerPlan({ graph, ladder: _sup.ladder, quiet, now, cfg, extra: supCases.ownerItems(_disp.state, now).concat(closeoutOwnerItems()) });
  _sup.ladder = o.ladder;
  for (const x of o.pushes) {
    const text = x.what ? `Waiting on you: ${x.what}` : 'Waiting on you';
    await ownerPush(x.id, x.server, x.name, text);
    supervisorLog({ event: 'owner-push', key: x.key, id: x.id, server: x.server, n: x.n });
    supervisorNote({ at: now, id: x.id, server: x.server, rule: 'R4', text, outcome: x.n > 1 ? `reminder ${x.n}` : 'pushed' });
  }
  if (o.summary) {
    // #468 - the morning push also says what the night shift did (section 6a).
    const text = supCases.nightSummary(_sup.actions, _sup.quietFrom || 0, o.summary.count);
    await ownerPush(o.summary.id, o.summary.server, o.summary.name, text);
    supervisorLog({ event: 'owner-summary', keys: Object.keys(o.ladder), count: o.summary.count });
    supervisorNote({ at: now, id: o.summary.id, server: o.summary.server, rule: 'R4', text, outcome: 'summary' });
  }
  if (!quiet) _sup.quietFrom = null;
}
// --- #468 Supervisor phase 3: the dispatcher (L2), cases, verbs, recommendation cards -----
// The rules are lib/supervisor-cases.js (which case, act or card, the owner's queue) and
// lib/circling.js (R9's evidence); this is the I/O. The dispatcher is one Claude Code
// session on the authority, started by the server when the first case needs it and again
// whenever it is gone; it follows its own hand-offs through `replaces`. Every verb it runs
// (scripts/wt-supervise.js) types through supervisorDeliver, so the gated prompt of the
// session's own server re-checks every gate, and a card is typed only on the owner's Approve.
const SUPERVISOR_CASES_FILE = process.env.WT_SUPERVISOR_CASES_FILE || path.join(HANDOFF_DIR, 'supervisor-cases.jsonl');
const SUPERVISOR_SETTINGS_FILE = process.env.WT_SUPERVISOR_SETTINGS_FILE || path.join(HANDOFF_DIR, 'supervisor-settings.json');
const SUPERVISE_CLI = path.join(__dirname, 'scripts', 'wt-supervise.js').split(path.sep).join('/');
/** New cases opened per scan at most: a first scan after a deploy must not open fifty. */
const CASES_PER_SCAN = 5;
const _disp = { loaded: false, state: supCases.foldCases([]), verbs: [], refusals: {}, starting: false, lastStartAt: 0,
  // #498 - the sightings of pending cards' sessions missing from the scan (lib/supervisor.js noteAbsent).
  cardAbsent: {} };
/** A case or card named in a route, or null: only an id of the minted shape is looked up. */
const supCaseById = (id) => (supCases.ID_RE.test(String(id)) ? _disp.state.cases[String(id)] || null : null);
const supCardById = (id) => (supCases.ID_RE.test(String(id)) ? _disp.state.cards[String(id)] || null : null);

function casesLoad() {
  if (_disp.loaded) return;
  _disp.loaded = true;
  try { supCases.foldCases(workItemLog.readLines(SUPERVISOR_CASES_FILE), _disp.state); } catch (e) { console.error(`[supervisor] cases read: ${e.message}`); }
}
/** Append one case event and apply it to what is held. */
function casesEvent(e) {
  const line = { at: Date.now(), ...e };
  try { workItemLog.appendLines(SUPERVISOR_CASES_FILE, [line], { maxBytes: journalLib.MAX_BYTES }); } catch (err) { console.error(`[supervisor] cases write: ${err.message}`); }
  supCases.foldCases([line], _disp.state);
}
/** The live switches the app writes (pause, a class's autonomy), and the dispatcher's id. */
// Read at most every 2 s: GET /api/sessions asks it once per row (isDispatcherSession).
let _supSettingsMemo = { at: 0, value: {} };
function supSettings() {
  if (Date.now() - _supSettingsMemo.at < 2000) return _supSettingsMemo.value;
  let v = {};
  try { const j = JSON.parse(fs.readFileSync(SUPERVISOR_SETTINGS_FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) v = j; } catch { /* absent: defaults */ }
  _supSettingsMemo = { at: Date.now(), value: v };
  return v;
}
function supSettingsSet(patch) {
  const next = { ...supSettings(), ...patch };
  _supSettingsMemo = { at: Date.now(), value: next };
  try {
    fs.mkdirSync(path.dirname(SUPERVISOR_SETTINGS_FILE), { recursive: true });
    const tmp = `${SUPERVISOR_SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, SUPERVISOR_SETTINGS_FILE);
  } catch (e) { console.error(`[supervisor] settings write: ${e.message}`); }
  return next;
}
/** config.json `supervisor.dispatcher` / `.autonomy`, with the app's switches laid over it. */
function dispatcherCfg() {
  const d = supCases.dispatcherConfig(liveConfig('supervisor', null));
  const st = supSettings();
  if (st.autonomy && typeof st.autonomy === 'object') for (const k of supCases.CLASSES) if (['act', 'recommend'].includes(st.autonomy[k])) d.autonomy[k] = st.autonomy[k];
  if (!d.cwd) d.cwd = path.join(HANDOFF_DIR, 'supervisor');
  // The test seam's command gets the model as a configured one does (#525).
  if (process.env.WT_TEST === '1' && process.env.WT_SUPERVISOR_DISPATCHER_CMD) d.autoCommand = supCases.withModel(process.env.WT_SUPERVISOR_DISPATCHER_CMD, d.model);
  if (process.env.WT_TEST === '1' && Number(process.env.WT_SUPERVISOR_MINUTE_MS) > 0) {
    d.minuteMs = Number(process.env.WT_SUPERVISOR_MINUTE_MS);
    d.goneMs = Math.round((d.goneMs / 60000) * d.minuteMs); // #470 R7, on the same shortened clock
  }
  return d;
}
function isDispatcherSession(id) { return Boolean(id) && supSettings().dispatcherId === id; }
/** #475 - [s] is the dispatcher's row: its own role (a row from any server) or this server's id
 *  for it. It is the fleet's supervisor, not one of its sessions, so nothing that COUNTS sessions
 *  counts it: the machine's session count (the soft limit) and a replacement's capacity check.
 *  Mission Control keeps its own rule for the row (#532, lib/mc-subjects.js isSupervisor). */
function isDispatcherRow(s) { return Boolean(s) && (s.role === 'supervisor' || isDispatcherSession(s.id)); }
/** #475 - [rows] without the dispatcher's: THE list of what counts as a session (the machine's
 *  session count and soft limit, a replacement's capacity check). */
function countedSessions(rows) { return (Array.isArray(rows) ? rows : []).filter((s) => !isDispatcherRow(s)); }

/** The dispatcher's node this scan, following a hand-off to its successor (`replaces`). */
function dispatcherNode(graph) {
  const id = supSettings().dispatcherId;
  if (!id || !graph) return null;
  const to = graph.nodes.find((n) => n.id === id) ? id : (graph.aliases || {})[id];
  if (!to) return null;
  if (to !== id) {
    supSettingsSet({ dispatcherId: to });
    // The successor waits for cases too: no check-ins, as dispatcherStart set for the first.
    dispatcherQuiet(to);
    supervisorLog({ event: 'dispatcher-successor', from: id, id: to });
  }
  return graph.nodes.find((n) => n.id === to) || null;
}
/** The dispatcher session [id] is never checked in on (#443): it waits for cases. Its own
 *  server holds the brief, and the dispatcher (and every successor it starts) is local. */
function dispatcherQuiet(id) {
  const e = getBriefEntry(id) || briefLib.emptyEntry();
  if (e.checkInOff === true) return;
  e.checkInOff = true;
  setBriefEntry(id, e);
}

/** Start the dispatcher session on this server: its folder, its rules, its notes. At most
 *  one start per 5 min, so a dispatcher that dies at boot is not respawned in a loop. */
/** Its first prompt, on its command line: a fresh agent reads `active` until its first turn
 *  ends, so the gated prompt (idle only) could never hand it a case. Fixed text, no quotes. */
const DISPATCHER_START_PROMPT = `${SUPERVISOR_PROMPT_TAG} You are the Supervisor's dispatcher. Read CLAUDE.md and notes.md in this folder, then take the open cases as CLAUDE.md says.`;
async function dispatcherStart(dcfg, untaken) {
  if (_disp.starting || Date.now() - _disp.lastStartAt < 5 * 60 * 1000) return;
  _disp.starting = true; _disp.lastStartAt = Date.now();
  try {
    fs.mkdirSync(dcfg.cwd, { recursive: true });
    const rules = fs.readFileSync(path.join(__dirname, 'lib', 'supervisor-dispatcher.md'), 'utf8').split('{{CLI}}').join(SUPERVISE_CLI);
    fs.writeFileSync(path.join(dcfg.cwd, 'CLAUDE.md'), rules);
    const notes = path.join(dcfg.cwd, 'notes.md');
    if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Supervisor notes\n\nDecisions, the owner\'s answers, how to undo. Newest last.\n');
    const id = crypto.randomUUID();
    const autoCommand = `${dcfg.autoCommand} "${DISPATCHER_START_PROMPT}"`;
    const created = await workerClient.rpc('createSession', { id, cwd: dcfg.cwd, name: dcfg.name, autoCommand, agent: 'claude' });
    supSettingsSet({ dispatcherId: id, dispatcherStartedAt: Date.now() });
    maintUpdate((h) => maintLib.trackSession(h, { id, name: dcfg.name, agent: 'claude' }));
    // No spawn record: the #351 reaper must never close it. No check-ins: it waits for cases.
    dispatcherQuiet(id);
    journalAppend(journalLib.openedRecord({ id, at: Date.now(), via: 'supervisor', name: created.name || dcfg.name, cwd: dcfg.cwd, agent: 'claude',
      spawnedBy: 'web-terminal supervisor', goal: 'Take the cases the supervisor rules cannot settle' }));
    supervisorLog({ event: 'dispatcher-start', id, ...(dcfg.model ? { model: dcfg.model } : {}),
      ...(dcfg.modelRefused ? { modelRefused: dcfg.modelRefused } : {}) });
    // The cases open now are what its first prompt sends it to read.
    for (const c of untaken || []) casesEvent({ event: 'delivered', caseId: c.id, via: 'start' });
    invalidateClusterSessionsCache();
  } catch (err) {
    supervisorLog({ event: 'dispatcher-start-failed', why: String((err && err.message) || err).slice(0, 200) });
  } finally { _disp.starting = false; }
}

/** #525 - close the dispatcher [disp] when it is past its own context point (dcfg.handoffTokens),
 *  idle between cases (no case in hand) and every hand-off gate that is safety says yes, and start a
 *  fresh one. The same
 *  rule as the #393 hand-off (lib/handoff.js handoffCandidate, on the dispatcher's terms, and
 *  autoBlock: typing, a draft, the owner's switches). No wrap-up, brief or successor run: its
 *  memory is notes.md, written after every case, and a run that fails or is kept would leave a
 *  dispatcher nothing types into. Returns true when it closed it. */
async function dispatcherRecycle(disp, dcfg) {
  if (disp.server !== getServerName()) return false; // it runs here, or it is not ours to close
  const now = Date.now();
  const terms = supCases.dispatcherHandoffTerms(dcfg, _disp.state, now);
  let row;
  try { row = await handoffRowFor(disp.id); } catch { return false; }
  const cfg = handoffCfg();
  const h = handoffLib.handoffCandidate(row, { now, cfg, supported: agentsLib.handsOff(row.agent), terms });
  if (!h || !h.suggest) return false;
  const inputAt = _lastInputAt.get(disp.id);
  // The hand-off's safety gates (typing, a draft), not its `auto` switch: that one is about
  // hand-off runs, and turning it off must not lift the dispatcher's context cap.
  if (handoffLib.autoBlock(getBriefEntry(disp.id), { ...cfg, auto: true }, { now, inputAt, draft: composerHasDraft(disp.id) })) return false;
  // The row was read across awaits: nothing typed, no new turn, no case handed over since.
  const turnAt = (getBriefEntry(disp.id) || {}).turnAt || null;
  if (_lastInputAt.get(disp.id) !== inputAt || composerHasDraft(disp.id) || turnAt !== ((row.brief && row.brief.turnAt) || null)
    || supCases.caseInHand(_disp.state, Date.now())) return false;
  supervisorLog({ event: 'dispatcher-recycle', id: disp.id, ctxTokens: h.ctxTokens, at: terms.ctxThreshold });
  try { await killLocalSession(disp.id, 'closed'); } catch (err) {
    supervisorLog({ event: 'dispatcher-recycle-failed', id: disp.id, why: String((err && err.message) || err).slice(0, 200) });
    return false;
  }
  // Its replacement starts now, so the owner's Tell always has a dispatcher to reach. The 5-min
  // start guard is against a dispatcher that dies at boot; this one was closed on purpose. A
  // fresh one is far below its point, so this cannot loop.
  _disp.lastStartAt = 0;
  await dispatcherStart(dcfg, []);
  return true;
}

/** Open the cases this scan finds, retire the ones whose trigger moved on, hand the oldest
 *  untaken one to the dispatcher - or to the owner when the dispatcher cannot take it. */
async function supervisorDispatch(cfg, graph, verdicts) {
  casesLoad();
  const dcfg = dispatcherCfg();
  const now = Date.now();
  const disp = dispatcherNode(graph);
  const skip = new Set([supSettings().dispatcherId, disp && disp.id].filter(Boolean));
  for (const n of graph.nodes) if (n.role === 'supervisor') skip.add(n.id);
  let opened = 0;
  for (const k of supCases.caseCandidates({ graph, verdicts, resolutions: _sup.resolutions, now, cfg: dcfg, skip })) {
    if (_disp.state.keys.has(k.key) || opened >= CASES_PER_SCAN) continue;
    opened++;
    const c = supCases.openCase(k, crypto.randomBytes(4).toString('hex'), now);
    casesEvent({ event: 'open', case: c });
    supervisorLog({ event: 'case-open', caseId: c.id, rule: c.rule, id: c.sessionId, server: c.server });
    supervisorNote({ at: now, id: c.sessionId, server: c.server, rule: c.rule, text: c.line, outcome: 'case', caseId: c.id });
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const c of Object.values(_disp.state.cases)) {
    if (c.resolvedAt || supCases.caseHolds(c, byId.get(c.sessionId), graph, verdicts)) continue;
    casesEvent({ event: 'resolved', caseId: c.id, how: 'obsolete: what opened it has moved on', by: 'rules' });
    supervisorLog({ event: 'case-obsolete', caseId: c.id, id: c.sessionId });
  }
  // #525 - a dispatcher past its own context point, idle with no case in hand, is closed and a
  // fresh one started (dispatcherStart: its rules, its model, notes.md as memory).
  if (disp && await dispatcherRecycle(disp, dcfg)) return;
  // Every open case the owner does not hold yet and the dispatcher has not taken (caseDue),
  // and (#498) every case escalated only because the dispatcher never got to it: the
  // supervisor still looks first, so it is still handed over.
  const pending = Object.values(_disp.state.cases)
    .filter((c) => !c.resolvedAt && !c.takenAt && (!c.escalated || supCases.caseDue(c, now) === 'deliver'))
    .sort((a, b) => a.openedAt - b.openedAt);
  if (!pending.length) return;
  const block = supCases.dispatcherBlock({ cfg: dcfg, paused: Boolean(supSettings().paused), node: disp });
  const escalate = (c, why, cause) => {
    casesEvent({ event: 'escalated', caseId: c.id, question: c.line, by: `rules (${why})`, auto: true, cause });
    supervisorLog({ event: 'case-escalated', caseId: c.id, id: c.sessionId, why });
  };
  // A blocked dispatcher looks at nothing: every such case is the owner's now (#498: also
  // one escalated earlier as untaken, once).
  if (block) { for (const c of pending) escalate(c, `dispatcher ${block}`, 'blocked'); return; }
  const toDeliver = [];
  for (const c of pending) {
    const due = supCases.caseDue(c, now);
    if (due === 'escalate') escalate(c, `not taken in ${supCases.CASE_UNTAKEN_MS / 60000} min${_disp.refusals[c.id] ? `: ${_disp.refusals[c.id]}` : ''}`, 'untaken');
    else if (due === 'deliver') toDeliver.push(c);
  }
  const next = toDeliver[0];
  if (!next) return;
  // The dispatcher runs HERE, so what decides a start is that this server answered the
  // scan (its sessions are known, so "not running" is a fact), not every peer answering.
  if (!disp) {
    const self = graph.servers.find((s) => s.name === getServerName());
    if (self && self.ok) await dispatcherStart(dcfg, toDeliver);
    return;
  }
  const d = await supervisorDeliver({ id: disp.id, server: disp.server, text: supCases.casePrompt(next, SUPERVISE_CLI, supervisorLib.TEXT_BYTES_MAX) });
  if (d.delivered || d.uncertain) {
    casesEvent({ event: 'delivered', caseId: next.id });
    supervisorLog({ event: 'case-delivered', caseId: next.id, to: disp.id, ...(d.uncertain ? { uncertain: true } : {}) });
  } else _disp.refusals[next.id] = d.why;
}

/** A session in the last scan, by full id or a unique 8+ character prefix. */
function supNodeByRef(ref) {
  const r = String(ref || '').toLowerCase();
  if (!_sup.graph || !/^[0-9a-f-]{8,36}$/.test(r)) return null;
  const hits = _sup.graph.nodes.filter((n) => n.id === r || n.id.startsWith(r));
  return hits.length === 1 ? hits[0] : null;
}
/** A case's public shape: what the companion and the dispatcher read. */
const caseView = (c) => ({ id: c.id, rule: c.rule, sessionId: c.sessionId, server: c.server, name: c.name, line: c.line, openedAt: c.openedAt,
  deliveredAt: c.deliveredAt, takenAt: c.takenAt || null, escalated: c.escalated, resolvedAt: c.resolvedAt, resolution: c.resolution,
  // #498 - what the owner is asked, in plain words (null until escalated), and Later.
  owner: supCases.caseOwnerView(c, Date.now()), laterUntil: c.laterUntil || null });
/** The dispatch half of GET /api/supervisor/state. */
function dispatchState() {
  casesLoad();
  const dcfg = dispatcherCfg();
  const st = supSettings();
  const cases = Object.values(_disp.state.cases);
  const open = cases.filter((c) => !c.resolvedAt).sort((a, b) => a.openedAt - b.openedAt);
  const closed = cases.filter((c) => c.resolvedAt).sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, 50);
  // #498 - each card says what Approve does, and how its session stands in the last scan.
  const byId = new Map(((_sup.graph && _sup.graph.nodes) || []).map((n) => [n.id, n]));
  const cards = Object.values(_disp.state.cards).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 100)
    .map((k) => supCases.cardView(k, byId.get(k.sessionId) || null));
  const node = _sup.graph ? dispatcherNode(_sup.graph) : null;
  return {
    cases: [...open, ...closed].map(caseView),
    cards,
    dispatcher: { enabled: dcfg.enabled, paused: Boolean(st.paused), id: node ? node.id : null, status: node ? node.status : null,
      capped: Boolean(node && node.capped), startedAt: st.dispatcherStartedAt || null,
      state: supCases.dispatcherBlock({ cfg: dcfg, paused: Boolean(st.paused), node }) || (node ? node.status : 'not running') },
    autonomy: supCases.autonomyRecord(dcfg, _disp.state.cards),
  };
}

/** Make a recommendation card: typed into [n] only when the owner approves it. */
function supCard({ cls, n, text, why, caseId, closeoutAt, spawn, undo }) {
  const card = { id: crypto.randomBytes(4).toString('hex'), cls, sessionId: n.id, server: n.server, name: n.name || null,
    text, why: supCases.oneLine(why, 200), caseId: caseId || null, at: Date.now(),
    // #475: an answer for the owner names how to take it back; Approve's note in the feed carries it.
    ...(undo ? { undo: supCases.oneLine(undo, 160) } : {}),
    // #469: a close card names the clean close-out it closes on (POST /api/sessions/:id/close).
    ...(Number.isInteger(closeoutAt) ? { closeoutAt } : {}),
    // #470: a spawn card names what the replacement is asked with (POST /api/sessions/:id/replace).
    ...(spawn ? { spawn: { note: spawn.note || null, fresh: spawn.fresh === true } } : {}) };
  casesEvent({ event: 'card', card });
  supervisorLog({ event: 'card', cardId: card.id, cls, id: n.id, caseId: card.caseId });
  supervisorNote({ at: card.at, id: n.id, server: n.server, rule: cls, text, outcome: 'card', caseId: card.caseId, undo: card.undo });
  return card;
}

/** #498 - Later for [hours] (absent: the default; 1-24): `{until}`, or `{error}`. */
function supLaterUntil(hours) {
  const { min, max } = supCases.LATER_HOURS;
  const h = hours === undefined ? supCases.LATER_HOURS.default : hours;
  if (!Number.isFinite(h) || h < min || h > max) return { error: `hours must be a number from ${min} to ${max}` };
  return { until: Date.now() + Math.round(h * 60 * 60 * 1000) };
}
/** #498 - where "Tell the supervisor" types the owner's note: `{node}` (the dispatcher's session in
 *  the last scan), or `{block, reason}` when nothing would read it (off, paused, capped, not running). */
function supTellTarget() {
  const node = _sup.graph ? dispatcherNode(_sup.graph) : null;
  const block = supCases.dispatcherBlock({ cfg: dispatcherCfg(), paused: Boolean(supSettings().paused), node }) || (node ? null : 'not running');
  if (!block) return { node };
  const who = { off: 'The supervisor\'s dispatcher is switched off', paused: 'The supervisor is paused',
    capped: 'The supervisor is at its usage limit', 'not running': 'The supervisor is not running right now' }[block] || 'The supervisor cannot take notes now';
  return { block, reason: `${who}, so nothing would read the note. Nothing was sent.` };
}
/** #498 - retire card [k]: it can no longer apply ([reason]: its session is gone or replaced). */
function supRetireCard(k, reason) {
  if (!k || k.decision) return;
  casesEvent({ event: 'retired', cardId: k.id, reason });
  supervisorLog({ event: 'card-retired', cardId: k.id, id: k.sessionId, server: k.server, reason });
}
/** #498 - each scan: retire every pending card whose session is PROVEN gone (lib/supervisor-cases.js
 *  cardRetirements: missing on complete scans orphanConfirmMs apart, its own server answering). */
function supervisorRetireCards(cfg, graph) {
  casesLoad();
  const r = supCases.cardRetirements({ cards: _disp.state.cards, graph, prev: _disp.cardAbsent, confirmMs: cfg.orphanConfirmMs });
  _disp.cardAbsent = r.sightings;
  for (const x of r.retire) supRetireCard(_disp.state.cards[x.cardId], x.reason);
}

/** Every supervisor route below answers only on the authority. */
function supAuthorityOnly(res) {
  if (supervisorAuthority().mode === 'self' && supervisorCfg().enabled) return false;
  res.status(409).json({ error: 'not the supervisor authority' });
  return true;
}

// The dispatcher's verbs that type into a session (scripts/wt-supervise.js wake|coach|answer|lead).
app.post('/api/supervisor/act', express.json({ limit: '16kb' }), async (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  const b = req.body || {};
  const n = supNodeByRef(b.session);
  if (!n) return res.status(404).json({ error: 'no such session in the last scan (an id or a unique 8-character prefix)' });
  if (isDispatcherRow(n)) return res.status(400).json({ error: 'the dispatcher does not prompt itself' });
  const c = b.case ? supCaseById(b.case) : null;
  if (b.case && !c) return res.status(404).json({ error: 'no such case' });
  const dcfg = dispatcherCfg();
  const dec = supCases.verbDecision({ verb: b.verb, text: b.text, undo: b.undo, cfg: dcfg });
  if (dec.error) return res.status(400).json({ error: dec.error });
  if (Buffer.byteLength(dec.text, 'utf8') > supervisorLib.TEXT_BYTES_MAX) {
    return res.status(400).json({ error: `too long: ${Buffer.byteLength(dec.text, 'utf8')} bytes with its lead-in, at most ${supervisorLib.TEXT_BYTES_MAX}` });
  }
  // The dispatcher acting on a case is what TAKES it (supCases.caseDue): a card counts too.
  const take = () => { if (c && !c.takenAt && !c.resolvedAt) casesEvent({ event: 'taken', caseId: c.id, via: b.verb }); };
  if (dec.mode === 'card') {
    const card = supCard({ cls: dec.cls, n, text: dec.text, why: dec.why, caseId: c && c.id,
      undo: dec.cls === 'answer' ? supCases.oneLine(b.undo, 160) : null });
    take();
    return res.json({ delivered: false, card: card.id, why: dec.why });
  }
  const now = Date.now();
  _disp.verbs = _disp.verbs.filter((t) => now - t < 60 * 60 * 1000);
  const mine = (_sup.acts[n.id] || []).filter((t) => now - t < 60 * 60 * 1000);
  if (_disp.verbs.length >= dcfg.actionsPerHour || mine.length >= supervisorCfg().actionsPerHour) {
    return res.status(429).json({ delivered: false, refused: 'budget', why: 'the hourly action budget is spent (per session, or the dispatcher total)' });
  }
  // Reserve the slot BEFORE the await, so two verbs at once cannot both pass the budget;
  // a refused delivery gives it back.
  const acts = (_sup.acts[n.id] = mine);
  _disp.verbs.push(now);
  acts.push(now);
  const d = await supervisorDeliver({ id: n.id, server: n.server, text: dec.text });
  if (!(d.delivered || d.uncertain)) {
    const drop = (arr) => { const i = arr ? arr.lastIndexOf(now) : -1; if (i >= 0) arr.splice(i, 1); };
    drop(_disp.verbs); drop(_sup.acts[n.id]);
    return res.status(409).json({ delivered: false, refused: d.why });
  }
  take();
  const outcome = d.delivered ? 'delivered' : 'uncertain';
  supervisorLog({ event: 'verb', verb: b.verb, cls: dec.cls, id: n.id, server: n.server, caseId: c ? c.id : null, text: dec.text, outcome });
  supervisorNote({ at: now, id: n.id, server: n.server, rule: dec.cls, text: dec.text, outcome, caseId: c && c.id,
    undo: dec.cls === 'answer' ? supCases.oneLine(b.undo, 160) : null });
  res.json({ delivered: Boolean(d.delivered), uncertain: Boolean(d.uncertain) });
});

app.get('/api/supervisor/cases', (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  res.json({ cases: Object.values(_disp.state.cases).filter((c) => !c.resolvedAt).sort((a, b) => a.openedAt - b.openedAt).map(caseView) });
});
app.get('/api/supervisor/cases/:id', (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  const c = supCaseById(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such case' });
  const n = _sup.graph ? _sup.graph.nodes.find((x) => x.id === c.sessionId) || null : null;
  res.json({ case: caseView(c), session: n, actions: _sup.actions.filter((a) => a.id === c.sessionId).slice(-10).reverse(),
    cards: Object.values(_disp.state.cards).filter((k) => k.caseId === c.id) });
});
// The dispatcher closes a case, or puts it in front of the owner (optionally with a card).
app.post('/api/supervisor/cases/:id', express.json({ limit: '16kb' }), async (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  const c = supCaseById(req.params.id);
  if (!c) return res.status(404).json({ error: 'no such case' });
  if (c.resolvedAt) return res.status(409).json({ error: 'the case is already closed' });
  const b = req.body || {};
  const by = (req._wtAuth && req._wtAuth.label) || 'dispatcher';
  if (b.action === 'resolve') {
    const how = supCases.oneLine(b.how, 400);
    if (!how) return res.status(400).json({ error: 'how must say what was done' });
    casesEvent({ event: 'resolved', caseId: c.id, how, by });
    supervisorLog({ event: 'case-resolved', caseId: c.id, id: c.sessionId, how });
    supervisorNote({ at: Date.now(), id: c.sessionId, server: c.server, rule: 'resolve', text: how, outcome: 'resolved', caseId: c.id });
    return res.json({ ok: true });
  }
  if (b.action === 'ask-owner') {
    const question = supCases.oneLine(b.question, 400);
    if (!question) return res.status(400).json({ error: 'question must be one well-formed question' });
    let card = null;
    if (b.propose) {
      const n = supNodeByRef(b.propose.session);
      if (!n) return res.status(404).json({ error: 'propose: no such session in the last scan' });
      // The gated prompt's own rule (lib/safe-prompt.js), so a card can never hold a text
      // that route would refuse when the owner approves it.
      const p = safePrompt.promptOf({ text: b.propose.text });
      if (p.error) return res.status(400).json({ error: `propose: ${p.error}` });
      card = supCard({ cls: 'owner', n, text: b.propose.text.trim(), why: question, caseId: c.id });
    }
    casesEvent({ event: 'escalated', caseId: c.id, question, by, cause: 'asked' });
    supervisorLog({ event: 'case-escalated', caseId: c.id, id: c.sessionId, why: 'dispatcher asked the owner' });
    return res.json({ ok: true, ...(card ? { card: card.id } : {}) });
  }
  // #498 - the owner's answers to an escalated case (the card set): write to the session
  // (the gated deliver, as a card's "Edit, then send"), Later, or tell the supervisor (the
  // case is the dispatcher's again). "Nothing needed" is resolve. Only a case put in front of
  // the owner takes them: the dispatcher acts on its own cases through its own verbs.
  if (['write', 'later', 'tell'].includes(b.action) && !c.escalated) {
    return res.status(409).json({ error: 'the case is not waiting on the owner', reason: 'The supervisor has this case, not you. Nothing was done.' });
  }
  if (b.action === 'write') {
    const p = safePrompt.promptOf({ text: b.text });
    if (p.error) return res.status(400).json({ error: p.error });
    const text = b.text.trim();
    const d = await supervisorDeliver({ id: c.sessionId, server: c.server, text });
    if (!(d.delivered || d.uncertain)) {
      return res.status(409).json({ delivered: false, refused: d.why, reason: supCases.refusalText(d.why, c.server) });
    }
    const outcome = d.delivered ? 'delivered' : 'uncertain';
    casesEvent({ event: 'resolved', caseId: c.id, how: 'the owner wrote to the session', by });
    supervisorLog({ event: 'case-written', caseId: c.id, id: c.sessionId, outcome, bytes: Buffer.byteLength(text, 'utf8') });
    supervisorNote({ at: Date.now(), id: c.sessionId, server: c.server, rule: 'owner', text, outcome, caseId: c.id });
    return res.json({ delivered: Boolean(d.delivered), uncertain: Boolean(d.uncertain) });
  }
  if (b.action === 'later') {
    const { until, error } = supLaterUntil(b.hours);
    if (error) return res.status(400).json({ error });
    casesEvent({ event: 'later', caseId: c.id, until, by });
    supervisorLog({ event: 'case-later', caseId: c.id, id: c.sessionId, until });
    return res.json({ ok: true, laterUntil: until });
  }
  if (b.action === 'tell') {
    if (typeof b.note !== 'string' || !supCases.oneLine(b.note, 1)) return res.status(400).json({ error: 'note must say something' });
    const said = supCases.caseTellText(c, b.note, SUPERVISE_CLI, supervisorLib.TEXT_BYTES_MAX);
    if (said.error) return res.status(400).json({ error: 'note too long', reason: said.error });
    const t = supTellTarget();
    if (t.block) return res.status(409).json({ told: false, refused: t.block, reason: t.reason });
    const d = await supervisorDeliver({ id: t.node.id, server: t.node.server, text: said.text });
    if (!(d.delivered || d.uncertain)) {
      return res.status(409).json({ told: false, refused: d.why, reason: `The supervisor could not take the note now. ${supCases.refusalText(d.why, t.node.server)}` });
    }
    casesEvent({ event: 'handed-back', caseId: c.id, by });
    supervisorLog({ event: 'case-handed-back', caseId: c.id, id: c.sessionId, ...(d.uncertain ? { uncertain: true } : {}) });
    return res.json({ told: Boolean(d.delivered), uncertain: Boolean(d.uncertain) });
  }
  res.status(400).json({ error: 'action must be resolve, ask-owner, write, later or tell' });
});
// The owner decides a recommendation card (#492, #498):
//   approve   do what the card proposes (type, close or replace), through every gate of the
//             session's own server
//   send      Edit, then send: type the owner's own text into that session instead, through
//             the same gated prompt (body: text)
//   tell      Tell the supervisor: type the owner's note into the dispatcher (body: note,
//             dontAsk); the card is the supervisor's again to act on
//   later     hide it for [hours] (1-24, default 3); it comes back only if still pending
//   dismiss   drop it
// A refusal says why in plain words (`reason`, lib/supervisor-cases.js refusalText). One the
// session's own server gives because it has no such session retires the card (#498): it can
// never apply again. Any other refusal keeps it pending, so the owner can try again.
app.post('/api/supervisor/cards/:id', express.json({ limit: '4kb' }), async (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  const k = supCardById(req.params.id);
  if (!k) return res.status(404).json({ error: 'no such card' });
  if (k.decision) {
    const was = { approve: 'approved', dismiss: 'dismissed', send: 'answered with your own text', tell: 'passed to the supervisor',
      retire: `retired (${k.outcome || 'it no longer applies'})` }[k.decision] || k.decision;
    return res.status(409).json({ error: `already ${was}`, reason: `This card was already ${was}.` });
  }
  const b = req.body || {};
  const decision = b.decision;
  const by = (req._wtAuth && req._wtAuth.label) || 'owner';
  const LOG = { approve: 'card-approved', dismiss: 'card-dismissed', send: 'card-sent', tell: 'card-told' };
  const decide = (outcome, extra = {}) => {
    casesEvent({ event: 'decided', cardId: k.id, decision, by, outcome });
    supervisorLog({ event: LOG[decision], cardId: k.id, id: k.sessionId, outcome, ...extra });
  };
  /** A refusal, in plain words; one proving the session gone retires the card. */
  const refused = (d, key) => {
    const retired = Boolean(d.gone);
    if (retired) supRetireCard(k, 'session gone');
    const reason = supCases.refusalText(d.why, k.server) + (retired ? ' The card was retired.' : '');
    return res.status(409).json({ [key]: false, refused: d.why, reason, ...(retired ? { retired: true } : {}) });
  };
  if (decision === 'dismiss') {
    decide('dismissed');
    return res.json({ ok: true });
  }
  if (decision === 'later') {
    const { until, error } = supLaterUntil(b.hours);
    if (error) return res.status(400).json({ error });
    casesEvent({ event: 'later', cardId: k.id, until, by });
    supervisorLog({ event: 'card-later', cardId: k.id, id: k.sessionId, until });
    return res.json({ ok: true, laterUntil: until });
  }
  if (decision === 'send') {
    // The owner's own words, under the gated prompt's own rule (lib/safe-prompt.js).
    const p = safePrompt.promptOf({ text: b.text });
    if (p.error) return res.status(400).json({ error: p.error });
    const text = b.text.trim();
    const d = await supervisorDeliver({ id: k.sessionId, server: k.server, text });
    if (!(d.delivered || d.uncertain)) return refused(d, 'delivered');
    const outcome = d.delivered ? 'delivered' : 'uncertain';
    decide(outcome, { bytes: Buffer.byteLength(text, 'utf8') });
    supervisorNote({ at: Date.now(), id: k.sessionId, server: k.server, rule: 'owner', text, outcome, caseId: k.caseId });
    return res.json({ delivered: Boolean(d.delivered), uncertain: Boolean(d.uncertain) });
  }
  if (decision === 'tell') {
    if (b.dontAsk !== undefined && typeof b.dontAsk !== 'boolean') return res.status(400).json({ error: 'dontAsk must be a boolean' });
    if (b.note !== undefined && typeof b.note !== 'string') return res.status(400).json({ error: 'note must be a string' });
    const said = supCases.tellText(k, b.note || '', b.dontAsk === true);
    if (!said) return res.status(400).json({ error: 'say something: a note, or dontAsk' });
    if (said.error) return res.status(400).json({ error: 'note too long', reason: said.error });
    const text = said.text;
    const t = supTellTarget();
    if (t.block) return res.status(409).json({ told: false, refused: t.block, reason: t.reason });
    const d = await supervisorDeliver({ id: t.node.id, server: t.node.server, text });
    if (!(d.delivered || d.uncertain)) {
      return res.status(409).json({ told: false, refused: d.why, reason: `The supervisor could not take the note now. ${supCases.refusalText(d.why, t.node.server)}` });
    }
    decide(d.delivered ? 'told' : 'uncertain', { dontAsk: b.dontAsk === true });
    // A card the dispatcher proposed with its question (ask-owner): the note names that case
    // (tellText), and it is the dispatcher's again, so the question leaves the owner too.
    const kc = k.caseId ? supCaseById(k.caseId) : null;
    if (kc && !kc.resolvedAt && kc.escalated) {
      casesEvent({ event: 'handed-back', caseId: kc.id, by });
      supervisorLog({ event: 'case-handed-back', caseId: kc.id, id: kc.sessionId, via: 'card', ...(d.uncertain ? { uncertain: true } : {}) });
    }
    return res.json({ told: Boolean(d.delivered), uncertain: Boolean(d.uncertain) });
  }
  if (decision !== 'approve') return res.status(400).json({ error: 'decision must be approve, send, tell, later or dismiss' });
  // #470 - a spawn card replaces (through the session's own server, which re-checks everything).
  if (k.cls === 'spawn') {
    const sp = k.spawn || {};
    const d = await supervisorReplace({ id: k.sessionId, server: k.server, note: sp.note || null, fresh: sp.fresh === true });
    if (!(d.replaced || d.uncertain)) return refused(d, 'replaced');
    const outcome = d.replaced ? 'replaced' : 'uncertain';
    decide(outcome);
    supervisorNote({ at: Date.now(), id: k.sessionId, server: k.server, rule: 'spawn', text: k.text, outcome, caseId: k.caseId });
    return res.json({ replaced: Boolean(d.replaced), uncertain: Boolean(d.uncertain), ...(d.mode ? { mode: d.mode } : {}) });
  }
  // #469 - a close card closes (through the session's own gated close); every other card types.
  if (k.cls === 'close') {
    const c = await supervisorClose({ id: k.sessionId, server: k.server, closeoutAt: k.closeoutAt });
    if (!(c.closed || c.uncertain)) return refused(c, 'closed');
    const outcome = c.closed ? 'closed' : 'uncertain';
    decide(outcome);
    supervisorNote({ at: Date.now(), id: k.sessionId, server: k.server, rule: 'close', text: k.text, outcome, caseId: k.caseId });
    return res.json({ closed: Boolean(c.closed), uncertain: Boolean(c.uncertain) });
  }
  const d = await supervisorDeliver({ id: k.sessionId, server: k.server, text: k.text });
  // Refused: the card stays pending, so the owner can approve it again once the session is
  // free - unless its own server says it has no such session (#498): then it retires.
  if (!(d.delivered || d.uncertain)) return refused(d, 'delivered');
  const outcome = d.delivered ? 'delivered' : 'uncertain';
  decide(outcome);
  supervisorNote({ at: Date.now(), id: k.sessionId, server: k.server, rule: k.cls, text: k.text, outcome, caseId: k.caseId, undo: k.undo });
  res.json({ delivered: Boolean(d.delivered), uncertain: Boolean(d.uncertain) });
});
// The app's live switches: pause the dispatcher; a class of action between act and recommend.
app.post('/api/supervisor/pause', express.json({ limit: '1kb' }), (req, res) => {
  if (supAuthorityOnly(res)) return;
  if (typeof (req.body && req.body.paused) !== 'boolean') return res.status(400).json({ error: 'paused must be a boolean' });
  supSettingsSet({ paused: req.body.paused });
  supervisorLog({ event: req.body.paused ? 'dispatcher-paused' : 'dispatcher-resumed' });
  res.json({ paused: req.body.paused });
});
app.post('/api/supervisor/autonomy', express.json({ limit: '1kb' }), (req, res) => {
  if (supAuthorityOnly(res)) return;
  const b = req.body || {};
  if (!supCases.CLASSES.includes(b.class)) return res.status(400).json({ error: `class must be one of: ${supCases.CLASSES.join(', ')}` });
  if (!['act', 'recommend'].includes(b.mode)) return res.status(400).json({ error: 'mode must be act or recommend' });
  const st = supSettings();
  supSettingsSet({ autonomy: { ...(st.autonomy && typeof st.autonomy === 'object' ? st.autonomy : {}), [b.class]: b.mode } });
  supervisorLog({ event: 'autonomy', class: b.class, mode: b.mode });
  res.json({ class: b.class, mode: b.mode });
});
// The end of a session's transcript, on whichever server holds it (the dispatcher's `tail`).
app.get('/api/supervisor/tail/:id', async (req, res) => {
  if (supAuthorityOnly(res)) return;
  const n = supNodeByRef(req.params.id);
  if (!n) return res.status(404).json({ error: 'no such session in the last scan' });
  const turns = Math.min(40, Math.max(1, Number.parseInt(req.query.turns, 10) || 12));
  let page;
  if (n.server === getServerName()) {
    try { page = await readTranscriptPage(n.id, null, turns); } catch { return res.status(500).json({ error: 'Failed to read transcript' }); }
    if (!page) return res.status(404).json({ error: 'no transcript for session' });
    page = { messages: page.turns };
  } else {
    const peer = getClusterConfig().find((x) => x && x.name === n.server && x.url);
    const tok = peer && (loadClusterTokens()[peer.url] || {}).token;
    if (!tok) return res.status(502).json({ error: `no stored token for ${n.server}` });
    try {
      const r = await clusterFetch(`${peer.url}/api/sessions/${encodeURIComponent(n.id)}/transcript?limit=${turns}`, { headers: { Authorization: `Bearer ${tok}` }, timeout: 15000 });
      if (!r.ok) return res.status(502).json({ error: `${n.server} answered HTTP ${r.status}` });
      page = JSON.parse(r.body);
    } catch { return res.status(502).json({ error: `${n.server} unreachable` }); }
  }
  const clip = (s, k) => (typeof s === 'string' ? (s.length > k ? `${s.slice(0, k)}...` : s) : '');
  res.json({ id: n.id, server: n.server, name: n.name, turns: (Array.isArray(page.messages) ? page.messages : []).map((t) => ({
    role: t.role, ts: t.ts || null, kind: t.userKind || null, text: clip(t.typedText || t.text, 1200),
    tools: Array.isArray(t.toolUses) ? t.toolUses.slice(0, 12).map((u) => ({ name: u && u.name, input: clip(JSON.stringify(u && u.input), 200),
      result: clip(typeof (u && u.result) === 'string' ? u.result : JSON.stringify(u && u.result), 300) })) : [],
  })) });
});

// --- #469 Supervisor phase 4: close-out (R5), close, and the ready-to-close mark -------------
// The rule is lib/closeout.js (closeoutPlan on the authority; askRefusal and closeRefusal on
// the session's own server); this is the I/O. The ask is typed through the gated prompt of the
// session's own server as a TEMPLATE that server fills in (it names its own wt-closeout.js), and
// the close goes through that server's gated close, which re-checks every gate before the kill.
// What cannot close (blocked, unanswered, asked too often) goes to the owner, never forced.
const _co = { plan: null, asks: {}, done: new Set(), refused: {} };
/** config.json `supervisor.closeout`; one minute is the dispatcher's (a WT_TEST seam shortens both). */
function closeoutCfg() {
  const s = liveConfig('supervisor', null);
  return closeoutLib.closeoutConfig(s && typeof s === 'object' ? s.closeout : null, dispatcherCfg().minuteMs);
}
/** The close-outs that need the owner, as owner-ladder items (lib/supervisor.js ownerPlan). */
function closeoutOwnerItems() {
  return ((_co.plan && _co.plan.needs) || []).map((x) => ({ key: x.key, id: x.id, server: x.server, name: x.name,
    what: supCases.oneLine(`Close-out ${x.why === 'blocked' ? 'blocked' : 'not settled'}: ${x.left}`, 100), at: x.at }));
}
/** Close one session through the gated close of its own server. `{closed}`, `{uncertain}` (the
 *  request went out and no answer came), or `{why}`. */
async function supervisorClose(x) {
  if (!Number.isInteger(x.closeoutAt)) return { why: 'no-closeout' };
  if (x.server === getServerName()) {
    const out = await gatedClose(x.id, x.closeoutAt, 'supervisor');
    return out.json && out.json.closed ? { closed: true } : supRefusal(out.status, out.json);
  }
  const r = await supervisorPeerPost(x.server, `/api/sessions/${encodeURIComponent(x.id)}/close`, { closeoutAt: x.closeoutAt });
  if (r.why || r.uncertain) return r;
  if (r.ok && r.json.closed) return { closed: true };
  return supRefusal(r.status, r.json);
}
/** POST [body] to [route] on cluster peer [server] with its stored token: `{ok, status, json}`,
 *  `{why}` (no such server, no token, unreachable), or `{uncertain: true}` (sent, no answer). */
async function supervisorPeerPost(server, route, body, timeout = 20000) {
  const peer = getClusterConfig().find((p) => p && p.name === server && p.url);
  if (!peer) return { why: 'no-such-server' };
  const tok = (loadClusterTokens()[peer.url] || {}).token;
  if (!tok) return { why: 'no stored token' };
  try {
    const r = await clusterFetch(`${peer.url}${route}`, {
      method: 'POST', headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), timeout });
    let j = {};
    try { j = JSON.parse(r.body); } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, json: j && typeof j === 'object' ? j : {} };
  } catch (e) {
    if (e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH')) return { why: 'unreachable' };
    return { uncertain: true };
  }
}
/** A close the supervisor decided: a card while `close` is in recommend mode, else the close. */
async function closeoutClose(c, n, by) {
  const dcfg = dispatcherCfg();
  if (dcfg.autonomy.close === 'recommend') {
    const had = Object.values(_disp.state.cards).some((k) => k.cls === 'close' && k.sessionId === c.id && k.closeoutAt === c.closeoutAt);
    if (!had) supCard({ cls: 'close', n, text: `Close "${supCases.oneLine(n.name || n.id.slice(0, 8), 60)}": done, and its close-out is clean`, why: supCases.recommendWhy('close'), closeoutAt: c.closeoutAt });
    return { card: true };
  }
  const d = await supervisorClose(c);
  if (d.closed || d.uncertain) {
    _co.done.add(c.key);
    supervisorLog({ event: 'closeout-close', key: c.key, id: c.id, server: c.server, by, ...(d.uncertain ? { uncertain: true } : {}) });
    supervisorNote({ at: Date.now(), id: c.id, server: c.server, rule: 'R5', text: 'closed: done, close-out clean', outcome: d.closed ? 'closed' : 'uncertain' });
  } else if (_co.refused[c.key] !== d.why) {
    _co.refused[c.key] = d.why;
    supervisorLog({ event: 'closeout-close-refused', key: c.key, id: c.id, server: c.server, why: d.why });
  }
  return d;
}

async function supervisorCloseout(cfg, graph) {
  const ccfg = closeoutCfg();
  const now = Date.now();
  for (const [id, ts] of Object.entries(_co.asks)) {
    const keep = ts.filter((t) => now - t < 24 * 60 * 60 * 1000);
    if (keep.length) _co.asks[id] = keep; else delete _co.asks[id];
  }
  const skip = new Set([supSettings().dispatcherId].filter(Boolean));
  const plan = closeoutLib.closeoutPlan({ graph, asks: _co.asks, skip, now, cfg: ccfg });
  _co.plan = plan;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // What goes to the owner is logged and shown once per close-out.
  for (const x of plan.needs) {
    if (_co.done.has(x.key)) continue;
    _co.done.add(x.key);
    supervisorLog({ event: 'closeout-needs', key: x.key, id: x.id, server: x.server, why: x.why, left: x.left });
    supervisorNote({ at: now, id: x.id, server: x.server, rule: 'R5', text: `close-out ${x.why}: ${x.left}`, outcome: 'needs-you' });
  }
  const planned = new Set();
  for (const a of plan.ask) {
    planned.add(a.key);
    if (_co.done.has(a.key)) continue;
    // The supervisor's per-session hourly budget covers the ask like every prompt it types.
    if (((_sup.acts[a.id] || []).filter((t) => now - t < 60 * 60 * 1000)).length >= cfg.actionsPerHour) continue;
    const d = await supervisorDeliver({ id: a.id, server: a.server, template: 'closeout', expectWaitAt: a.expectWaitAt });
    if (d.delivered || d.uncertain) {
      _co.done.add(a.key);
      (_co.asks[a.id] = _co.asks[a.id] || []).push(now);
      (_sup.acts[a.id] = _sup.acts[a.id] || []).push(now);
      supervisorLog({ event: 'closeout-ask', key: a.key, id: a.id, server: a.server, ...(d.uncertain ? { uncertain: true } : {}) });
      supervisorNote({ at: now, id: a.id, server: a.server, rule: 'R5', text: 'asked to close out', outcome: d.delivered ? 'delivered' : 'uncertain' });
    } else if (_co.refused[a.key] !== d.why) {
      _co.refused[a.key] = d.why;
      supervisorLog({ event: 'closeout-ask-refused', key: a.key, id: a.id, server: a.server, why: d.why });
    }
  }
  for (const c of plan.close) {
    planned.add(c.key);
    if (_co.done.has(c.key)) continue;
    await closeoutClose(c, byId.get(c.id), 'rules');
  }
  for (const k of Object.keys(_co.refused)) if (!planned.has(k)) delete _co.refused[k];
}

// The dispatcher's `close` verb (scripts/wt-supervise.js close <session>): only a session an
// agent opened, after its clean close-out, with no live child - the same gates as R5, then the
// session's own gated close. The owner's sessions are never closed by the supervisor.
app.post('/api/supervisor/close', express.json({ limit: '4kb' }), async (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  const b = req.body || {};
  const n = supNodeByRef(b.session);
  if (!n) return res.status(404).json({ error: 'no such session in the last scan (an id or a unique 8-character prefix)' });
  const c = b.case ? supCaseById(b.case) : null;
  if (b.case && !c) return res.status(404).json({ error: 'no such case' });
  if (isDispatcherRow(n)) return res.status(400).json({ error: 'the dispatcher does not close itself' });
  if (!closeoutLib.closable(n)) return res.status(409).json({ closed: false, refused: 'owner', why: "the owner's session is never closed by the supervisor: it is marked ready to close" });
  if (!(n.closeout && n.closeout.state === 'clean')) return res.status(409).json({ closed: false, refused: 'not-clean', why: 'no clean close-out: it closes only after one' });
  // R5's own plan for this one session decides (lib/closeout.js dispatcherClose).
  const now = Date.now();
  const v = closeoutLib.dispatcherClose(n, { complete: Boolean(_sup.graph && _sup.graph.complete), now, cfg: closeoutCfg(), peers: _sup.graph ? _sup.graph.nodes : null });
  if (!v.close) return res.status(409).json({ closed: false, refused: v.why, why: 'R5 would not close it now' });
  const p = v.close;
  // The dispatcher's hourly verb budget covers a close like every other verb.
  const dcfg = dispatcherCfg();
  _disp.verbs = _disp.verbs.filter((t) => now - t < 60 * 60 * 1000);
  if (_disp.verbs.length >= dcfg.actionsPerHour) return res.status(429).json({ closed: false, refused: 'budget', why: 'the hourly action budget is spent' });
  _disp.verbs.push(now);
  const d = await closeoutClose(p, n, 'dispatcher');
  if (!(d.closed || d.uncertain || d.card)) { const i = _disp.verbs.lastIndexOf(now); if (i >= 0) _disp.verbs.splice(i, 1); }
  if (c && !c.takenAt && !c.resolvedAt && (d.closed || d.uncertain || d.card)) casesEvent({ event: 'taken', caseId: c.id, via: 'close' });
  if (d.card) return res.json({ closed: false, card: true, why: 'close is in recommend mode' });
  if (!(d.closed || d.uncertain)) return res.status(409).json({ closed: false, refused: d.why });
  res.json({ closed: Boolean(d.closed), uncertain: Boolean(d.uncertain) });
});

// --- #470 Supervisor phase 5: replacement sessions (section 8, R7, R8) ----------------------
// The rules are lib/replacement.js; this is the I/O. A replacement is made by the session's OWN
// server, re-checked there right before it acts (the authority's scan is up to a minute old).
// Both ways run the #340 hand-off run, so the successor is created, proven up and the old
// session closed by the code that already does that, and every failure leaves the old session
// where it was:
//   handoff  the agent runs: the supervisor starts a forced hand-off; the agent writes its brief
//   dead     the agent died (R7): the server writes the brief and starts the run at `spawning`
/** config.json `supervisor.spawn` on THIS server (R8's floor is per machine). */
function spawnCfg() {
  const s = liveConfig('supervisor', null);
  return replacementLib.spawnConfig(s && typeof s === 'object' ? s.spawn : null);
}
/** The last [bytes] of [file] as text, or null when it cannot be read. */
function readFileTail(file, bytes) {
  if (!file) return null;
  let fd;
  try {
    const size = fs.statSync(file).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}
async function replaceSession(id, { note = null, fresh = false, by = null } = {}) {
  const refuse = (why, extra) => {
    supervisorLog({ event: 'replace-refused', id, why, by });
    return { status: 409, json: { replaced: false, refused: why, ...(extra || {}) } };
  };
  if (_gatedPromptBusy.has(id)) return refuse('busy');
  _gatedPromptBusy.add(id);
  try {
    const { sessions } = await workerClient.rpc('listSessions');
    if (!sessions.some((x) => x.id === id)) return { status: 404, json: { error: 'session not found' } };
    const cur = await workerClient.rpc('getSession', { id });
    const agent = sessionAgentState(cur);
    const gone = agent.gone;
    const entry = getBriefEntry(id) || {};
    const last = entry.handoff || null;
    // Already handed off: its last run ended kept or failed (nobody typed since), or a successor
    // it made still runs. A second replacement would make a second successor for one job.
    const handedOff = checkInLib.handoffBlock(entry) === 'handed-off'
      || Boolean(last && last.successorId && sessions.some((x) => x.id === last.successorId));
    const m = replacementLib.replaceMode({ agent, hold: Boolean(_maint.hold), handoffActive: handoffLib.isActive(entry.handoff),
      handedOff, declined: handoffLib.declinedStanding(entry),
      typing: checkInLib.typedRecently(_lastInputAt.get(id), CHECKIN_STARTED_AT, Date.now(), checkInCfg().typingQuietMin),
      dispatcher: isDispatcherSession(id) });
    if (m.why) return refuse(m.why);
    // R8 - a replacement is a new session on this machine.
    const osPart = await machineProfile.readOsPart().catch(() => null);
    const cap = replacementLib.capacityRefusal({ sessions: countedSessions(sessions).length, cap: SESSIONS_SOFT_LIMIT,
      commitAvailBytes: osPart && osPart.commit ? osPart.commit.availBytes : null, floorBytes: spawnCfg().commitFloorBytes });
    if (cap) return refuse(cap);
    if (m.mode === 'handoff') {
      const r = startHandoff(id, await handoffRowFor(id, sessions), { force: true, trigger: 'supervisor' });
      if (!r.run) return refuse(r.why || 'handoff', { error: r.error });
      supervisorLog({ event: 'replace', id, mode: 'handoff', by });
      return { status: 200, json: { replaced: true, mode: 'handoff', handoff: handoffLib.publicRun(r.run) } };
    }
    // Dead: the supervisor writes the brief. The slow reads first...
    const tpath = await resolveSessionTranscriptPath(id).catch(() => null);
    // Resumed only when the transcript read IS that conversation's: a path resolved to another
    // file would put the successor on someone else's history.
    const resumable = !fresh && Boolean(cur.claudeSessionId) && Boolean(tpath)
      && agentsLib.conversationIdFromPath(cur.agent, tpath) === cur.claudeSessionId
      && replacementLib.transcriptSound(readFileTail(tpath, 1024 * 1024));
    let tail = [];
    try {
      const page = await readTranscriptPage(id, null, 8);
      tail = page ? page.turns.map((t) => ({ role: t.role, text: t.typedText || t.text || '' })) : [];
    } catch { /* no tail: the brief says what the report says */ }
    const now = Date.now();
    const e = getBriefEntry(id) || {};
    const text = replacementLib.briefText({ old: { id, name: cur.name, cwd: cur.cwd, conversationId: cur.claudeSessionId || null },
      reported: e.reported, touches: e.touches, goal: (spawnStore.field(id) || {}).goal || null, tail, gone, note, resumed: resumable, now });
    // The successor's first prompt must fit (either way: the resume can still fall back to fresh)
    // before anything starts, or the run would fail only after the brief and the spawn.
    const briefFile = path.join(HANDOFF_DIR, handoffLib.briefFileName(id));
    if ([true, false].some((resumed) => !replacementLib.replacementPrompt({ briefFile, oldName: cur.name, resumed }))) return refuse('prompt-too-long');
    // ...then the last look, with nothing awaited from here to the run: no run started meanwhile.
    if (handoffLib.isActive((getBriefEntry(id) || {}).handoff)) return refuse('in-progress');
    fs.mkdirSync(HANDOFF_DIR, { recursive: true });
    pruneHandoffBriefs();
    fs.writeFileSync(briefFile, text);
    const run = { ...handoffLib.startRun(now, briefFile, 'supervisor'), state: 'spawning', at: now,
      verdict: { canClose: true, why: 'its agent died; the supervisor wrote the brief' }, verdictAt: now,
      dead: true, resumeId: resumable ? cur.claudeSessionId : null };
    setHandoffRun(id, run);
    logHandoff('started', id, run, { by });
    supervisorLog({ event: 'replace', id, mode: 'dead', resumes: resumable, by });
    advanceHandoff(id);
    return { status: 200, json: { replaced: true, mode: 'dead', resumes: resumable } };
  } catch (err) {
    if (/not found/i.test(err.message)) return { status: 404, json: { error: 'session not found' } };
    console.error(`replace failed: ${err.message}`);
    return { status: 500, json: { error: 'Failed to replace session' } };
  } finally { _gatedPromptBusy.delete(id); }
}
// Every server: replace one of its sessions (the supervisor calls it on the session's server).
app.post('/api/sessions/:id/replace', express.json({ limit: '4kb' }), async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  const b = req.body || {};
  const v = replacementLib.noteOf(b.note);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (b.fresh !== undefined && typeof b.fresh !== 'boolean') return res.status(400).json({ error: 'fresh must be a boolean' });
  const out = await replaceSession(id, { note: v.note, fresh: b.fresh === true, by: (req._wtAuth && req._wtAuth.label) || null });
  res.status(out.status).json(out.json);
});
/** Replace one session through its own server. `{replaced, mode}`, `{uncertain}`, or `{why}`. */
async function supervisorReplace(x) {
  if (x.server === getServerName()) {
    const out = await replaceSession(x.id, { note: x.note || null, fresh: x.fresh === true, by: 'supervisor' });
    return out.json && out.json.replaced ? { replaced: true, mode: out.json.mode } : supRefusal(out.status, out.json);
  }
  const r = await supervisorPeerPost(x.server, `/api/sessions/${encodeURIComponent(x.id)}/replace`,
    { ...(x.note ? { note: x.note } : {}), ...(x.fresh ? { fresh: true } : {}) }, 30000);
  if (r.why || r.uncertain) return r;
  if (r.ok && r.json.replaced) return { replaced: true, mode: r.json.mode };
  return supRefusal(r.status, r.json);
}
// The dispatcher's `spawn` verb (scripts/wt-supervise.js spawn <session>): class `spawn` - it can
// be undone (the old transcript stays on disk), so it acts unless the owner set it to recommend.
// A note asking for something only the owner decides makes it a card whatever the class.
app.post('/api/supervisor/spawn', express.json({ limit: '8kb' }), async (req, res) => {
  if (supAuthorityOnly(res)) return;
  casesLoad();
  const b = req.body || {};
  const n = supNodeByRef(b.session);
  if (!n) return res.status(404).json({ error: 'no such session in the last scan (an id or a unique 8-character prefix)' });
  if (isDispatcherRow(n)) return res.status(400).json({ error: 'the dispatcher is not replaced this way: the server restarts it' });
  const c = b.case ? supCaseById(b.case) : null;
  if (b.case && !c) return res.status(404).json({ error: 'no such case' });
  const v = replacementLib.noteOf(b.note);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (b.fresh !== undefined && typeof b.fresh !== 'boolean') return res.status(400).json({ error: 'fresh must be a boolean' });
  const fresh = b.fresh === true;
  const take = () => { if (c && !c.takenAt && !c.resolvedAt) casesEvent({ event: 'taken', caseId: c.id, via: 'spawn' }); };
  const dcfg = dispatcherCfg();
  const reserved = supCases.reservedWhy(v.note, 'the note');
  if (reserved || dcfg.autonomy.spawn === 'recommend') {
    const why = reserved || supCases.recommendWhy('spawn');
    const text = supCases.oneLine(`Replace "${supCases.oneLine(n.name || n.id.slice(0, 8), 60)}"${fresh ? ' (fresh)' : ''}${v.note ? `: ${v.note}` : ''}`, 300);
    const card = supCard({ cls: 'spawn', n, text, why, caseId: c && c.id, spawn: { note: v.note, fresh } });
    take();
    return res.json({ replaced: false, card: card.id, why });
  }
  const now = Date.now();
  _disp.verbs = _disp.verbs.filter((t) => now - t < 60 * 60 * 1000);
  const mine = (_sup.acts[n.id] || []).filter((t) => now - t < 60 * 60 * 1000);
  if (_disp.verbs.length >= dcfg.actionsPerHour || mine.length >= supervisorCfg().actionsPerHour) {
    return res.status(429).json({ replaced: false, refused: 'budget', why: 'the hourly action budget is spent (per session, or the dispatcher total)' });
  }
  // Reserved before the await, so two verbs at once cannot both pass; a refusal gives it back.
  const acts = (_sup.acts[n.id] = mine);
  _disp.verbs.push(now);
  acts.push(now);
  const d = await supervisorReplace({ id: n.id, server: n.server, note: v.note, fresh });
  if (!(d.replaced || d.uncertain)) {
    const drop = (arr) => { const i = arr ? arr.lastIndexOf(now) : -1; if (i >= 0) arr.splice(i, 1); };
    drop(_disp.verbs); drop(_sup.acts[n.id]);
    return res.status(409).json({ replaced: false, refused: d.why });
  }
  take();
  const outcome = d.replaced ? 'replaced' : 'uncertain';
  supervisorLog({ event: 'verb', verb: 'spawn', cls: 'spawn', id: n.id, server: n.server, caseId: c ? c.id : null, mode: d.mode || null, fresh, outcome });
  supervisorNote({ at: now, id: n.id, server: n.server, rule: 'spawn', text: `replaced (${d.mode || 'sent'})${v.note ? `: ${v.note}` : ''}`, outcome, caseId: c && c.id });
  res.json({ replaced: Boolean(d.replaced), uncertain: Boolean(d.uncertain), ...(d.mode ? { mode: d.mode } : {}) });
});

if (process.env.WT_TEST === '1') {
  // Test-only (#467): pin quiet hours on or off while WT_QUIET_FORCE is set. Behind auth.
  app.post('/api/test/quiet', express.json(), (req, res) => {
    _quietForced = Boolean(req.body && req.body.quiet);
    res.json({ quiet: _quietForced });
  });
  // Test-only (#470): what the process snapshot says about a session's agent - true (running
  // under its PTY), false (not there), null (back to the real snapshot). Behind auth.
  app.post('/api/test/agent-process', express.json(), (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const found = req.body && req.body.found;
    if (found === null) _agentFoundForTests.delete(id); else _agentFoundForTests.set(id, found === true);
    res.json({ ok: true });
  });
}

const _supervisorTicker = setInterval(() => { supervisorScan(); }, 2000);
if (_supervisorTicker.unref) _supervisorTicker.unref();

app.get('/api/supervisor/state', (req, res) => {
  const cfg = supervisorCfg();
  const a = supervisorAuthority();
  if (a.mode !== 'self') {
    // The companion asks the authority; a server that is not it says where it is.
    return res.json({ role: a.mode === 'remote' ? 'peer' : 'none', authority: a.mode === 'remote' ? { name: a.name } : null, enabled: cfg.enabled });
  }
  if (!cfg.enabled) return res.json({ role: 'authority', enabled: false });
  res.json({ enabled: true, ...supervisorLib.stateOf({ graph: _sup.graph, verdicts: _sup.verdicts,
    journal: journalLib.foldJournal(_sup.journal), cfg, now: Date.now(),
    resolutions: _sup.resolutions, actions: _sup.actions, quiet: quietNow(), dispatch: dispatchState(), closeout: _co.plan }) });
});
app.delete('/api/leases/:id', leaseJson, leaseBroker.routes.release);
app.get('/api/admission', leaseBroker.routes.admission);
if (process.env.WT_TEST) {
  // One sweep now (expiry, liveness, cleanup) instead of waiting out the 60 s timer.
  app.post('/api/test/leases-sweep', async (req, res) => {
    try { await leaseBroker.sweepAll(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
leaseBroker.start();

// --- API: this machine's Claude login (#389) ---
// Per machine on purpose: each machine keeps its own saved copy of each account (refresh
// tokens rotate), so the companion asks each server separately and nothing here fans out.
// No response ever carries a token - lib/claude-account.js returns who and until when.
// Under WT_TEST the suite MUST redirect the home (WT_CLAUDE_ACCOUNT_HOME, set by
// playwright.config.js): a test that fell through to transcriptHome() would switch the
// real login of the machine running it, so that case is refused instead.
function claudeAccountHome() {
  if (process.env.WT_CLAUDE_ACCOUNT_HOME) return process.env.WT_CLAUDE_ACCOUNT_HOME;
  if (process.env.WT_TEST) throw new claudeAccount.Refusal('WT_CLAUDE_ACCOUNT_HOME is not set under WT_TEST');
  return transcriptHome();
}
function claudeAccountError(res, e) {
  if (e instanceof claudeAccount.Refusal) return res.status(409).json({ error: e.message });
  console.error(`[claude-account] ${e.message}`);
  res.status(500).json({ error: e.message });
}
app.get('/api/claude-account', (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(claudeAccount.status(claudeAccountHome())); } catch (e) { claudeAccountError(res, e); }
});
app.post('/api/claude-account/switch', express.json({ limit: '4kb' }), (req, res) => {
  const target = req.body?.account;
  if (typeof target !== 'string' || !target) return res.status(400).json({ error: 'account (a saved label or email) is required' });
  try {
    const home = claudeAccountHome();
    // #490 - whose login this was, so its windows are filed as old only when it is the one recorded.
    let before = null;
    try { before = autoSwitchLib.identity(claudeAccount.status(home).active); } catch { /* unknown: no windows */ }
    const result = claudeAccount.switchTo(target, home);
    console.log(`[claude-account] ${result.alreadyActive ? 'already on' : 'switched to'} ${result.label}${result.warning ? ` - WARNING: ${result.warning}` : ''}`);
    const status = claudeAccount.status(home);
    if (!result.alreadyActive) noteAccountSwitched(status, Date.now(), { from: before }); // #483: older readings are the old account's
    clearAutoSwitchHold(); // #483: a person switched by hand, which is what a warning hold waits for
    res.json({ ...result, status });
  } catch (e) { claudeAccountError(res, e); }
});
app.post('/api/claude-account/save', express.json({ limit: '4kb' }), (req, res) => {
  const label = req.body?.label;
  if (label !== undefined && label !== null && typeof label !== 'string') return res.status(400).json({ error: 'label must be a string' });
  try {
    const home = claudeAccountHome();
    const result = claudeAccount.save(label || null, home);
    res.json({ ...result, status: claudeAccount.status(home) });
  } catch (e) { claudeAccountError(res, e); }
});

// --- #483: switch this machine's Claude account when its weekly limit is hit ---
// lib/account-autoswitch.js owns every rule (whose reading counts, which account is next,
// the cooldown, the notice); this is the I/O. Opt-in per machine, read live:
//   config.json "claudeAccountAutoSwitch": { "enabled": true, "cooldownMinutes": 30,
//                                           "ntfy": { "topic": "...", "server": "..." } }
// The state (when the login last changed, which accounts are known to be capped, the last
// attempt) is persisted so a hot reload keeps the cooldown. It holds labels and times only,
// never a token. Under WT_TEST it lives in memory unless a spec names a file.
const ACCOUNT_SWITCH_FILE = process.env.WT_ACCOUNT_SWITCH_FILE ||
  (process.env.WT_TEST ? null : path.join(__dirname, 'account-autoswitch.json'));
function loadAutoSwitchState() {
  if (!ACCOUNT_SWITCH_FILE) return {};
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNT_SWITCH_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
let _autoSwitch = loadAutoSwitchState();
function saveAutoSwitchState() {
  if (!ACCOUNT_SWITCH_FILE) return;
  try {
    const tmp = `${ACCOUNT_SWITCH_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(_autoSwitch, null, 2));
    fs.renameSync(tmp, ACCOUNT_SWITCH_FILE);
  } catch (e) { console.error(`[account-autoswitch] state save failed: ${e.message}`); }
}
// agent session id -> its weekly reading (autoSwitchLib.noteReading). The readings a switch
// still waits on (a cooldown, the #359 restart hold) are also kept in the state file
// (autoSwitchLib.pendingReadings): a capped session makes no new API calls, so the restart
// the hold leads to would otherwise lose the only evidence. The rest is memory only.
const _weeklyReadings = new Map();
{
  const pending = _autoSwitch.pending;
  if (pending && typeof pending === 'object' && !Array.isArray(pending)) {
    for (const [sid, r] of Object.entries(pending)) if (r && typeof r === 'object') _weeklyReadings.set(sid, r);
  }
}
let _autoSwitchBusy = false;
let _autoSwitchLastBlock = null;

function autoSwitchNoteReport(sid, parsed, cost, now) {
  const prev = _weeklyReadings.get(sid) || null;
  _weeklyReadings.delete(sid); // re-inserted last, so the oldest is evicted first
  _weeklyReadings.set(sid, autoSwitchLib.noteReading(prev, {
    sevenD: parsed.sevenD, sevenDResetAt: parsed.sevenDResetAt, apiMs: cost && cost.total_api_duration_ms, at: now,
  }));
  if (_weeklyReadings.size > 200) _weeklyReadings.delete(_weeklyReadings.keys().next().value);
  persistPendingReadings(now);
}

// Written only when the EVIDENCE changes (a reading's `fresh`), never on a redraw: a status
// line reports every few seconds. A machine with the feature off writes nothing.
function persistPendingReadings(now) {
  const cfg = autoSwitchLib.autoSwitchConfig(liveConfig('claudeAccountAutoSwitch', null));
  if (!cfg.enabled) return;
  const pending = autoSwitchLib.pendingReadings(_weeklyReadings.entries(), _autoSwitch.switchedAt, now, autoSwitchOpts(cfg));
  const evidence = (p) => JSON.stringify(Object.keys(p || {}).sort().map((k) => [k, p[k] && p[k].fresh]));
  if (evidence(pending) === evidence(_autoSwitch.pending)) return;
  _autoSwitch = { ..._autoSwitch, pending };
  saveAutoSwitchState();
}

/** A switch by hand ends the hold an automatic switch's warning left (autoSwitchLib.heldBy). */
function clearAutoSwitchHold() {
  if (!_autoSwitch.held) return;
  console.log('[account-autoswitch] switched by hand: automatic switching is no longer held');
  _autoSwitch = { ..._autoSwitch, held: null };
  saveAutoSwitchState();
}

/** The switch point and the old account's windows, as every autoSwitchLib.weeklySpent call takes them (#490). */
function autoSwitchOpts(cfg) {
  return { atPct: cfg.atPct, oldWindows: _autoSwitch.oldWindows };
}

/**
 * The login changed (by hand or automatically): every reading before now is the old account's,
 * and so is any later reading that names one of the old account's windows (#490: a running
 * session keeps reporting the old account's rate limits for a while after the swap).
 *
 * The windows are taken only when the outgoing login is the one this server recorded (`from`
 * is its identity): then the readings since the last switch are provably that account's. A
 * login changed outside this server files none (they may be the new account's own); the
 * first record of a login (`keepWindows`, the seed) keeps those already filed.
 */
function noteAccountSwitched(status, now, { auto = false, from = null, keepWindows = false } = {}) {
  let oldWindows = [];
  if (from && from === _autoSwitch.activeKey) {
    oldWindows = autoSwitchLib.windowsOf(_weeklyReadings.values(), _autoSwitch.switchedAt, now, _autoSwitch.oldWindows);
  } else if (keepWindows && Array.isArray(_autoSwitch.oldWindows)) {
    oldWindows = _autoSwitch.oldWindows;
  }
  _autoSwitch = { ..._autoSwitch, switchedAt: now, activeKey: autoSwitchLib.identity(status && status.active), pending: {}, oldWindows };
  if (auto) _autoSwitch.resumeFrom = now;
  saveAutoSwitchState();
}

/**
 * Arm a Claude session's resume from its pushed metrics, except that while it waits after
 * an automatic switch it resumes on the switch (autoSwitchLib.resumeResetAt). When the
 * metrics themselves are SILENT (aged past the TTL) only the reset is pushed: deriving a
 * capBlocked from silence would tell the worker "not blocked" (#69: silence is not recovery).
 */
function armWithAutoSwitchResume(s, m) {
  const id = s.id;
  const r = autoSwitchLib.resumeResetAt({
    resumeFrom: _autoSwitch.resumeFrom, resumeUntil: _autoSwitch.resumeUntil, readingAt: m.ts, resetAt: m.fiveHResetAt, now: Date.now(),
  });
  if (r === m.fiveHResetAt) return armResetTimerFromMetrics(id, m);
  // Stopped by its WEEK (its 5-hour window not spent): the 5-hour rule armResetTimerFromMetrics
  // applies would say "not blocked", and the worker never arms. Say the block it had.
  if (autoSwitchLib.weeklyBlockedAtSwitch({
    sevenD: m.sevenD, reading: _weeklyReadings.get(s.claudeSessionId), resumeFrom: _autoSwitch.resumeFrom,
    now: Date.now(), delayMs: usageLimit.autoResumeDelayMs(process.env),
  })) {
    return _pushResetState(id, { fiveHResetAt: r, capBlocked: true, enabled: getAutoResumeEnabled(id) });
  }
  if (!_metricsSpeakAboutWindow(m)) return _pushResetState(id, { fiveHResetAt: r, enabled: getAutoResumeEnabled(id) });
  return armResetTimerFromMetrics(id, { ...m, fiveHResetAt: r });
}

function autoSwitchNotice(cfg, kind, fields) {
  const msg = autoSwitchLib.notice(kind, { server: getServerName(), ...fields });
  console.log(`[account-autoswitch] ${msg.title}: ${msg.message}`);
  postNtfy(cfg.ntfy, msg, { kind: `account-${kind}`, topic: cfg.ntfy ? cfg.ntfy.topic : null, ...msg })
    .catch((e) => console.error(`[account-autoswitch] notice failed: ${e.message}`));
}

// Hand every session on this machine's Claude login the switch as its reset, so one that
// is parked on the cap resumes through the worker's own auto-resume (#69: its gates - the
// session must be cap-blocked, idle, ready, not worked since - all still apply). The
// status-push agent is the one that runs on this login.
async function resumeAfterAutoSwitch() {
  const { sessions } = await workerClient.rpc('listSessions');
  for (const s of sessions || []) {
    if (!s || s.agent !== STATUS_PUSH_AGENT) continue;
    // No pushed metrics (pruned, or never pushed) reads as silent metrics: the switch is
    // pushed as the reset, with the block when the session's own weekly reading says so.
    armWithAutoSwitchResume(s, getStatusMetrics(s.claudeSessionId) || {});
  }
}

function considerAutoSwitch(now = Date.now()) {
  if (_autoSwitchBusy) return; // never mid-switch
  const cfg = autoSwitchLib.autoSwitchConfig(liveConfig('claudeAccountAutoSwitch', null));
  if (!cfg.enabled) return;
  const spent = autoSwitchLib.weeklySpent(_weeklyReadings.values(), _autoSwitch.switchedAt, now, autoSwitchOpts(cfg));
  if (!spent) { _autoSwitchLastBlock = null; return; }
  const block = autoSwitchLib.blockedBy({ cfg, state: _autoSwitch, now, holdActive: !!_maint.hold });
  if (block) {
    if (block !== _autoSwitchLastBlock) console.log(`[account-autoswitch] weekly usage at ${spent.pct}% (switch point ${cfg.atPct}%); not switching now (${block})`);
    _autoSwitchLastBlock = block;
    return;
  }
  _autoSwitchLastBlock = null;
  _autoSwitchBusy = true;
  try { runAutoSwitch(cfg, spent, now); } finally { _autoSwitchBusy = false; }
}

function runAutoSwitch(cfg, spent, now) {
  let home, st;
  try {
    home = claudeAccountHome();
    st = claudeAccount.status(home);
  } catch (e) {
    autoSwitchFailed(cfg, now, null, 'the next account', e);
    return;
  }
  if (!st.active) return; // logged out: nothing is running on this login to be capped
  const key = autoSwitchLib.identity(st.active);
  if (_autoSwitch.activeKey !== key) {
    // The login changed outside this server (the CLI, a /login), or this server has no
    // record of whose login it was: the readings so far may be another account's. Start
    // again from here; the next fresh response decides.
    console.log('[account-autoswitch] the login is not the one last recorded; waiting for a reading taken on it');
    noteAccountSwitched(st, now);
    return;
  }
  const from = st.active.label || st.active.email;
  // A weekly window is at most 7 days, so an unknown reset is capped for no longer.
  const until = spent.resetAt || now + 7 * 24 * 60 * 60 * 1000;
  const capped = autoSwitchLib.pruneCapped(_autoSwitch.capped, now);
  if (st.active.label) capped[st.active.label] = until;
  const { next, earliest } = autoSwitchLib.pickNext({ saved: st.saved, activeLabel: st.active.label, capped, now });
  _autoSwitch = { ..._autoSwitch, capped, attemptAt: now, activeKey: key };
  if (!next) {
    // ONE notice per stretch with nothing to switch to: repeated only once its reset has passed.
    const notify = !(_autoSwitch.allCappedUntil > now);
    if (notify) _autoSwitch.allCappedUntil = (earliest && earliest.resetAt) || until;
    saveAutoSwitchState();
    if (notify) autoSwitchNotice(cfg, 'all-capped', { from, resetAt: spent.resetAt, pct: spent.pct, earliest });
    return;
  }
  let result;
  try {
    result = claudeAccount.switchTo(next, home);
  } catch (e) {
    autoSwitchFailed(cfg, now, from, next, e);
    return;
  }
  if (!st.active.label && result.fromLabel) capped[result.fromLabel] = until; // saved just now, by the switch
  // A warning (lib/claude-account.js switchTo: the stored token is not the one written) may
  // mean the files now name two accounts; another automatic switch would then save one
  // account's tokens under the other's name. It holds them until a switch by hand.
  const held = autoSwitchLib.heldBy(result.warning, now);
  _autoSwitch = { ..._autoSwitch, allCappedUntil: null, failures: 0, failNotice: null, resumeUntil: until, held };
  let after = null;
  // Unreadable now: the switch is done, and an unknown identity skips the outside-change check once.
  try { after = claudeAccount.status(home); } catch { /* left null */ }
  noteAccountSwitched(after, now, { auto: true, from: key });
  console.log(`[account-autoswitch] switched ${from} -> ${result.label}${result.warning ? ` - WARNING: ${result.warning}; automatic switching held until a switch by hand` : ''}`);
  autoSwitchNotice(cfg, 'switched', { from, to: result.label, resetAt: spent.resetAt, pct: spent.pct, warning: result.warning });
  resumeAfterAutoSwitch().catch((e) => console.error(`[account-autoswitch] resume hand-off failed: ${e.message}`));
}

// A failed attempt: the cooldown doubles per failure in a row (autoSwitchLib.cooldownAfter),
// and the phone hears once per distinct failure, never every retry for the days the old
// account stays capped.
function autoSwitchFailed(cfg, now, from, to, e) {
  const error = autoSwitchError(e);
  const noticeKey = `${to}|${error}`;
  const repeat = _autoSwitch.failNotice === noticeKey;
  _autoSwitch = { ..._autoSwitch, attemptAt: now, failures: (_autoSwitch.failures || 0) + 1, failNotice: noticeKey };
  saveAutoSwitchState();
  const retryAt = now + autoSwitchLib.cooldownAfter(cfg, _autoSwitch);
  if (repeat) console.log(`[account-autoswitch] switch to ${to} failed again (${error}); next attempt after ${new Date(retryAt).toISOString()}`);
  else autoSwitchNotice(cfg, 'failed', { from, to, error, retryAt });
}

// No record of whose login this is (first run, or a state file lost): record it now, so a
// reading taken before this moment is never pinned on it.
function seedAutoSwitchIdentity(now = Date.now()) {
  if (_autoSwitch.activeKey || !autoSwitchLib.autoSwitchConfig(liveConfig('claudeAccountAutoSwitch', null)).enabled) return;
  try {
    const st = claudeAccount.status(claudeAccountHome());
    if (st.active) noteAccountSwitched(st, now, { keepWindows: true });
  } catch { /* unreadable now; asked again on the next tick */ }
}
setImmediate(seedAutoSwitchIdentity);

// A refusal says why in words meant for a person; anything else may name paths, so the
// phone gets a pointer and the server log keeps the detail.
function autoSwitchError(e) {
  if (e instanceof claudeAccount.Refusal) return e.message;
  console.error(`[account-autoswitch] ${e.message}`);
  return 'an unexpected error (see the server log)';
}

// A spent reading can outlast a blocker (the cooldown, the restart hold) while no new report
// arrives - a capped session stops calling the API - so the question is asked again on a clock.
setInterval(() => {
  try { seedAutoSwitchIdentity(); considerAutoSwitch(); } catch (e) { console.error(`[account-autoswitch] ${e.message}`); }
}, 60 * 1000).unref();

// --- API: create session ---
// #421 - a SOFT limit: it colours the machine's session count (lib/machine-profile.js
// sessionsLevel - amber at it, red past it) and never refuses a session. The owner runs
// more than ten on a box on purpose; a hard 429 here (and a 'no-slot' hand-off failure)
// blocked exactly that.
const SESSIONS_SOFT_LIMIT = config.maxSessions || 10;
const DEDUP_WINDOW_MS = 2000; // reject duplicate name+cwd within 2 seconds
let _lastSessionCreate = { name: '', cwd: '', time: 0 };
// #472 - how long a `replaces` create waits to learn who is calling. Longer than the #377
// parent trace (whose answer may land later): here the answer DECIDES, so none is a refusal.
const REPLACES_TRACE_MS = 10000;
/** #512 - the body of POST /api/sessions, as `{status, json}`: Mission Control's Start work
 *  (POST /api/mc/start) creates a session on THIS server through exactly this path. `req`
 *  is `{body, socket}`: the socket is read only to trace a caller (`spawnedBy`, `replaces`). */
async function createSessionFrom(req) {
  const answer = (status, json) => ({ status, json });
  try {
    // #359 - nothing new starts on a machine about to restart: on 2026-10-16 an
    // orchestrator started a session here 36 minutes into the wrap-up window.
    const held = req.body?.force === true ? null : maintRefusal();
    if (held) return answer(503, held);
    const { sessions: existing } = await workerClient.rpc('listSessions');
    const id = crypto.randomUUID();
    const liveCwd = getDefaultCwd();
    // Canonicalise before ANYTHING reads it — the dedup key, the existence check
    // and the string persisted on the session all have to agree. A trailing
    // separator is the case that bites: `claudeProjectDirName` gives it its own
    // dash, so `C:\dev\p\` names a project dir Claude never created and the Chat
    // lens silently resolves nothing (see lib/cwd.js). Both clients now pre-fill
    // the folder field WITH a trailing separator so a subfolder can be typed
    // straight away, which makes this the load-bearing normalisation, not a nicety.
    let cwd = normalizeCwd(String(req.body?.cwd || liveCwd).substring(0, 260));
    const name = String(req.body?.name || `Session ${existing.length + 1}`).substring(0, 100).replace(/[\x00-\x1f]/g, '');
    // #533 - the model for THIS task, so the starter need not compose a command line: `--model <m>` goes
    // right after the claude program word unless that call already names one (lib/model-flag.js). It is
    // placed on the WHOLE command, BEFORE the 500-character cut (the worker cuts to 500 again, so what is
    // stored and typed is exactly this), and refused - never cut to fit - when it is malformed, when the
    // command has no claude call to put it in, or when the flag would push the command past 500.
    const wantModel = modelFlag.parseModel(req.body?.model);
    if (wantModel.error) return answer(400, { error: wantModel.error });
    const wantedCommand = String(req.body?.autoCommand || getDefaultCommand() || '');
    let autoCommand = wantedCommand.substring(0, 500);
    if (wantModel.model) {
      const placed = modelFlag.applyModel(wantedCommand, wantModel.model);
      if (placed.error) return answer(400, { error: placed.error });
      if (placed.cmd !== wantedCommand && placed.cmd.length > 500) {
        return answer(400, { error: `the command with --model ${wantModel.model} is ${placed.cmd.length} characters; the limit is 500` });
      }
      autoCommand = placed.cmd.substring(0, 500);
    }
    // Which AI agent this session runs. An explicit pick from the client wins; an
    // unknown id is rejected rather than silently coerced, so a typo can't persist a
    // bogus agent onto the session. Absent → the worker infers it from the command.
    let agent = null;
    if (req.body?.agent != null && req.body.agent !== '') {
      if (!agentsLib.isKnownAgent(req.body.agent)) {
        return answer(400, { error: `Unknown agent: ${String(req.body.agent).slice(0, 40)}` });
      }
      agent = req.body.agent;
    }
    // #374 - the session that asked for this one (its own $WT_SESSION_ID), so the clients can
    // draw this as its child. A malformed id is refused, not dropped: the link would vanish silently.
    const parent = spawnReaper.parentIdOf(req.body?.parentId);
    if (!parent.ok) return answer(400, { error: 'parentId must be a session id' });
    // #466 - what the session is opened FOR, for the journal. Refused, never cut to fit.
    const goal = spawnGoalOf(req.body?.goal);
    if (!goal.ok) return answer(400, { error: goal.error });
    // #472 - a session handing ITSELF off (`replaces` = its own id): proven by tracing the
    // request to the session it runs in, BEFORE anything is created. Untraceable is refused.
    const replaces = spawnReaper.replacesOf(req.body?.replaces, req.body?.parentId);
    if (!replaces.ok) return answer(400, { error: replaces.error });
    if (replaces.id) {
      if (!existing.some((s) => s.id === replaces.id)) return answer(404, { error: 'the replaced session is not on this server' });
      const caller = await Promise.race([callerSession.callerSession(req.socket, existing),
        new Promise((r) => setTimeout(() => r(null), REPLACES_TRACE_MS))]);
      const refused = spawnReaper.replacesRefusal(replaces.id, caller);
      if (refused) return answer(403, { error: refused });
    }
    // Deduplicate rapid session creation (same name + cwd within time window)
    const now = Date.now();
    if (name === _lastSessionCreate.name && cwd === _lastSessionCreate.cwd && now - _lastSessionCreate.time < DEDUP_WINDOW_MS) {
      return answer(409, { error: 'Duplicate session — please wait before creating another with the same name and folder' });
    }
    _lastSessionCreate = { name, cwd, time: now };
    // Verify cwd exists — return error if user specified a bad path
    try {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        if (req.body?.cwd) return answer(400, { error: `Folder does not exist: ${cwd}` });
        cwd = liveCwd;
      }
    } catch (e) {
      if (req.body?.cwd) return answer(400, { error: `Folder does not exist: ${cwd}` });
      cwd = liveCwd;
    }
    // #377 - an agent that sent who it is (`spawnedBy`) but no parent: find the session it
    // runs in from the process on the other end of this request. Started beside the create,
    // while the caller is still connected; null when it cannot be traced.
    const traced = !parent.id && !replaces.id && req.body?.spawnedBy ? callerSession.callerSession(req.socket, existing) : null;
    const created = await workerClient.rpc('createSession', { id, cwd, name, autoCommand, agent });
    // #359 - a session forced through a restart hold is told and judged like the rest.
    maintUpdate((h) => maintLib.trackSession(h, { id, name, agent: agentsLib.resolveAgent(created.agent, autoCommand) }));
    if (replaces.id) {
      // #472 - a successor, not a child: it inherits the verdict, the parent and the goal.
      recordHandoff(replaces.id, id, { trigger: 'agent', name: created.name || name, cwd, agent: agentsLib.resolveAgent(created.agent, autoCommand),
        entry: getBriefEntry(replaces.id), goal: goal.goal });
    } else {
      // #351 - start the classify window: a person opens a session they made, an agent's call never does.
      spawnStore.created(id, req.body?.spawnedBy, parent.id, goal.goal);
      journalAppend(journalLib.openedRecord({ id, at: Date.now(), via: 'api', name: created.name || name, cwd, agent: agentsLib.resolveAgent(created.agent, autoCommand),
        spawnedBy: req.body?.spawnedBy, parentId: parent.id, goal: goal.goal }));
    }
    // The record above is written at once (a person's first look must not be lost); the
    // traced parent joins it when the trace answers. The answer waits at most
    // TRACE_WAIT_MS for it - the caller must stay connected while it is traced, but a
    // process query that hangs must not hold a create for half a minute.
    if (traced) {
      traced.then((p) => { if (p) spawnStore.setParent(id, p); });
      await Promise.race([traced, new Promise((r) => setTimeout(r, callerSession.TRACE_WAIT_MS))]);
    }
    invalidateClusterSessionsCache(); // new session must show in the sidebar immediately
    // Answer the RESOLVED agent, not just the explicit pick the worker echoes back —
    // the same value `GET /api/sessions` will report for this session (#119). The
    // client builds the session it opens from this response, and its Chat lens is
    // gated on the field, so echoing null for an inferred agent opened every
    // Auto-created agent session with no chat controls until a re-select.
    // #147 — and the readiness, for exactly the same reason the agent is here:
    // the client BUILDS the session it opens from this response, so a field it
    // omits takes its default. `agentReady` defaults to true, so omitting it
    // left the submit gate OPEN on a brand-new session — the one flow #147 is
    // about. Read from the worker's own summary rather than assumed false: a
    // plain shell and an agent with no declared marker are ready at once.
    return answer(200, {
      id: created.id,
      name: created.name,
      agent: agentsLib.resolveAgent(created.agent, autoCommand),
      agentReady: created.agentReady ?? true,
      model: modelFlag.modelOf(autoCommand),
    });
  } catch (e) {
    console.error(`Failed to create session: ${e.message}`);
    return answer(500, { error: 'Failed to create session' });
  }
}
app.post('/api/sessions', express.json({ limit: '16kb' }), async (req, res) => {
  const r = await createSessionFrom(req);
  res.status(r.status).json(r.json);
});

// --- API: update session (rename, change autoCommand) ---
app.patch('/api/sessions/:id', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    // Verify session exists.
    let current;
    try { current = await workerClient.rpc('getSession', { id: req.params.id }); }
    catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    const newName = req.body?.name ? String(req.body.name).substring(0, 100).replace(/[\x00-\x1f]/g, '') : null;
    if (newName) await workerClient.rpc('renameSession', { id: req.params.id, name: newName });
    let autoCommand = current.autoCommand;
    if (req.body?.autoCommand !== undefined) {
      const r = await workerClient.rpc('updateSessionAutoCommand', {
        id: req.params.id,
        autoCommand: String(req.body.autoCommand).substring(0, 500),
      });
      autoCommand = r.autoCommand;
    }
    if (newName || req.body?.autoCommand !== undefined) invalidateClusterSessionsCache();
    res.json({ id: req.params.id, name: newName || current.name, autoCommand });
  } catch (e) {
    console.error(`PATCH /api/sessions failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// --- API: per-session push (ntfy) level ---
app.get('/api/sessions/:id/notify-level', (req, res) => {
  res.json({ id: req.params.id, level: getNotifyLevel(req.params.id) });
});
app.patch('/api/sessions/:id/notify-level', express.json({ limit: '1kb' }), (req, res) => {
  const level = req.body?.level;
  if (!notifyPush.LEVELS.includes(level)) {
    return res.status(400).json({ error: 'level must be one of ' + notifyPush.LEVELS.join(', ') });
  }
  res.json({ id: req.params.id, level: setNotifyLevel(req.params.id, level) });
});

// --- API: per-session favorite (pin) + its rank in the pinned group (#60) ---
// Behind the same auth as every other session route. The rank is the session's
// position in the CLUSTER-WIDE pinned group: a client that can see the whole
// union (web sidebar, companion) sends the new index for each session whose
// position changed — reordering is therefore N small PATCHes, each landing on
// the server that owns that session, and no server ever holds a list of another
// server's sessions.
app.get('/api/sessions/:id/favorite', (req, res) => {
  res.json({ id: req.params.id, ...favoriteFields(req.params.id) });
});
app.patch('/api/sessions/:id/favorite', express.json({ limit: '1kb' }), (req, res) => {
  const id = req.params.id;
  // A session id is a UUID (the worker rejects anything else) — so a bogus id can
  // never become a persisted key in favorites.json.
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  const favorite = req.body?.favorite;
  if (typeof favorite !== 'boolean') return res.status(400).json({ error: 'favorite must be a boolean' });
  const rank = req.body?.rank;
  if (rank !== undefined && !(typeof rank === 'number' && Number.isFinite(rank) && rank >= 0)) {
    return res.status(400).json({ error: 'rank must be a non-negative number' });
  }
  setFavorite(id, favorite, rank);
  invalidateClusterSessionsCache(); // the pinned group must re-render on the next poll
  res.json({ id, ...favoriteFields(id) });
});
// --- API: per-session 5h auto-resume opt-out (#137) -------------------------
// The cancel behind the sidebar's wait-period badge. Behind the same auth as every
// other session route, and the same UUID guard as /favorite so a bogus id can never
// become a persisted key.
//
// Flipping this must take effect on the CURRENT window, not the next one: the push
// to the worker is de-duped on its last value, so a plain PATCH would be swallowed
// as "unchanged" until the timestamp itself moved — a cancel that appears to work
// and then fires anyway. forgetPushedResetAt drops that memo so the next poll
// re-pushes, and the PATCH itself pushes the new choice straight through.
//
// It pushes ONLY `enabled`. Sending a null reset time was the old way to cancel, and
// it made re-enabling a lossy operation: the worker persisted the null, so the very
// schedule the badge was counting down to was gone, and the re-push that would
// restore it is gated on metrics that a capped Claude session has stopped sending.
// Toggling off and back on left the row "on hold" forever.
app.get('/api/sessions/:id/auto-resume', (req, res) => {
  res.json({ id: req.params.id, enabled: getAutoResumeEnabled(req.params.id) });
});
app.patch('/api/sessions/:id/auto-resume', express.json({ limit: '1kb' }), (req, res) => {
  const id = req.params.id;
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' });
  const on = setAutoResumeEnabled(id, enabled);
  forgetPushedResetAt(id);
  // Act NOW, do not defer to the metrics poll. sessionMetrics returns early for a
  // session whose transcript cannot be resolved (and for one with no metrics source
  // at all), so armResetTimerFromMetrics may simply never run for it — in which case
  // a deferred cancel is no cancel: the badge flips to "on hold" and the worker still
  // fires `continue`. A user action must not depend on a poll that may not come. The
  // same is true of the re-enable, which is why BOTH directions are pushed: the
  // worker still holds the reset time, so turning it back on re-arms immediately
  // instead of waiting for metrics that may never speak again.
  _pushResetState(id, { enabled: on });
  invalidateClusterSessionsCache(); // the badge must re-render on the next poll
  res.json({ id, enabled: on });
});

// Structured "what needs my attention" for one session: the last recorded
// attention event (kind/reason) plus Claude's freshly-read last message. Lets a
// companion app or voice layer pull the real content over the private network,
// so the push relay can stay content-free (ntfy.includeContent=false). Behind
// the same auth as the other session routes; never cached.
// #298 — a person pins the work item(s) a session is on, or opts it out of reporting.
// Behind the auth middleware like every other session PATCH. A pin's state is optional:
// it asserts WHICH item; the agent's own report says how far along it is.
app.patch('/api/sessions/:id/brief', express.json({ limit: '16kb' }), async (req, res) => {
  const id = req.params.id;
  try { await workerClient.rpc('getSession', { id }); } catch { return res.status(404).json({ error: 'session not found' }); }
  const body = req.body || {};
  let entry = { ...(getBriefEntry(id) || briefLib.emptyEntry()) };
  if (body.pinned !== undefined) {
    const v = briefLib.validatePinned(body.pinned);
    if (v.error) return res.status(400).json({ error: v.error });
    entry.pinned = v.pinned;
  }
  if (body.optOut !== undefined) {
    if (typeof body.optOut !== 'boolean') return res.status(400).json({ error: 'optOut must be a boolean' });
    entry.optOut = body.optOut;
  }
  // #320 - a person clears what the AGENT reported it is waiting on, when it is wrong
  // (an offer filed as "waiting on you"). Only the reported wait: a live prompt, a
  // running turn, a cap or a menu are mechanical and are not this route's to clear.
  if (body.clearWait !== undefined) {
    if (body.clearWait !== true) return res.status(400).json({ error: 'clearWait must be true' });
    entry = briefLib.clearWait(entry) || entry;
  }
  // #314 - hide from the dashboard (never from the session list). Stored with the
  // session on the server that owns it, so every device shows the same Hidden tab.
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') return res.status(400).json({ error: 'hidden must be a boolean' });
    entry.hidden = body.hidden;
  }
  // #445 - a questions-inbox item dismissed (or restored) by a person. Stored with the
  // session on the server that owns it, so every device hides the same items.
  if (body.inboxDismiss !== undefined) {
    const v = briefLib.applyInboxDismiss(entry.inboxDismissed, body.inboxDismiss);
    if (v.error) return res.status(400).json({ error: v.error });
    entry.inboxDismissed = v.list;
  }
  // #443 - this session is never checked in on (lib/check-in.js). The fleet switch is
  // config `checkIn.enabled`.
  if (body.checkInOff !== undefined) {
    if (typeof body.checkInOff !== 'boolean') return res.status(400).json({ error: 'checkInOff must be a boolean' });
    entry.checkInOff = body.checkInOff;
  }
  setBriefEntry(id, entry);
  res.json({ ok: true, brief: briefLib.buildBrief(entry, {
    reporting: briefLib.reportingEnabled(entry, dashboardConfig()), origin: originForCwd(entry.cwd) }) });
});

// #340 - a person starts a hand-off from the board. Behind the auth middleware like every
// other session route (the agent's own verdict route above it takes the hook token).
// Only a session the board would OFFER it for - the same rule, from the same row - unless
// `force`, which skips the gates that are judgement (idle long enough, at a boundary, big
// enough) and never the ones that are safety (mid-turn, asking you something, capped,
// compacting, booting).
app.post('/api/sessions/:id/handoff', express.json({ limit: '1kb' }), async (req, res) => {
  const id = req.params.id;
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  // #525 - the dispatcher is replaced its own way (dispatcherRecycle): a run that failed or was
  // kept would leave a dispatcher no case can be typed into.
  if (isDispatcherSession(id)) return res.status(400).json({ error: 'the supervisor\'s dispatcher is not handed off: the server replaces it between cases', why: 'dispatcher' });
  let row;
  try { row = await handoffRowFor(id); } catch { return res.status(404).json({ error: 'session not found' }); }
  const r = startHandoff(id, row, { force: Boolean(req.body && req.body.force === true) });
  if (!r.run) return res.status(r.status).json({ error: r.error, ...(r.why ? { why: r.why } : {}) });
  res.json({ ok: true, handoff: handoffLib.publicRun(r.run) });
});

// Cancel a run before it kills anything, or dismiss how the last one ended. Allowed in
// every state, `closing` included (it waits for the old turn to end, which can take
// minutes): the ticker re-checks the stored run with no await before the kill, so a
// cancel that lands first always wins. A successor already created stays open.
// #345 - either one is a "no" the automatic scan respects until a person types into the
// session again (lib/handoff.js autoBlock).
app.delete('/api/sessions/:id/handoff', (req, res) => {
  const id = req.params.id;
  const e = getBriefEntry(id);
  const run = (e || {}).handoff;
  if (!run) return res.status(404).json({ error: 'no hand-off on this session' });
  setBriefEntry(id, { ...e, handoff: null, handoffDeclinedAt: Date.now() });
  logHandoff(handoffLib.isActive(run) ? 'cancelled' : 'dismissed', id, run);
  res.json({ ok: true });
});

// #298 — sessions that ended in the last week (#337), newest first: name, work items, last
// word, and what a Reopen needs (briefLib.resumeOf).
// Local only; the dashboard asks each server through the cluster proxy, so one slow
// peer delays only its own strip.
app.get('/api/dashboard/closed', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ closed: briefLib.liveClosed(briefStore().closed, Date.now()) });
});

// #366 - the background / dispatched agents the agent CLI lists (`claude agents --json`).
// MACHINE-level: the listing has no parent or origin field, so it cannot be pinned on one
// session here; the dashboard shows it as a strip of its own. Local only, like /closed.
//
// Auth-only and BELOW the auth middleware: the output names every project's sessions and
// working directories on the box. The parser keeps a handful of fields and drops the
// rest (lib/background-listing.js), and NOTHING from the CLI is ever logged - a failure
// logs a reason code only. Every failure is a 200 `{ available:false }`: the strip is
// optional, and a 5xx here would read as the server being unwell.
// Spawns only when asked, at most once per registry `ttlMs`, however many clients poll - and
// the spawn is made in a worker THREAD (lib/background-listing-exec.js), not here: on Windows
// CreateProcess runs synchronously in the caller, and under an AV that hooks process creation
// it has blocked a Node loop for seconds (a ~290 MB claude.exe is what such a scanner reads).
// A freeze there is the thread's, and the route still answers within the timeout + grace.
const _backgroundListingCfg = agentsLib.backgroundListingFor(agentsLib.backgroundListingAgent());
const _backgroundListingExec = _backgroundListingCfg ? createThreadedExec() : null;
const _backgroundListing = _backgroundListingCfg ? createBackgroundListing({
  cfg: _backgroundListingCfg,
  // WT_CLAUDE_BIN names the binary outright (an operator, or a test); read at CALL time so a
  // value set after load, and a CLI installed after load, are both honoured.
  resolve: () => resolveListingBin({
    bin: _backgroundListingCfg.bin,
    override: process.env.WT_CLAUDE_BIN,
    pathValue: process.env.PATH,
    home: os.homedir(),
    platform: process.platform,
    exists: fs.existsSync,
  }),
  exec: _backgroundListingExec.exec,
  cwd: os.homedir(),
  // Called when the reason CHANGES, not per poll, so an outage is one line. Never any output.
  onFailure: (reason) => console.log(`[background-agents] listing unavailable: ${reason}`),
}) : null;
app.get('/api/dashboard/background-agents', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!_backgroundListing) return res.json({ available: false });
  res.json(await _backgroundListing.get());
});

app.get('/api/sessions/:id/attention', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const st = _notifyState.get(req.params.id) || {};
  res.json(notifyPush.buildAttentionResponse({
    id: req.params.id,
    serverName: getServerName(),
    lastAttention: st.lastAttention,
    lastMessage: transcript.lastAssistantText(st.transcriptPath),
  }));
});

// POST /api/sessions/:id/attention/clear — a device opened/viewed the session or
// dismissed its alert (#24). Clears the attention EVERYWHERE: flips the recorded
// attention to cleared (so /attention reflects it), fans out an FCM 'clear' so
// every phone auto-dismisses its OS notification, and broadcasts a 'clear' frame
// to the live notify sockets so other in-app viewers drop the attention chip.
// Idempotent — clearing an already-clear (or attention-less) session is a no-op.
app.post('/api/sessions/:id/attention/clear', (req, res) => {
  const id = req.params.id;
  pushNotify('clear', { id }); // flips lastAttention.cleared + FCM 'clear' dispatch
  const payload = JSON.stringify({ notification: { type: 'clear', sessionId: id, cleared: true } });
  for (const client of notifyClients) { try { client.send(payload); } catch {} }
  res.json({ ok: true });
});
// --- G5: structured transcript for the companion chat view ---
// GET /api/sessions/:id/transcript?before=<cursor>&limit=<n>
// Returns the session's Claude conversation as typed turns (newest-LAST), paged
// BACKWARD: no `before` → the last `limit` turns (default 50, cap 200); a
// `before=<cursor>` → the `limit` turns preceding that opaque cursor (base64 of a
// line-start byte offset). Response: { messages, cursor, hasMore }; cursor is null
// once the file start is reached. The parser lives SERVER-side (lib/transcript.js)
// so JSONL schema drift is a server fix, not an app release. Serves full Claude
// content, so: behind the same /api auth middleware as every session route; the
// file path comes ONLY from the validated stash (or a re-validated derivation),
// never from the request; Cache-Control: no-store. Reads only the chunks a page
// needs — a tens-of-MB transcript costs a few 256KB reads, not a full-file load.
// A positional reader over an open fd, in the shape transcript.scanTurnsBackward takes:
// fills `len` bytes from `off` (a read may return short) and returns fewer only at EOF.
function fdChunkReader(fd) {
  return (off, len) => {
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = fs.readSync(fd, buf, read, len - read, off + read);
      if (n <= 0) break;
      read += n;
    }
    return read === len ? buf : buf.slice(0, read);
  };
}

/// One page of session [id]'s transcript, newest last: `{tpath, agent, adapter, turns, cursor,
/// hasMore}`, or null when it has none. [before] a byte cursor (null: the tail), [limit] turns.
/// The ONE read behind GET /api/sessions/:id/transcript and the supervisor's `tail` (#468).
async function readTranscriptPage(id, before, limit) {
  // Resolve the transcript path (stash → validated derivation; SSOT helper).
  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return null;
  let fd;
  try {
    const size = fs.statSync(tpath).size;
    // A stale cursor past EOF just reads the tail rather than erroring.
    if (before != null && before > size) before = size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = fdChunkReader(fd);
    // Which agent wrote this transcript decides how a LINE is parsed; the paging,
    // cursor and tool_use↔result pairing are shared (lib/agents.js is the registry).
    const agent = agentForTranscriptPath(tpath);
    const adapter = getAdapter(agent);
    const { turns, cursor, hasMore } = transcript.scanTurnsBackward(readChunk, size, {
      before, limit, parseLine: adapter.parseLine, extractResults: adapter.extractResults,
    });
    return { tpath, agent, adapter, turns, cursor, hasMore };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
app.get('/api/sessions/:id/transcript', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;

  // Validate `limit`: positive integer, capped at 200 (the parser caps too).
  let limit = transcript.DEFAULT_PAGE;
  if (req.query.limit != null && req.query.limit !== '') {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'limit must be a positive integer' });
    limit = Math.min(transcript.MAX_PAGE, n);
  }

  // Validate `before`: opaque cursor → non-negative byte offset. Garbage → 400.
  let before = null;
  if (req.query.before != null && req.query.before !== '') {
    before = transcript.decodeCursor(String(req.query.before));
    if (before == null) return res.status(400).json({ error: 'invalid cursor' });
  }

  let page;
  try {
    page = await readTranscriptPage(id, before, limit);
  } catch (e) {
    console.error(`GET /api/sessions/${id}/transcript failed: ${e.message}`);
    return res.status(500).json({ error: 'Failed to read transcript' });
  }
  if (!page) return res.status(404).json({ error: 'no transcript for session' });
  const { tpath, agent, adapter, turns, cursor, hasMore } = page;
  try {
    // Stamp each Task tool_use that has a spawned subagent with a light stub so the
    // chat view can show a running dot + offer to drill in (via /subagent below).
    // Best-effort: any failure just leaves the flat Task cards as-is. Only agents whose
    // transcripts carry a sibling subagent directory have anything to index (Codex
    // reports a subagent's transcript on its SubagentStop hook instead).
    if (adapter.supportsSubagentTrace) {
      try {
        const idx = buildSubagentIndex(subagentDirForTranscript(tpath));
        if (idx.size) {
          const resolved = resolvedIdsTail(tpath);
          transcript.attachSubagentStubs(turns, (tid) => idx.get(tid) || null, (tid) => resolved.has(tid));
        }
      } catch {}
    }
    // `agent` lets the client label/colour the session without re-deriving it.
    // #73 — the task list rides the response the chat lens already polls, so it updates
    // live with no second endpoint and no client-side branch on the agent. Only on the
    // NEWEST page: it is session state, not page state, and a client paging back through
    // history must not have its panel replaced by an older plan.
    const taskList = before == null ? readSessionTaskList(id, agent, tpath) : null;
    res.json({ messages: turns, cursor, hasMore, agent, taskList });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/transcript failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read transcript' });
  }
});

// --- #70 Phase 1: read-aloud -------------------------------------------------
// GET /api/sessions/:id/speech -> { text, ts, agent }
// Returns the newest assistant PROSE turn reduced to a speakable utterance. The
// client speaks it; it does not decide what to say.
//
// Why the decision is server-side: "what is worth hearing" needs the transcript,
// the agent registry and (later) the session's event signals — none of which a
// client holds. Putting it in the client would fork the rule across app.html and
// the companion, which is the exact class of drift #56/#60 were about. The client
// stays a button plus a speech call.
//
// Deliberately NOT a new read surface: it reuses resolveSessionTranscriptPath (so
// the .jsonl-strictly-under-the-projects-root trust chain is unchanged) and the
// SAME per-agent adapter as /transcript, so Codex is supported with no branching.
// Only a small tail is scanned — one prose turn is all that can be spoken, and a
// deep page would be read and then thrown away.
const SPEECH_SCAN_TURNS = 12; // enough to step back over a run of tool-only turns
// The agent's latest WORD on a transcript (lib/speech.js). Returns { text, ts, agent, raw }:
// `text` is the read-aloud form GET /speech serves; `raw` is the same turns' newest summary
// in written form (identifiers intact) for the sessions dashboard's "did" line (#298/#383).
// They share the turn WINDOW and the TL;DR preference but each skips turns that reduce to
// nothing by its OWN rules, so they can pick different turns (e.g. a turn of only a bare
// URL has a raw form and no spoken one). Throws on an unreadable file.
function speechFromTranscriptPath(tpath) {
  let fd;
  try {
    const size = fs.statSync(tpath).size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = fdChunkReader(fd);
    const agent = agentForTranscriptPath(tpath);
    const adapter = getAdapter(agent);
    const { turns } = transcript.scanTurnsBackward(readChunk, size, {
      limit: SPEECH_SCAN_TURNS, parseLine: adapter.parseLine, extractResults: adapter.extractResults,
    });
    const { text, ts } = speech.speechFromTurns(turns);
    // The same turns in raw form for the brief's "did" (#383). Kept OFF the /speech
    // response (the route picks its fields) - a voice client must never see it.
    const raw = speech.rawSummaryFromTurns(turns);
    // And the newest reply as written, for the backstop that reads its END (#526).
    return { text, ts, agent, raw: raw.text, reply: speech.lastReplyFromTurns(turns).text };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

app.get('/api/sessions/:id/speech', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;

  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });

  try {
    // An empty `text` is a normal answer meaning "nothing worth saying" (the last
    // turns were all tool calls, or were pure code). The client must stay silent
    // on it — it is NOT an error and NOT a reason to fall back to raw text.
    const { text, ts, agent } = speechFromTranscriptPath(tpath);
    res.json({ text, ts, agent });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/speech failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read transcript' });
  }
});

// --- session recap: "where was I in this one?" -------------------------------
// GET /api/sessions/:id/recap -> { name, cwd, status, agent, lastActivity,
//                                  waitingFor, prompt, reply, since, tasks }
// With a dozen sessions open the sidebar says THAT something is running, never
// WHAT. This answers it in one glance: your last prompt, the agent's latest word,
// and what it has been doing since.
//
// Derived SERVER-side (lib/recap.js) for the same reason as /speech: deciding
// "what re-orients a human" needs the transcript, the agent registry and the task
// fold, none of which a client holds — and duplicating the rule across app.html
// and the companion is the drift this codebase keeps paying for. Both clients stay
// a button plus a fetch.
//
// ON DEMAND, never on the poll. Building a recap costs a transcript tail read per
// session; doing that for every row on every sidebar refresh would turn a 2-second
// poll into a disk storm for information nobody is looking at. The user clicks one
// row, we read one tail.
//
// DEGRADES, never 404s. A plain shell (or an agent that has not written a turn
// yet) has no transcript, but "idle, in C:\dev\web-terminal, 20m ago" still
// orients you — so a missing or unreadable transcript returns the session-level
// card rather than an error. Same trust chain as /transcript: the path comes only
// from resolveSessionTranscriptPath, and Cache-Control: no-store.
// A recap scans BACKWARD until it finds a prompt the user actually typed, rather
// than reading one fixed window and giving up.
//
// A fixed window was measured wrong on the live fleet (2026-08-03): 3 of 12
// sessions had ZERO user turns in their newest 80, and the same sessions had 1-5
// human prompts within 200. One tool-heavy stretch produces enough turns to bury
// the last thing the user said, so "no prompt found" was reported for sessions
// that plainly had one. Raising the constant would only move the cliff; paging
// removes it, and costs nothing in the common case because the loop stops the
// moment a prompt is found (9 of those 12 stopped on the first page).
const RECAP_PAGE_TURNS = 150;
const RECAP_MAX_TURNS = 750; // hard budget: a recap must not read a whole 100 MB log
// #246 made the card list the newest `recap.MAX_PROMPTS` prompts rather than one,
// so the walk can no longer stop on the FIRST page that holds a prompt. What it
// must NOT do is cost K times the old scan, and neither ceiling below is
// multiplied by K:
//   * RECAP_MAX_TURNS is UNCHANGED, so the worst case is exactly today's worst
//     case - a session with no typed prompt at all already walked all 750;
//   * once the newest prompt is in hand the walk may spend at most
//     RECAP_EXTRA_TURNS more looking for older ones, and then STOPS with fewer
//     prompts rather than reading further.
// So the paging argument above survives intact: a session whose prompt sits on
// page 1 - 9 of the 12 measured - reads at most 300 turns instead of 150, never
// 450. The reported 13h session (its prompt found at 600) reads 750, the ceiling
// it could already reach, i.e. 1.25x and not 3x.
const RECAP_EXTRA_TURNS = RECAP_PAGE_TURNS; // one page past today's stop point
/** The recap of session [id] on THIS server: `{status, body}`. One builder for the route and
 *  for Mission Control's Ask (#511), which reads it in-process for a local session. */
async function sessionRecap(id) {
  let session;
  try { session = await workerClient.rpc('getSession', { id }); }
  catch { return { status: 404, body: { error: 'no such session' } }; }
  if (!session) return { status: 404, body: { error: 'no such session' } };

  const base = {
    name: session.name,
    cwd: session.cwd,
    status: session.status,
    agent: session.agent ?? null,
    lastActivity: session.lastActivity ?? null,
    waitingFor: sessionWaitingFor(session),
    prompt: null,
    prompts: [],
    reply: null,
    since: { turns: 0, tools: [] },
    scan: { turns: 0, exhausted: false },
    tasks: null,
  };

  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return { status: 200, body: base };

  let fd;
  try {
    const size = fs.statSync(tpath).size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = fdChunkReader(fd);
    const agent = agentForTranscriptPath(tpath);
    const adapter = getAdapter(agent);
    // Page backward until recap.MAX_PROMPTS HUMAN prompts are in hand (or a
    // ceiling/the file runs out). The stop condition asks recap's own rule, so the
    // scan can never stop on a turn buildRecap would then reject.
    //
    // `exhausted` is the one fact the card cannot derive: it separates "this
    // session has no typed prompt" from "we stopped looking". Reporting the second
    // as the first is the confidently-wrong failure this whole module exists to
    // avoid, so the walk publishes WHY it stopped.
    let turns = [];
    let before = null;
    let exhausted = false;  // stopped on a ceiling, not at the start of the file
    let firstPromptAt = -1; // turns read when the NEWEST prompt came into view
    for (;;) {
      if (turns.length >= RECAP_MAX_TURNS) { exhausted = true; break; }
      const page = transcript.scanTurnsBackward(readChunk, size, {
        before, limit: RECAP_PAGE_TURNS,
        parseLine: adapter.parseLine, extractResults: adapter.extractResults,
      });
      // Older page goes in FRONT — the list stays newest-LAST for buildRecap.
      turns = page.turns.concat(turns);
      const found = recap.findHumanPromptIndexes(turns).length;
      if (found >= recap.MAX_PROMPTS) break;
      if (found > 0) {
        if (firstPromptAt < 0) firstPromptAt = turns.length; // today's stop point
        else if (turns.length - firstPromptAt >= RECAP_EXTRA_TURNS) { exhausted = true; break; }
      }
      if (!page.cursor) break; // reached the start of the file
      const next = transcript.decodeCursor(page.cursor);
      if (next == null || next === before) break; // malformed or no progress
      before = next;
    }
    return { status: 200, body: {
      ...base,
      agent,
      ...recap.buildRecap(turns),
      scan: { turns: turns.length, exhausted },
      tasks: recap.summariseTasks(readSessionTaskList(id, agent, tpath)),
    } };
  } catch (e) {
    console.error(`GET /api/sessions/${id}/recap failed: ${e.message}`);
    return { status: 200, body: base }; // a partial card beats an error dialog
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}
app.get('/api/sessions/:id/recap', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await sessionRecap(req.params.id);
  res.status(r.status).json(r.body);
});

// --- GET /api/sessions/:id/digest  (#383) --------------------------------------
// A model-written summary of ONE inbox wait: what the session is about, what exactly is
// being asked, and what the person needs to know to answer. CONTEXT ONLY - the question
// and its options stay the authority, and nothing here answers or changes anything.
//
//   200 { status:'ready', waitKey, about, asking:[], know:[], model, generatedAt, cached }
//   200 { status:'none',  waitKey:null }         nothing to summarise
//   200 { status:'missing', waitKey }            ?peek=1 and nothing is cached
//   502 { status:'failed', reason }              ?peek=1 inside a remembered failure (~60s)
//   503 { status:'unavailable', reason:'disabled'|'no-cli'|'busy' }
//   502 { status:'failed',      reason:'timeout'|'error'|'bad-output' }
//
// A run starts ONLY when a client asks (never on a poll or a hook), is cached by
// session + waitKey, and is shared by concurrent askers. The rules live in
// lib/inbox-digest.js; this route supplies the transcript facts. Config `inboxDigest`
// ({ enabled, model, command }) is deliberately NOT in ALLOWED_CONFIG_KEYS: `command`
// is something this server EXECUTES, so it is editable only where config.json is.
function digestConfig() {
  const live = liveConfig('inboxDigest', {});
  const c = live && typeof live === 'object' && !Array.isArray(live) ? { ...live } : {};
  // Test seams, the WT_CLUSTER_TOKENS_FILE idiom: the suite points the runner at a fake
  // CLI and shortens the ceiling without touching config.json.
  if (process.env.WT_INBOX_DIGEST_COMMAND) {
    try { c.command = JSON.parse(process.env.WT_INBOX_DIGEST_COMMAND); } catch { /* ignore a bad override */ }
  }
  if (process.env.WT_INBOX_DIGEST_TIMEOUT_MS) c.timeoutMs = Number(process.env.WT_INBOX_DIGEST_TIMEOUT_MS);
  return c;
}
const digestService = inboxDigest.createDigestService({
  getConfig: digestConfig,
  scratchDir: () => { fs.mkdirSync(SCRATCH_DIRS.digest, { recursive: true }); return SCRATCH_DIRS.digest; },
});

// Page backward until the newest HUMAN prompt is in hand (or the same ceiling /recap
// uses), returning newest-LAST turns and the prompt's index in them (-1: none found).
function readTurnsToLastPrompt(tpath) {
  let fd;
  try {
    const size = fs.statSync(tpath).size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = fdChunkReader(fd);
    const adapter = getAdapter(agentForTranscriptPath(tpath));
    let turns = [];
    let before = null;
    for (;;) {
      if (turns.length >= RECAP_MAX_TURNS) break;
      const page = transcript.scanTurnsBackward(readChunk, size, {
        before, limit: RECAP_PAGE_TURNS,
        parseLine: adapter.parseLine, extractResults: adapter.extractResults,
      });
      turns = page.turns.concat(turns);
      if (recap.findHumanPromptIndex(turns) >= 0) break;
      if (!page.cursor) break;
      const next = transcript.decodeCursor(page.cursor);
      if (next == null || next === before) break;
      before = next;
    }
    return { turns, promptIndex: recap.findHumanPromptIndex(turns) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// What the digest reads of a transcript, remembered per file while its size + mtime hold.
const digestWaits = inboxDigest.createWaitCache({
  stat: (p) => fs.statSync(p),
  derive: (p) => {
    const { turns, promptIndex } = readTurnsToLastPrompt(p);
    let question = null;
    try { question = pendingQuestionFromTranscript(p); } catch { question = null; }
    return { turns, promptIndex, question };
  },
});

/** Session [id]'s inbox digest on THIS server: `{status, body}`. One builder for the route
 *  and for Mission Control's question context (#510), which only ever PEEKS (never a run). */
async function sessionDigest(id, { peek }) {
  try {
    // #423 - settled BEFORE the worker is asked, so its status and the question agree.
    checkPendingQuestion(id);
    let session;
    try { session = await workerClient.rpc('getSession', { id }); }
    catch { return { status: 404, body: { error: 'no such session' } }; }
    if (!session) return { status: 404, body: { error: 'no such session' } };

    const none = () => ({ status: 200, body: { status: 'none', waitKey: null } });
    const tpath = await resolveSessionTranscriptPath(id);
    if (!tpath) return none();

    // One stat per request when the file is unchanged (SF2): the walk and the tail read run
    // only when the transcript's size or mtime moved.
    const { turns, promptIndex, question: transcriptQuestion } = digestWaits.get(tpath);
    const promptTurn = promptIndex >= 0 ? turns[promptIndex] : null;
    const since = turns.slice(promptIndex + 1);
    const lastAssistant = [...since].reverse().find((t) => t && t.role === 'assistant') || null;

    // What is being asked: the live AskUserQuestion, else one the transcript still holds
    // unanswered; failing both, a blocked session is asking permission. The call is named
    // only when it is unambiguous (inboxDigest.permissionCallOf: one open call, not a
    // subagent's, agreeing with the brief's "now" line); otherwise the digest says only that
    // a permission is waiting. Anything else is an ask made in prose.
    let question = (_notifyState.get(id) || {}).pendingQuestion || transcriptQuestion || null;
    let permission = null;
    if (!question && sessionWaitingFor(session) === 'permission') {
      const nowLine = ((getBriefEntry(id) || {}).now || {}).text;
      permission = inboxDigest.permissionCallOf(since, nowLine) || { tool: null };
    }
    if (!question && !permission && !inboxDigest.hasAgentText(since)) return none();

    const waitKey = inboxDigest.waitKeyOf({ promptTurn, lastAssistant, question, permission });
    const out = await digestService.get(id, {
      waitKey,
      // Built only if a run starts: a cached answer and a peek never pay for the string.
      prompt: () => inboxDigest.buildPrompt({
        name: session.name, cwd: session.cwd, promptTurn, turns: since, question, permission,
      }),
    }, { peek });
    return out;
  } catch (e) {
    console.error(`GET /api/sessions/${id}/digest failed: ${e.message}`);
    return { status: 502, body: { status: 'failed', reason: 'error' } };
  }
}
app.get('/api/sessions/:id/digest', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await sessionDigest(req.params.id, { peek: req.query.peek === '1' || req.query.peek === 'true' });
  res.status(r.status).json(r.body);
});

// --- chat-mode subagent trace: drill into ONE subagent's transcript -----------
// GET /api/sessions/:id/subagent/:toolUseId?before=<cursor>&limit=<n>
// A Task tool_use in /transcript carries a { agentType, description, running }
// stub when it spawned a subagent; this lazily pages that subagent's OWN transcript
// (newest-LAST, same backward cursor as /transcript) so the chat view can show the
// subagent's nested tool calls — the chat-native equivalent of the terminal's
// arrow-navigable subagent panel. :toolUseId is only ever a lookup KEY into the
// meta index built from real dir entries — the agent .jsonl path is never
// constructed from the request — and the resolved file is re-validated through
// safeTranscriptPath (.jsonl strictly under the Claude projects root), so this
// route can read nothing the stash/derivation couldn't. Nested Task tool_uses in
// the response carry their own stubs (all subagents share one flat subagents dir),
// so the client drills deeper via the same endpoint. Cache-Control: no-store.
app.get('/api/sessions/:id/subagent/:toolUseId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;
  const toolUseId = req.params.toolUseId;

  // Same limit/before validation as /transcript.
  let limit = transcript.DEFAULT_PAGE;
  if (req.query.limit != null && req.query.limit !== '') {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'limit must be a positive integer' });
    limit = Math.min(transcript.MAX_PAGE, n);
  }
  let before = null;
  if (req.query.before != null && req.query.before !== '') {
    before = transcript.decodeCursor(String(req.query.before));
    if (before == null) return res.status(400).json({ error: 'invalid cursor' });
  }

  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });

  // Resolve the subagent file via the meta index (toolUseId is a key, not a path),
  // then re-validate it through the same .jsonl-under-projects-root trust chain.
  const entry = buildSubagentIndex(subagentDirForTranscript(tpath)).get(toolUseId);
  const file = entry ? safeTranscriptPath(entry.file) : '';
  if (!file) return res.status(404).json({ error: 'no subagent for tool_use' });

  let fd;
  try {
    const size = fs.statSync(file).size;
    if (before != null && before > size) before = size;
    fd = fs.openSync(file, 'r');
    const readChunk = fdChunkReader(fd);
    const { turns, cursor, hasMore } = transcript.scanTurnsBackward(readChunk, size, { before, limit });
    // Deeper nesting: a subagent can itself spawn subagents (all in the same flat
    // subagents dir), so stamp nested Task tool_uses too — resolved-set from THIS
    // subagent's tail (its nested tool_results live in its own transcript).
    try {
      const idx = buildSubagentIndex(subagentDirForTranscript(tpath));
      const resolved = resolvedIdsTail(file);
      transcript.attachSubagentStubs(turns, (tid) => idx.get(tid) || null, (tid) => resolved.has(tid));
    } catch {}
    // This subagent is running iff the PARENT transcript has no tool_result for its
    // Task tool_use id yet (same signal the /transcript stub used).
    const running = !resolvedIdsTail(tpath).has(toolUseId);
    res.json({ agentType: entry.agentType, description: entry.description, running, messages: turns, cursor, hasMore });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/subagent/${toolUseId} failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read subagent transcript' });
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
});

// GET /api/sessions/:id/pending-question  (#19)
// The newest UNanswered AskUserQuestion prompt for the session, as structured
// JSON pulled from the transcript (questions/options/multiSelect), so the app
// can render a native question overlay instead of forcing the user to drive
// Claude's TUI selector. { pending: false } when there's nothing to answer.
// Same path-resolution + Cache-Control: no-store contract as /transcript.
// #79 — the one place that answers "what is this session blocked on?".
//
// Both session-shaping sites call this: /api/sessions (which peers fetch) and the
// cluster merge's LOCAL branch, which is hand-shaped field-by-field. The pure rule
// lives in lib/waiting-for.js; this only supplies the fact the rule needs — whether a
// live AskUserQuestion was captured — from the same _notifyState the overlay reads, so
// the banner and the overlay can never disagree about whether a question is on screen.
function sessionWaitingFor(s) {
  if (!s) return null;
  // #423 - the same owner the overlay route reads. A question this call found rejected
  // leaves `s.status` (read from the worker before the clear reached it) at the
  // question's 'waiting', which with no question would read as a permission prompt.
  const { question, resolvedNow } = checkPendingQuestion(s.id);
  if (resolvedNow) return null;
  return waitingForRule(s.status, !!question);
}

// The newest UNanswered AskUserQuestion in the transcript's tail, or null. The fallback
// /pending-question serves and the digest (#383) reads, so there is one tail rule.
function pendingQuestionFromTranscript(tpath) {
  return transcript.pendingQuestion(transcriptTailText(tpath)); // a pending question is the last tool_use
}

// #271 - type an AskUserQuestion answer with the server doing the pacing. The client
// POSTs the frames it built (`buildAnswerFrames`) ONCE and this process writes them with
// their gaps, so an app pause or a socket reattach mid-answer can no longer cut the
// sequence short. 202 as soon as the frames are accepted, with `ms` (how long the typing
// takes), because the client verifies the answer by polling the question afterwards and
// a request held open for the whole answer would die with the app it is protecting.
// Rules: lib/answer-pace.js. The writes take the socket path's route to the worker.
const _answerPacer = answerPace.createPacer();
app.post('/api/sessions/:id/answer', express.json({ limit: '2mb' }), async (req, res) => {
  const id = req.params.id;
  const v = answerPace.validateAnswer(req.body, WS_INPUT_MAX);
  if (v.error) return res.status(400).json({ error: v.error });
  if (!_HOOK_UUID_RE.test(id)) return res.status(404).json({ error: 'session not found' });
  try { await workerClient.rpc('getSession', { id }); } catch { return res.status(404).json({ error: 'session not found' }); }
  if (_answerPacer.busy(id)) return res.status(409).json({ error: 'an answer is already being typed into this session' });
  const src = deviceOps.clientSource(req);
  const run = _answerPacer.run(id, v.frames, {
    write: (keys) => {
      // Down means the LINK is down. sendPtyIn's return value is the socket write's,
      // and `false` there is Node's "buffer full" signal, the bytes still queued and
      // delivered: a frame over 16 KB returns it, so reading it as "lost" stopped an
      // answer right before its submit keys (the #271 bug again, gate review).
      if (!workerClient.isConnected()) return false;
      try { workerClient.sendPtyIn(id, Buffer.from(keys)); } catch { return false; }
      _lastInputAt.set(id, Date.now()); // #345 - nobody is handed off mid-answer
      if (deviceOps.isSubmitFrame(keys)) { // #311 - counted as the socket path counts it
        deviceOps.recordOp(DEVICE_OPS_FILE, { t: new Date().toISOString(), src, server: getServerName() });
      }
      return true;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  run.then((r) => {
    if (r.stopped) console.error(`[${new Date().toISOString()}] answer to session ${id} stopped after ${r.written}/${v.frames.length} frames: the worker link was down`);
  }, (err) => console.error(`[${new Date().toISOString()}] answer to session ${id} failed: ${err.message}`));
  res.status(202).json({ ok: true, frames: v.frames.length, ms: v.totalMs });
});

/** Session [id]'s pending question on THIS server: `{status, body}`. One builder for the
 *  route and for Mission Control's question context (#510), which reads it in-process. */
async function sessionPendingQuestion(id) {
  // Prefer the LIVE question captured from the PreToolUse hook — it's present
  // while the prompt is on screen, unlike the transcript (which only gets the
  // tool_use after the answer). The transcript scan below stays as a fallback.
  // #423 - unless the transcript already holds its (rejected) tool_result: then the
  // transcript scan below answers, and it finds the question resolved.
  const live = checkPendingQuestion(id).question;
  if (live) return { status: 200, body: { pending: true, question: live } };
  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return { status: 404, body: { error: 'no transcript for session' } };
  try {
    const q = pendingQuestionFromTranscript(tpath);
    return { status: 200, body: q ? { pending: true, question: q } : { pending: false } };
  } catch (e) {
    console.error(`GET /api/sessions/${id}/pending-question failed: ${e.message}`);
    return { status: 500, body: { error: 'Failed to read transcript' } };
  }
}
app.get('/api/sessions/:id/pending-question', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await sessionPendingQuestion(req.params.id);
  res.status(r.status).json(r.body);
});
// Manual verification: fire a sample push (force past the level gate). Returns
// whether ntfy is configured so the UI can tell you if setup is missing.
app.post('/api/notify-test', express.json({ limit: '1kb' }), async (req, res) => {
  const name = req.body?.name ? String(req.body.name).slice(0, 100) : 'Test';
  await pushNotify('approval', { id: 'notify-test', name, reason: 'ntfy test — if you see this on your phone, it works ✅', force: true });
  res.json({ ok: true, configured: !!ntfyConfig() });
});

// --- API: FCM device registry (G1) ---
// The companion app POSTs its FCM token here on startup / onNewToken / foreground
// / network-regain (to every server). Behind the same auth as other API routes.
// Registry file is gitignored; tokens are semi-sensitive and never echoed in full.
app.post('/api/push/devices', express.json({ limit: '8kb' }), (req, res) => {
  // Validation/normalization is pure logic in lib/fcm.js (unit-tested).
  const v = fcm.normalizeDeviceRegistration(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const { token, deviceName, platform } = v.device;
  const devices = loadPushDevices();
  const existing = devices.find(d => d.token === token);
  // Cap the registry so a runaway client can't grow it without bound. Upsert of
  // an existing token is always allowed; a NEW token is refused at the cap.
  if (!fcm.canRegisterDevice(devices.length, !!existing)) {
    return res.status(400).json({ error: `device registry full (max ${fcm.MAX_DEVICES})` });
  }
  if (existing) {
    // Upsert by token: keep the original registeredAt, refresh name/platform.
    existing.deviceName = deviceName;
    existing.platform = platform;
  } else {
    devices.push({ token, deviceName, platform, registeredAt: Date.now() });
  }
  savePushDevices(devices);
  res.json({ ok: true, count: devices.length });
});
app.delete('/api/push/devices/:token', (req, res) => {
  const token = req.params.token;
  const devices = loadPushDevices();
  const idx = devices.findIndex(d => d.token === token);
  if (idx === -1) return res.status(404).json({ error: 'device not found' });
  devices.splice(idx, 1);
  savePushDevices(devices);
  res.json({ ok: true, count: devices.length });
});
app.get('/api/push/devices', (req, res) => {
  res.json(loadPushDevices().map(d => ({
    token: fcm.truncateToken(d.token), // display only — never the full token
    deviceName: d.deviceName || '',
    platform: d.platform || 'android',
    registeredAt: d.registeredAt || null,
  })));
});

// Test-only: drain the FCM sink (captured sends). Registered only under
// WT_FCM_TEST so it can never exist in production. Behind auth (declared here,
// after the auth middleware). Reading clears the sink.
if (process.env.WT_FCM_TEST) {
  app.get('/api/push/test-sink', (req, res) => {
    const items = _FCM_SINK.slice();
    _FCM_SINK.length = 0;
    res.json({ items });
  });
}
// Test-only: drain the ntfy sink (captured ntfy publishes). Registered only under
// WT_NTFY_TEST. Lets an integration test inspect the exact ntfy message body
// (e.g. that includeContent=false omits Claude's content). Behind auth; reading
// clears the sink.
if (process.env.WT_NTFY_TEST) {
  app.get('/api/push/ntfy-test-sink', (req, res) => {
    const items = _NTFY_SINK.slice();
    _NTFY_SINK.length = 0;
    res.json({ items });
  });
}

// --- API: reorder sessions ---
// Body: { orderedIds: string[] } — applied as the new in-memory + on-disk order.
// Idempotent. Unknown ids are silently dropped; live sessions not in the list
// are appended in their existing order (race-safe for concurrent creates).
app.post('/api/sessions/order', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const orderedIds = req.body?.orderedIds;
    if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
    if (orderedIds.length > 1000) return res.status(400).json({ error: 'orderedIds too long' });
    if (!orderedIds.every(id => typeof id === 'string' && id.length <= 64)) {
      return res.status(400).json({ error: 'orderedIds must be strings <= 64 chars' });
    }
    const result = await workerClient.rpc('reorderSessions', { orderedIds });
    invalidateClusterSessionsCache(); // reflect the new order in the sidebar immediately
    res.json(result);
  } catch (e) {
    console.error(`POST /api/sessions/order failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to reorder sessions' });
  }
});

// --- API: kill session ---
/** The ONE way this server ends a local session (#351): kill it in the worker, then drop the
 *  cached cluster list so it leaves the sidebar at once. Everything else a dead session needs
 *  (pins, briefs, sockets, the spawn verdict) is cleaned by the worker's `sessionExited`
 *  event, which every way a session ends goes through. DELETE below and the spawn reaper
 *  both come here. */
async function killLocalSession(id, how = 'closed') {
  // #413 - the exit event that follows reads this to tell a close from a crash.
  _killedHow.set(id, how);
  try { await workerClient.rpc('killSession', { id }); } catch (e) { _killedHow.delete(id); throw e; }
  invalidateClusterSessionsCache(); // removed session must drop from the sidebar immediately
}
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    // Verify session exists before delete so we return 404 properly.
    try { await workerClient.rpc('getSession', { id: req.params.id }); }
    catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    await killLocalSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error(`DELETE /api/sessions failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to kill session' });
  }
});

// --- API: ranged scrollback (browser backfill on scroll-to-top) ---
// Offsets and lengths are in JavaScript string units (UTF-16 code units),
// matching what the worker returns from getScrollback after decoding.
const SCROLLBACK_RANGE_MAX = 524288;
app.get('/api/sessions/:id/scrollback', async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 32768;
  if (limit > SCROLLBACK_RANGE_MAX) limit = SCROLLBACK_RANGE_MAX;
  if (!Number.isFinite(offset)) return res.status(400).json({ error: 'bad offset' });
  try {
    let full;
    try {
      const r = await workerClient.rpc('getScrollback', { id: req.params.id, limit: 4 * 1024 * 1024 });
      // Sanitize identically to the attach replay path so scroll-up backfill
      // can't re-introduce terminal queries (DA/DSR) and so offsets computed
      // here stay consistent with the sanitized initial replay.
      full = sanitizeReplay((r && r.data) || '');
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    const total = full.length;
    const start = Math.min(offset, total);
    const end = Math.min(start + limit, total);
    res.json({ data: full.slice(start, end), total, offset: start, limit: end - start });
  } catch (e) {
    console.error(`GET /api/sessions/:id/scrollback failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read scrollback' });
  }
});

// --- Folder list (live scan of the configured "dev" folders) ---
function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// Returns the folders offered in the New Session dialog. This is a live,
// dynamic scan of the configured scanFolders on every request — no history,
// no memory, no caching. The list always reflects the actual current
// filesystem content, so a folder created/removed under a scan root shows
// up (or disappears) the next time the dialog is opened. Cluster peers each
// serve their own scan against their own disk (the request is proxied per
// server), so switching servers reflects that server's real folders.
app.get('/api/history/folders', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const scanned = new Set();
  for (const baseDir of getScanFolders()) {
    try {
      if (dirExists(baseDir)) scanned.add(baseDir);
      const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'));
      for (const d of dirs) scanned.add(path.join(baseDir, d.name));
    } catch (e) {}
  }
  res.json([...scanned]);
});

// --- Decode Claude project directory name to actual path ---
function decodeProjectPath(project) {
  // e.g. "C--dev-web-terminal" -> try "C:\dev\web-terminal", "C:\dev\web\terminal", etc.
  // Claude's encoder turns both path separators (\) and underscores (_) into hyphens (-),
  // so we must try both joiners when reconstructing the path.
  const driveMatch = project.match(/^([A-Z])-(.*)$/);
  if (!driveMatch) return project.replace(/-/g, '\\');

  const drive = driveMatch[1] + ':\\';
  const rest = driveMatch[2];
  const cleanRest = rest.replace(/^-/, '');

  const parts = cleanRest.split('-');

  let current = drive;
  let i = 0;
  while (i < parts.length) {
    let found = false;
    // Try joining increasingly more parts — check both hyphen and underscore joins
    for (let j = parts.length; j > i; j--) {
      const seg = parts.slice(i, j);
      const candidates = [seg.join('-')];
      if (seg.length > 1) candidates.push(seg.join('_'));
      for (const candidate of candidates) {
        const candidatePath = path.join(current, candidate);
        try {
          if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
            current = candidatePath;
            i = j;
            found = true;
            break;
          }
        } catch (e) {}
      }
      if (found) break;
    }
    if (!found) {
      current = path.join(current, parts[i]);
      i++;
    }
  }
  return current;
}

// --- Claude sessions scanner ---
app.get('/api/claude-sessions', (req, res) => {
  try {
    if (!fs.existsSync(getClaudeProjectsDir())) return res.json([]);

    const projects = fs.readdirSync(getClaudeProjectsDir(), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const customNames = loadClaudeSessionNames();
    const allSessions = [];
    for (const project of projects) {
      const projectDir = path.join(getClaudeProjectsDir(), project);
      // Decode project path: C--dev-my-project -> C:\dev\my_project
      // The encoding is lossy (hyphens in folder names look like path separators),
      // so we try the decoded path and fall back to checking the filesystem.
      const projectPath = decodeProjectPath(project);

      let files;
      try {
        files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const stat = fs.statSync(path.join(projectDir, f));
            return { file: f, id: f.replace('.jsonl', ''), mtime: stat.mtimeMs, size: stat.size };
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 5); // last 5 sessions per project
      } catch (e) { continue; }

      for (const f of files) {
        // Skip tiny files (< 1KB) — likely empty or failed sessions
        if (f.size < 1024) continue;

        // Skip sessions older than 14 days — unlikely to resume
        if (Date.now() - f.mtime > 14 * 24 * 60 * 60 * 1000) continue;

        // Read first user message as summary, verify session has assistant response
        let summary = '';
        let hasUserMessage = false;
        let hasAssistantResponse = false;
        let permissionMode = '';
        let sessionTitle = '';
        try {
          const lines = fs.readFileSync(path.join(projectDir, f.file), 'utf8').split('\n');
          for (const line of lines.slice(0, 80)) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            if (obj.permissionMode && !permissionMode) permissionMode = obj.permissionMode;
            if (obj.slug && !sessionTitle) sessionTitle = obj.slug.replace(/-/g, ' ');
            if (obj.type === 'user' && obj.message?.content && !hasUserMessage) {
              hasUserMessage = true;
              summary = typeof obj.message.content === 'string'
                ? obj.message.content.substring(0, 120)
                : JSON.stringify(obj.message.content).substring(0, 120);
            }
            if (obj.type === 'assistant') hasAssistantResponse = true;
            if (hasUserMessage && hasAssistantResponse && permissionMode && sessionTitle) break;
          }
        } catch (e) {}

        // Skip sessions with no real conversation
        if (!hasUserMessage || !hasAssistantResponse) continue;

        allSessions.push({
          id: f.id,
          project,
          projectPath,
          sessionTitle: customNames[f.id] || sessionTitle || '',
          summary: summary.replace(/[\n\r]+/g, ' ').trim(),
          lastModified: f.mtime,
          sizeKB: Math.round(f.size / 1024),
          skipPermissions: permissionMode === 'bypassPermissions'
        });
      }
    }

    // Sort all by last modified, return top 20
    allSessions.sort((a, b) => b.lastModified - a.lastModified);
    res.json(allSessions.slice(0, 20));
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: delete a claude session file ---
app.delete('/api/claude-sessions/:project/:id', (req, res) => {
  // Sanitize to prevent path traversal
  const project = path.basename(req.params.project);
  const id = path.basename(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(getClaudeProjectsDir(), project, id + '.jsonl');
  // Verify the resolved path is still under getClaudeProjectsDir()
  if (!path.resolve(file).startsWith(path.resolve(getClaudeProjectsDir()))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return res.json({ ok: true });
    }
    res.status(404).json({ error: 'not found' });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: rename a claude session ---
app.patch('/api/claude-sessions/:id', express.json(), (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const names = loadClaudeSessionNames();
  names[id] = name;
  saveClaudeSessionNames(names);
  res.json({ ok: true });
});

// --- API: export a claude session file (for transfer) ---
app.get('/api/claude-sessions/:project/:id/export', (req, res) => {
  const project = path.basename(req.params.project);
  const id = path.basename(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(getClaudeProjectsDir(), project, id + '.jsonl');
  if (!path.resolve(file).startsWith(path.resolve(getClaudeProjectsDir()))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
    const content = fs.readFileSync(file, 'utf8');
    res.json({ project, id, content, size: content.length });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: import a claude session file (from transfer) + optionally create terminal session ---
app.post('/api/claude-sessions/import', express.json({ limit: '50mb' }), async (req, res) => {
  const { project, id, content, autoResume, name, skipPermissions } = req.body || {};
  if (!project || !id || !content) {
    return res.status(400).json({ error: 'Missing project, id, or content' });
  }
  const safeProject = path.basename(String(project));
  const safeId = path.basename(String(id)).replace(/[^a-zA-Z0-9_-]/g, '');
  const projectDir = path.join(getClaudeProjectsDir(), safeProject);
  const file = path.join(projectDir, safeId + '.jsonl');
  if (!path.resolve(file).startsWith(path.resolve(getClaudeProjectsDir()))) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[${new Date().toISOString()}] Imported claude session ${safeProject}/${safeId} (${content.length} bytes)`);

    // Optionally create a terminal session to resume this claude session
    const held = autoResume ? maintRefusal() : null;
    if (held) return res.status(503).json({ imported: true, ...held });
    if (autoResume) {
      const projectPath = decodeProjectPath(safeProject);
      let cwd = projectPath;
      try { if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) cwd = getDefaultCwd(); } catch (e) { cwd = getDefaultCwd(); }
      let cmd = 'claude --resume ' + safeId;
      if (skipPermissions) cmd += ' --dangerously-skip-permissions';
      const sessionId = crypto.randomUUID();
      const sessionName = String(name || projectPath.split(path.sep).filter(Boolean).pop() || 'Transferred');
      await workerClient.rpc('createSession', {
        id: sessionId, cwd, name: sessionName.substring(0, 100), autoCommand: cmd,
      });
      journalAppend(journalLib.openedRecord({ id: sessionId, at: Date.now(), via: 'import', name: sessionName, cwd, agent: 'claude' })); // #466
      return res.json({ ok: true, sessionId, name: sessionName });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message); res.status(500).json({ error: 'Internal error' });
  }
});

// --- API: restart server ---
app.post('/api/restart', (req, res) => {
  res.json({ ok: true, message: 'Restarting...' });
  console.log(`[${new Date().toISOString()}] Restart requested via API`);
  setTimeout(async () => {
    try { await workerClient.rpc('flushState'); } catch (e) {}
    const { execSync } = require('child_process');
    // Pull latest code before restarting. Hardened so a broken HTTPS remote
    // credential can't hang git-credential-manager and leak process trees.
    try { execSync(`git ${gitSafeArgs(['pull', '--ff-only']).join(' ')}`, { cwd: __dirname, timeout: 15000, windowsHide: true, env: gitSafeEnv() }); } catch (e) {
      console.error(`[${new Date().toISOString()}] git pull failed: ${e.message}`);
    }
    // Use PM2 if available, otherwise fallback to spawn
    try {
      execSync('pm2 restart web-terminal', { cwd: __dirname, timeout: 10000, windowsHide: true });
    } catch (e) {
      // PM2 not available — fallback to old spawn method
      const { spawn } = require('child_process');
      const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true
      });
      child.unref();
      process.exit(0);
    }
  }, 500);
});

// --- Landing page ---
// Serve app.html with cache-busting headers AND a server-version stamp so the
// client can tell if it's running stale JS. Without these, browsers used
// heuristic freshness (~10% of file age) and held an old app.html for minutes
// even after a deploy + click-the-refresh-button.
function _readAppHtml() {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8'); }
  catch { return null; }
  // Replace the CLIENT_VERSION placeholder with the live server version so the
  // toolbar shows the actual deployed app revision, not a hardcoded constant.
  return html.replace(
    /const CLIENT_VERSION = '[^']*';/,
    `const CLIENT_VERSION = '${SERVER_VERSION}';`
  );
}
function _serveApp(req, res) {
  const html = _readAppHtml();
  if (!html) return res.status(500).send('app.html unreadable');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
app.get('/', _serveApp);
app.get('/app', _serveApp);
app.get('/app/:id', _serveApp);
// #178: the content-anchored scrollback walk, served to app.html as the SAME
// bytes tests/scrollback-window.spec.js runs against. Pasting the rule into the
// page instead would make a second copy of it, which is the defect this rule was
// written to stop. It sits after the blanket auth middleware, so it is behind
// cookie/bearer auth like every other page route, and is served no-cache for the
// same reason app.html is — a stale copy of a paging rule desynchronises the
// client from the server's byte space silently.
app.get('/lib/scrollback-window.js', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.sendFile(path.join(__dirname, 'lib', 'scrollback-window.js'));
});
app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'lobby.html'));
});

// --- Terminal page: REDIRECTED to the gated client (#218) ---
//
// This used to serve `terminal.html`, the legacy terminal-only view. That page was the
// THIRD client writing user input to a session socket and the only one that neither
// gated at `WS_INPUT_MAX` (#204 closed the companion, #206 closed app.html) nor rendered
// the server's own `inputDropped` frame — it had no notice UI to render one in, and its
// handler read `if (e.data.startsWith('{"inputDropped"')) return;`. #200 was right to
// stop printing raw JSON into the terminal, but "do not print it" became "throw it
// away". So there a >256KB paste was refused by the server and reported to NOBODY, and a
// >4MiB paste closed the socket with nobody told why — exactly the silence #193 exists
// to end.
//
// Gating it would have meant building a notice UI on a page nothing links to, and would
// have made a second diverging copy of the input path more worth keeping. Redirecting
// closes the band in one route and costs no bookmark.
//
// AND IT ADDS CAPABILITY RATHER THAN LOSING ANY, which is the opposite of what #218
// assumed. `terminal.html` has no cluster code at all: its socket is always
// `location.host` + `/ws/<id>`, so it could never reach a session on a peer. Worse, the
// `getSession` RPC this route used to gate on is answered by the LOCAL worker only, so a
// peer-hosted id threw and sent the user to `/`. `app.html` resolves the same bare
// `/app/:id` against `/api/cluster/sessions` and opens the peer through the
// `/cluster/:serverUrl/ws/:id` proxy — so an /s/ link reaches a peer session for the
// first time.
//
// The existence check is therefore gone on purpose, not lost: deciding locally that an
// id does not exist is the bug. app.html resolves it, and falls back to a real session
// when it genuinely cannot.
//
// 302, NOT 301: a permanent redirect is cached by browsers indefinitely, which would
// turn reverting this into a support problem rather than a one-line change.
//
// `encodeURIComponent` rather than validation — it escapes `/` and CR/LF, so the id
// cannot escape the path or terminate the header, and there is no accept-list to keep in
// step with whatever express happens to route.
app.get('/s/:id', (req, res) => {
  res.redirect(302, '/app/' + encodeURIComponent(req.params.id));
});

// --- WebSocket: global notifications (all sessions) ---
app.ws('/ws/notify', (ws, req) => {
  if (!authenticateWs(ws, req)) return;
  notifyClients.add(ws);
  ws._wtAlive = true;
  ws.on('pong', () => { ws._wtAlive = true; });
  ws.on('error', () => { notifyClients.delete(ws); });
  ws.on('close', () => notifyClients.delete(ws));
});

// --- WebSocket: attach to session ---
app.ws('/ws/:id', (ws, req) => {
  if (!authenticateWs(ws, req, { expectedSid: req.params.id })) return;
  const id = req.params.id;

  // Disable Nagle — send each PTY output chunk immediately
  if (ws._socket) ws._socket.setNoDelay(true);

  const clientsSet = getSessionClients(id);
  setAttaching(id, ws, true); // #351 - counted as a viewer by the spawn reaper until it is attached (or gone)
  let attached = false;
  const pendingMessages = []; // messages received before attach completes

  // Set up message/close handlers IMMEDIATELY so early mode messages aren't dropped.
  ws._wtAlive = true;
  ws._wtBackground = true;   // default until mode message arrives
  ws._wtBrowserId = null;
  ws._wtSrc = deviceOps.clientSource(req); // #311 - the device behind this socket
  ws.on('pong', () => { ws._wtAlive = true; });
  ws.on('error', (err) => {
    console.error(`[${new Date().toISOString()}] WS error session ${id}: ${err.message}`);
  });

  function handleMessage(msg) {
    if (Buffer.isBuffer(msg)) msg = msg.toString();
    // Input the server refuses must never leave without a trace. A prompt that is
    // dropped here looks, from the user's chair, exactly like one that was typed and
    // ignored — and a silent drop is unprovable after the fact, which is precisely
    // what made "my long prompt arrived cut" so expensive to diagnose. It logged
    // server-side only until #193: the client got nothing back, so the refusal was
    // undiagnosable from the chair. Echoed back on THIS socket — the `sessionTaken`
    // convention already used on /ws/:id — because the socket that produced the
    // oversized write is exactly the one attached to it; no session id needed.
    //
    // #201 — the cap is `WS_INPUT_MAX` (256 KB), NOT the 65536 this line carried from
    // commit a96e7ba (2026-03-23). That number was an inherited default: no
    // measurement, no rationale, and the tightest limit anywhere on the path. It is
    // now half of a stated pair — see the WS_INPUT_MAX / WS_MAX_PAYLOAD block above
    // for the arithmetic, and the companion's `_inputBufferHardCap` for the other
    // end. The three move together or the invariant they encode is gone.
    //
    // `bytes:` on the wire is UTF-16 code units, not bytes. The name is kept because
    // the companion and app.html both read that field; only the label is wrong.
    if (msg.length > WS_INPUT_MAX) {
      console.error(`[${new Date().toISOString()}] WS input DROPPED session ${id}: ${msg.length} UTF-16 code units exceeds the ${WS_INPUT_MAX} cap`);
      try { ws.send(JSON.stringify({ inputDropped: true, bytes: msg.length })); } catch {}
      return;
    }
    if (msg.charCodeAt(0) === 0x7B) {
      if (msg.startsWith('{"heartbeat":')) { ws._wtAlive = true; return; }
      if (msg.startsWith('{"resize":')) {
        if (ws._wtBackground) return;
        try {
          const { resize } = JSON.parse(msg);
          const cols = Math.max(1, Math.min(500, parseInt(resize.cols) || 80));
          const rows = Math.max(1, Math.min(200, parseInt(resize.rows) || 24));
          // #146 — this socket's own window, not the PTY's size. What the PTY runs at
          // is negotiated across every attached viewer (lib/terminal-size.js), because
          // applying each message directly made the size last-writer-wins: a desktop
          // relaying out (window resize, sidebar toggle, compose bar growing) stole the
          // columns back from a phone seconds after it attached, and the phone then
          // wrapped a 120-column frame into 52. That IS #146.
          ws._wtCols = cols;
          ws._wtRows = rows;
          applyNegotiatedSize(id);
        } catch (e) {}
        return;
      }
      if (msg.startsWith('{"mode":')) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.mode === 'active' || parsed.mode === 'background') {
            if (!liveConfig('keepSessionsOpen', true) && parsed.mode === 'background') {
              ws.close(4002, 'keepSessionsOpen disabled');
              return;
            }
            const browserId = typeof parsed.browserId === 'string' ? parsed.browserId.slice(0, 64) : null;
            ws._wtBrowserId = browserId;
            const wasBackground = ws._wtBackground;

            if (parsed.mode === 'active') {
              ws._wtBackground = false;
              spawnStore.noteViewed(id); // #351 - an active viewer is a person looking at it
              // #146 — a viewer that just became active gets a vote in the size, and
              // needs a repaint whether or not its vote changed the answer.
              applyNegotiatedSize(id, { nudge: true });
              // #21: by default, multiple devices share one PTY (shared I/O) —
              // opening a session on a second device no longer force-disconnects
              // the first. There is a single PTY that echoes once and broadcasts
              // to every attached viewer, so there is no double-echo; input from
              // any active viewer is written to that one PTY. Set
              // `exclusiveViewer: true` to restore the old single-owner takeover
              // (kick every other active viewer with a different browserId).
              if (liveConfig('exclusiveViewer', false)) {
                const kickMsg = JSON.stringify({ sessionTaken: getServerName() });
                for (const existing of clientsSet) {
                  if (existing === ws) continue;
                  if (existing._wtBrowserId === browserId && existing._wtBackground) continue;
                  if (existing._wtBackground) continue;
                  if (existing._wtBrowserId !== browserId) {
                    try { existing.send(kickMsg); } catch (e) {}
                    try { existing.close(4001, 'Session opened elsewhere'); } catch (e) {}
                  }
                }
              }
            } else {
              if (!ws._wtBackground) spawnStore.noteViewed(id); // #351 - the last time it was looked at
              ws._wtBackground = true;
              // #146 — ...and one that backgrounded loses it, so a phone left open in a
              // pocket stops holding a desktop session at phone width.
              applyNegotiatedSize(id);
            }
            if (ws._wtBackground !== wasBackground) logView('mode', ws, id); // #425 - only a real switch
          }
        } catch (e) {}
        return;
      }
    }
    if (ws._wtBackground) {
      // A background viewer is not supposed to send input at all, so this is either a
      // client bug or a mode/input race — and dropping it mutely turns either one into
      // "the agent ignored me". Logged once per socket so a stuck client is visible
      // without flooding the log with every keystroke behind it.
      if (!ws._wtBgDropLogged) {
        ws._wtBgDropLogged = true;
        console.error(`[${new Date().toISOString()}] WS input DROPPED session ${id}: socket is in background mode (${msg.length} bytes, further drops on this socket not logged)`);
      }
      return;
    }
    // Send keystrokes as a TYPE_PTY_IN binary frame (no per-keystroke RPC).
    try {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      workerClient.sendPtyIn(id, buf);
      // #345 - nobody is handed off mid-keystroke. #470 - a terminal's own replies (focus,
      // cursor reports) are not a person typing: an attached viewer would hold every gate.
      const typed = buf.toString('utf8');
      if (!ansiLib.onlyTerminalReports(typed)) {
        _lastInputAt.set(id, Date.now());
        noteComposerInput(id, typed); // #479 - what is left unsent in the composer
      }
    } catch {}
    // #311 - one line per submit: who sent it, never what. After every refusal above,
    // so a dropped frame is not counted as an operation.
    if (deviceOps.isSubmitFrame(msg)) {
      deviceOps.recordOp(DEVICE_OPS_FILE, { t: new Date().toISOString(), src: ws._wtSrc, server: getServerName() });
    }
  }

  ws.on('message', (msg) => {
    if (!attached) {
      // #351 - a viewer's `active` frame is a view the moment it ARRIVES, not when the worker
      // attach it queues behind completes: the companion can spend 20 s refreshing its list and
      // 20 s reading scrollback before it declares itself, and a slow attach comes on top.
      // Only an `active` frame counts - a background / keepOpen socket is not a person.
      if (spawnReaper.isActiveModeFrame(msg)) spawnStore.noteViewed(id);
      pendingMessages.push(msg);
      return;
    }
    handleMessage(msg);
  });

  let closedEarly = false;
  ws.on('close', () => {
    closedEarly = !attached;
    if (attached) logView('detach', ws, id, { ms: Date.now() - ws._wtAttachedAt }); // #425
    setAttaching(id, ws, false);
    clientsSet.delete(ws);
    if (attached && !ws._wtBackground) spawnStore.noteViewed(id); // #351 - an active viewer left
    if (attached) {
      workerClient.rpc('detachSession', { id }).catch(() => {});
    }
    // #146 — the narrow viewer may have just left; give the others their columns back.
    applyNegotiatedSize(id);
    releasePtyOutSubscription(id);
    console.log(`[${new Date().toISOString()}] Client left session ${id} (${clientsSet.size} clients)`);
  });

  // Attach to the worker session (also verifies existence). Returns scrollback.
  (async () => {
    let attachRes;
    try {
      attachRes = await workerClient.rpc('attachSession', { id, scrollbackLimit: getScrollbackReplayLimit() });
    } catch (e) {
      try { ws.close(4000, 'Session ended'); } catch {}
      return;
    }
    // #479 - before the closed-early check below and the frames queued during the attach.
    await learnComposerAgent(id);
    if (closedEarly || ws.readyState !== 1) {
      try { await workerClient.rpc('detachSession', { id }); } catch {}
      return;
    }

    // Send scrollback as a single chunk
    try {
      let full = attachRes.scrollback || '';
      if (full.length) {
        // Strip replay-unsafe sequences: erase-display, alt-screen toggles, and
        // — critically — terminal queries (DA/DSR). Replaying a stale DA query
        // makes xterm answer "ESC[?1;2c" into an idle shell, leaving "1;2c"
        // garbage on the prompt. See lib/replay-sanitize.js.
        full = sanitizeReplay(full);
        ws.send(full);
      }
    } catch (e) {}

    const keepOpen = liveConfig('keepSessionsOpen', true);
    if (keepOpen) {
      // ws._wtBackground is already true — stays until mode message arrives
    } else {
      // Legacy exclusive viewer: kick existing viewers before adding the new one
      if (clientsSet.size > 0) {
        const kickMsg = JSON.stringify({ sessionTaken: getServerName() });
        for (const existing of clientsSet) {
          try { existing.send(kickMsg); } catch {}
          try { existing.close(4001, 'Session opened elsewhere'); } catch {}
        }
        clientsSet.clear();
        console.log(`[${new Date().toISOString()}] Kicked previous viewers from session ${id}`);
      }
      // In legacy mode, treat all connections as active (no background)
      ws._wtBackground = false;
      spawnStore.noteViewed(id); // #351
    }

    clientsSet.add(ws);
    setAttaching(id, ws, false);
    ensurePtyOutSubscription(id);
    attached = true;
    ws._wtAttachedAt = Date.now();
    logView('attach', ws, id); // #425
    console.log(`[${new Date().toISOString()}] Client joined session ${id} (${clientsSet.size} client(s)${keepOpen ? ', keepOpen' : ', exclusive'})`);

    // Drain pending messages that arrived during attach.
    for (const m of pendingMessages) {
      try { handleMessage(m); } catch {}
    }
    pendingMessages.length = 0;
  })();
});

// --- Graceful shutdown: flush worker state before exit ---
async function gracefulShutdown(signal) {
  console.log(`[${new Date().toISOString()}] ${signal} received — flushing worker state...`);
  try { await workerClient.rpc('flushState'); } catch {}
  // Land any status reports still inside the write debounce, so a restart never
  // costs an idle session the last reading it will ever push (#72).
  try { flushClaudeMetrics(); } catch {}
  // The listing's worker thread (#366): terminates it and answers a call in flight. It cannot
  // interrupt a native CreateProcessW already running inside the thread, and Node joins worker
  // threads on exit, so a shutdown that lands during a blocked spawn waits that spawn out.
  try { if (_backgroundListingExec) _backgroundListingExec.dispose(); } catch {}
  // The digest runs (#383) this process spawned: killed by the handles recorded at spawn.
  try { digestService.shutdown(); } catch {}
  // #505 - a stage advance still inside the state file's write debounce.
  try { mcState.flush(); } catch {}
  // Mission Control Ask runs (#511), the same way.
  try { mcAnalystService.shutdown(); } catch {}
  // The check-in pre-check's run (#540), the same way.
  try { checkInPrecheckService.shutdown(); } catch {}
  console.log(`[${new Date().toISOString()}] Exiting.`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
if (process.platform === 'win32') {
  process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

const HOST = process.env.WT_HOST || config.host || '127.0.0.1';

// Connect to the worker before starting the HTTP server.
// If the worker isn't ready after ~12 seconds, exit with code 1 so monitor restarts.
(async () => {
  try {
    await workerClient.connect(WORKER_PIPE_PATH, { maxAttempts: 60, delayMs: 200 });
    console.log(`Connected to pty-worker at ${WORKER_PIPE_PATH}`);
  } catch (e) {
    console.error(`FATAL: could not connect to pty-worker: ${e.message}`);
    process.exit(1);
  }

  const server = app.listen(PORT, HOST, () => {
    // #425 - a process that exits (or crashes) leaves its viewers' `attach` lines with no `detach`;
    // this marks where one server run ended and the next began, so analysis can close them.
    usageLog.appendRecord(DEVICE_VIEWS_FILE, { t: new Date().toISOString(), event: 'start', server: getServerName() });
    console.log(`Web Terminal running at http://${HOST}:${PORT}`);
    console.log(`Sessions: http://${HOST}:${PORT}/`);
    console.log(`Auth: ${_USER}:***`);
    if (needsPasswordChange()) {
      console.log('\x1b[33m⚠  DEFAULT PASSWORD IN USE — you will be prompted to change it on first login\x1b[0m');
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use — another instance is likely running. Exiting.`);
      process.exit(2);
    }
    throw err;
  });
})();
