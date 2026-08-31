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
const { scanBackgroundTasks } = require('./lib/background-tasks');
const { execGit, gitSafeArgs, gitSafeEnv } = require('./lib/git-safe');
const notifyPush = require('./lib/notify-push');
const transcript = require('./lib/transcript');
const processTree = require('./lib/process-tree');
const speech = require('./lib/speech');
const agentsLib = require('./lib/agents');
const commandsLib = require('./lib/commands');
const { getAdapter } = agentsLib;
const { rollUpUsage, METRICS_TTL_MS } = require('./lib/usage-rollup');
const resourcesLib = require('./lib/resources');
const { waitingFor: waitingForRule } = require('./lib/waiting-for');
const taskListLib = require('./lib/task-list');
const usageLimit = require('./lib/usage-limit');
const notificationShape = require('./lib/notification-shape');
// #146 — the pure smallest-active-viewer-wins rule for one PTY with many viewers.
const terminalSize = require('./lib/terminal-size');
const recap = require('./lib/recap');
const { parseStatusPayload, mergeStatus, hasReading } = require('./lib/metrics-claude');
const fcm = require('./lib/fcm');

const SERVER_VERSION = '1.72.4'; // 2026-08-31: #193 - three silent input-loss defects fixed. (1) the companion's offline compose buffer (ai-terminal/lib/api/api_client.dart _bufferInput) evicted a paste already over its 8KB cap the instant ANY later write queued behind it, because the guard only ever protected the SOLE remaining write rather than the one that mattered - a write over the cap alone is now never a candidate for eviction. (2) sticky Ctrl/Alt (session_screen.dart _onComposeChanged) read only the FIRST character of a multi-character insertion (a paste, including the key strip's own Paste button) as a control code and silently discarded the rest, restoring the field to what it was before - now only a single-character insertion is consumed; anything wider passes through untouched. (3) the server's 64KB WS input cap (handleMessage) refused an oversized frame with a server-side log only and nothing to the client - it now echoes a bare {inputDropped:true,bytes:N} frame back on the SAME socket (the sessionTaken convention), surfaced as a compose-bar notice in app.html and a SnackBar in the companion.

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
// Stale status auto-correction now lives in pty-worker.js.

// --- Config: config.json > env vars > defaults ---
// Use separate config file during tests to avoid corrupting production config
const CONFIG_FILE = process.env.WT_TEST ? path.join(__dirname, 'config.test.json') : path.join(__dirname, 'config.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, 'config.default.json');

function readConfig() {
  try { return fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {}; } catch (e) { return {}; }
}
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
async function agentProcessStartMs(s) {
  try {
    const exeName = agentsLib.processNameFor(s && s.agent);
    if (!exeName || !s.pid) return null;
    const procs = await processTree.snapshot();
    if (!procs) return null;
    const proc = processTree.newestDescendantNamed(procs, s.pid, exeName);
    return proc && Number.isFinite(proc.startMs) ? proc.startMs : null;
  } catch { return null; }
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
    const session = {
      cwd: s.cwd,
      agentSessionId: s.claudeSessionId || null,
      // The exact answer when the session's own Codex has reported it; the provider
      // prefers it over any cwd-based guess.
      conversationId: _codexOwnership.get(id) || null,
      // Conversations owned by OTHER sessions, so a session without its own reported id
      // is never handed a neighbour's by mtime.
      claimedIds: claimedConversationsExcept(id),
      processStartMs: await agentProcessStartMs(s),
    };
    // An agent recorded on the session is an explicit user choice — honour it and do
    // NOT fall through to another provider. Only a session with no recorded agent
    // (plain shell) gets cross-provider discovery.
    const explicit = agentsLib.isKnownAgent(s.agent);
    const preferred = explicit ? s.agent : agentsLib.DEFAULT_AGENT;
    return agentsLib.resolveTranscriptFor(session, preferred, transcriptIoFor, safeTranscriptPath, { discover: !explicit });
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
      Date.now() - (st.transcriptAt || 0) > DISCOVERED_TRANSCRIPT_TTL_MS) {
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
  try {
    const size = fs.statSync(tpath).size;
    const start = Math.max(0, size - 262144); // 256KB tail
    const len = size - start;
    if (len <= 0) return new Set();
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(tpath, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    let text = buf.toString('utf8');
    if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    return transcript.collectResolvedIds(text);
  } catch { return new Set(); }
}

const CLUSTER_TOKENS_FILE = path.join(__dirname, 'cluster-tokens.json');
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

const app = express();
const wsInstance = expressWs(app, null, {
  wsOptions: { perMessageDeflate: false }
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

function ntfyConfig() {
  const c = liveConfig('ntfy', null);
  if (!c || c.enabled === false || !c.topic) return null;
  return { server: String(c.server || 'https://ntfy.sh').replace(/\/+$/, ''), topic: String(c.topic) };
}
// Tests capture pushes instead of hitting the network.
const _NTFY_SINK = process.env.WT_NTFY_TEST ? [] : null;

// --- FCM transport + device registry (G1/G2) ------------------------------
// Content-free data-only wake messages (see COMPANION-APP-DESIGN.md). The pure
// message/JWT/token-cache logic lives in lib/fcm.js; server.js owns the registry
// file, the service-account read, and the fire-and-forget dispatch.
const PUSH_DEVICES_FILE = path.join(__dirname, 'push-devices.json');
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
async function fcmDispatch(kind, { id, click }) {
  if (!fcm.providerSendsFcm(pushProvider())) return;
  const devices = loadPushDevices();
  if (!devices.length) return;
  const ts = Date.now();
  const client = getFcmClient(); // null in sink mode
  for (const dev of devices.slice()) {
    const body = fcm.buildFcmMessage(kind, {
      serverName: getServerName(), sessionId: id, ts, deepLink: click || '', token: dev.token,
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

  const provider = pushProvider();
  const click = sessionClickUrl(id);
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
    const detail = includeContent ? transcript.lastAssistantText(_nstate(id).transcriptPath) : '';
    const msg = notifyPush.buildNtfyMessage(kind, { sessionName: name, serverName: getServerName(), reason, click, detail });
    if (_NTFY_SINK) { _NTFY_SINK.push({ kind, id, ...msg }); }
    else if (cfg) {
      try {
        await fetch(cfg.server, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: cfg.topic, title: msg.title, message: msg.message, priority: msg.priority, tags: msg.tags, click: msg.click }),
        });
      } catch (e) { console.error('ntfy push failed:', e.message); }
    }
  }
  // FCM: content-free wake to every registered device (fire-and-forget). Gated
  // here so fcm-absent (ntfy-only) mode skips the device load + async hop.
  if (fcm.providerSendsFcm(provider)) {
    fcmDispatch(kind, { id, click }).catch(e => console.error('FCM dispatch failed:', e.message));
  }
}

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
});

workerClient.on('sessionExited', ({ id }) => {
  // ntfy: drop any pending timers + stored level for the dead session.
  const nst = _notifyState.get(id);
  if (nst) { if (nst.idleTimer) clearTimeout(nst.idleTimer); if (nst.apiErrTimer) clearTimeout(nst.apiErrTimer); _notifyState.delete(id); }
  pruneNotifyPref(id);
  pruneFavorite(id);   // #60: a dead session leaves no pin behind
  pruneAutoResumePref(id); // #137: and no auto-resume opt-out either
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
function isLocalhostReq(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
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
      const candidates = Object.keys(apiTokens).filter(k => {
        const entry = apiTokens[k];
        return !(entry && entry.expires && Date.now() > entry.expires);
      });
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
const API_TOKENS_FILE = path.join(__dirname, 'api-tokens.json');

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
  if (entry.expires && Date.now() > entry.expires) {
    delete tokens[token];
    saveApiTokens(tokens);
    return false;
  }
  return true;
}

function createApiToken(label) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokens = loadApiTokens();
  tokens[token] = {
    label: label || 'cluster',
    created: Date.now(),
    expires: Date.now() + 90 * 24 * 60 * 60 * 1000 // 90 days
  };
  saveApiTokens(tokens);
  return token;
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
// (permission_prompt, idle_prompt, auth_success, elicitation_dialog) maps to the
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
  // or the next (different) tool.
  const _tool = body && body.tool_name;
  // #98 — TRI-STATE, and the third state is the whole point: `undefined` means
  // "this event says nothing about a question", which is NOT the same as "there
  // is no question". Only the two branches below actually learn something, so
  // only they speak. Everything else (a Notification, another tool's PostToolUse,
  // SubagentStop…) leaves the worker's flag alone. See the send site.
  let questionSignal;
  if (rawEvent === 'PreToolUse' && _tool === 'AskUserQuestion') {
    const questions = transcript.shapeQuestions(body.tool_input);
    if (questions.length) {
      _nstate(id).pendingQuestion = { toolUseId: `hook-${id}-${seq}`, questions };
      questionSignal = true;
    }
  } else if (
    (rawEvent === 'PostToolUse' && _tool === 'AskUserQuestion') ||
    rawEvent === 'PreToolUse' || // a different tool started → prior question resolved
    rawEvent === 'UserPromptSubmit' ||
    rawEvent === 'Stop'
  ) {
    const ns = _notifyState.get(id);
    if (ns && ns.pendingQuestion) ns.pendingQuestion = null;
    // Say `false` even when this process held no question: these events resolve
    // one by definition, so this is real evidence, not the absence of it. It is
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

  // #61 — `agent_id` is present iff Claude raised this event INSIDE a subagent
  // (verified against the real hook stream: SubagentStart/SubagentStop and a
  // subagent's own PreToolUse/PostToolUse carry it; the main agent's events —
  // Stop, UserPromptSubmit, and its own tool calls — never do). The worker needs
  // it to tell "the main agent resumed" from "a subagent is calling a tool", so
  // pass it straight through. This layer still decides nothing.
  const agentId = (body && typeof body.agent_id === 'string' && body.agent_id) ? body.agent_id : undefined;

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

app.post('/api/hook', express.json({ limit: '256kb' }), async (req, res) => {
  if (!isLocalhostReq(req) && !verifyHookToken(req.headers['x-wt-hook-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const id = req.headers['x-wt-session-id'];
  if (!id) return res.json({ ok: true, skipped: 'no session ID' });
  const event = req.body?.hook_event_name || req.body?.event;
  const claudeSessionId = req.body?.session_id;
  try {
    const result = await processHookEvent(id, event, claudeSessionId, req.body);
    res.json({ ok: true, status: result.status, ...(result.skipped ? { skipped: result.skipped } : {}), ...(result.deferred ? { deferred: result.deferred } : {}) });
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
    const result = await processHookEvent(req.params.id, event, claudeSessionId, req.body);
    res.json({ ok: true, status: result.status, ...(result.skipped ? { skipped: result.skipped } : {}), ...(result.deferred ? { deferred: result.deferred } : {}) });
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
  });
}

// The metrics for one session, from whichever source its agent provides. Claude's
// pushed status line wins when present (it is live and richer); otherwise an agent
// that records its own usage has it read from the transcript. A plain shell (agent
// null → the default provider, which has no readMetrics) never triggers a file read.
async function sessionMetrics(s) {
  const pushed = getStatusMetrics(s.claudeSessionId);
  if (pushed) { armResetTimerFromMetrics(s.id, pushed); return pushed; }
  const adapter = getAdapter(s.agent);
  if (typeof adapter.readMetrics !== 'function') return null;

  const missedAt = _metricsMiss.get(s.id);
  if (missedAt && Date.now() - missedAt < _metricsMissTtlMs) return null;

  const tpath = await resolveSessionTranscriptPath(s.id);
  if (!tpath) { _metricsMiss.set(s.id, Date.now()); return null; }
  _metricsMiss.delete(s.id);
  const metrics = readTranscriptMetrics(tpath, adapter);
  armResetTimerFromMetrics(s.id, metrics);
  return metrics;
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
// change — server-only, hot-reloadable. Cached on the transcript's SIZE: the file only
// ever grows, so an unchanged size means an unchanged answer and the poll costs one
// stat instead of a 256KB read.
const _bgTasksCache = new Map(); // session id -> { path, size, tasks, checkedAt }
const BG_TASKS_TAIL = 262144; // 256KB — same window the pending-question scan uses
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
  return tasks.filter(t => !t.startedAt || (now - t.startedAt) < BG_TASKS_MAX_AGE_MS);
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
    const procs = await processTree.snapshot();
    if (!procs) return []; // non-Windows, or the query failed — "cannot tell"
    return processTree.runningShellsUnder(procs, s.pid);
  } catch {
    return [];
  }
}

async function sessionBackgroundTasks(s) {
  if (!agentsLib.hasBackgroundTasksInTranscript(s.agent)) return [];
  try {
    const tpath = await resolveSessionTranscriptPath(s.id);
    if (!tpath) return [];
    const hit = _bgTasksCache.get(s.id);
    const now = Date.now();
    if (hit && hit.path === tpath && (now - hit.checkedAt) < BG_TASKS_MIN_INTERVAL_MS) {
      return freshBackgroundTasks(hit.tasks);
    }
    const size = fs.statSync(tpath).size;
    if (hit && hit.path === tpath && hit.size === size) {
      hit.checkedAt = now;
      return freshBackgroundTasks(hit.tasks);
    }

    const start = Math.max(0, size - BG_TASKS_TAIL);
    const len = size - start;
    let text = '';
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(tpath, 'r');
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      text = buf.toString('utf8');
      // Drop the partial first line a tail always starts with.
      if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    }
    // Cache what the TRANSCRIPT says, unfiltered: the entry outlives many polls, so
    // baking a moment's freshness verdict into it is what froze the badge before.
    const tasks = scanBackgroundTasks(text);
    _bgTasksCache.set(s.id, { path: tpath, size, tasks, checkedAt: Date.now() });
    return freshBackgroundTasks(tasks);
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
  return shells.map((sh) => ({
    id: 'proc-' + sh.pid,
    description: 'shell command',
    startedAt: null,
  }));
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

  // Hash and save
  const hashed = hashPassword(password);
  const cfg = readConfig();
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
  current.scrollbackReplayLimit = current.scrollbackReplayLimit || getScrollbackReplayLimit();
  current.cluster = current.cluster || [];
  current.publicUrl = current.publicUrl || '';
  current.claudeHome = current.claudeHome || '';
  current.keepSessionsOpen = current.keepSessionsOpen !== undefined ? current.keepSessionsOpen : true;
  current.autoContinueOnApiError = current.autoContinueOnApiError !== undefined ? current.autoContinueOnApiError : true;
  // #69 — opt-in, default OFF (unlike autoContinueOnApiError above): this fires off a
  // timestamp with no proof the session is actually blocked — see pty-worker.js.
  current.autoResumeOnReset = current.autoResumeOnReset !== undefined ? current.autoResumeOnReset : false;
  // Never expose password in API response
  current.password = '***';
  res.json(current);
});

const ALLOWED_CONFIG_KEYS = ['port', 'host', 'user', 'password', 'shell', 'defaultCwd', 'scanFolders', 'defaultCommand', 'openInNewTab', 'serverName', 'scrollbackReplayLimit', 'cluster', 'publicUrl', 'claudeHome', 'keepSessionsOpen', 'autoContinueOnApiError', 'autoResumeOnReset', 'exclusiveViewer'];

app.put('/api/config', express.json({ limit: '16kb' }), (req, res) => {
  try {
    // Only allow known config keys
    const sanitized = {};
    for (const key of ALLOWED_CONFIG_KEYS) {
      if (req.body[key] !== undefined) sanitized[key] = req.body[key];
    }
    // If password is masked, preserve existing password; otherwise hash the new one
    if (sanitized.password === '***' || !sanitized.password) {
      const existing = readConfig();
      sanitized.password = existing.password || PASS;
    } else if (!sanitized.password.startsWith('$scrypt$')) {
      sanitized.password = hashPassword(sanitized.password);
    }
    // Basic type validation
    if (sanitized.port !== undefined) sanitized.port = parseInt(sanitized.port) || 7681;
    if (sanitized.scanFolders && !Array.isArray(sanitized.scanFolders)) sanitized.scanFolders = [String(sanitized.scanFolders)];
    if (sanitized.openInNewTab !== undefined) sanitized.openInNewTab = !!sanitized.openInNewTab;
    if (sanitized.keepSessionsOpen !== undefined) sanitized.keepSessionsOpen = !!sanitized.keepSessionsOpen;
    if (sanitized.autoContinueOnApiError !== undefined) sanitized.autoContinueOnApiError = !!sanitized.autoContinueOnApiError;
    if (sanitized.autoResumeOnReset !== undefined) sanitized.autoResumeOnReset = !!sanitized.autoResumeOnReset;
    if (sanitized.scrollbackReplayLimit !== undefined) sanitized.scrollbackReplayLimit = Math.max(10240, parseInt(sanitized.scrollbackReplayLimit) || 102400);
    // Compare restart-sensitive keys against running values
    const RESTART_KEYS = { port: PORT, host: config.host || '127.0.0.1', shell: SHELL };
    const needsRestart = Object.entries(RESTART_KEYS).some(
      ([k, running]) => sanitized[k] !== undefined && String(sanitized[k]) !== String(running)
    );
    writeConfig(sanitized);
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
  const { name, url, token } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ error: 'name, url, token required' });
  // Validate URL format
  try { new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL' }); }

  // Add to cluster config if not already there
  const cfg = readConfig();
  if (!cfg.cluster) cfg.cluster = [];
  if (!cfg.cluster.find(s => s.url === url)) {
    cfg.cluster.push({ name, url });
    writeConfig(cfg);
  }

  // Store the token for this remote server
  const clusterTokens = loadClusterTokens();
  clusterTokens[url] = { token, name, authenticated: Date.now() };
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
    return res.json({ ok: true, token: createApiToken(`client:${safeLabel}`) });
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
    res.json({ ok: true, token: data.token, name: peer.name, url });
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

async function _computeClusterSessions(reqUser) {
  const result = [];
  // #56 — the local server's own account usage, rolled up from the sessions below. Kept
  // apart from `result` (which accumulates the peers' sessions too) so each server's block
  // is computed from ITS OWN reports only.
  const localShaped = [];

  // Local sessions (via worker)
  try {
    const { sessions: localList } = await workerClient.rpc('listSessions');
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
      });
    });
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
    if (!tokenEntry) return { server: server.name, url: server.url, online: false, needsAuth: true, sessions: [] };
    try {
      const r = await clusterFetch(server.url + '/api/sessions', {
        headers: { 'Authorization': 'Bearer ' + tokenEntry.token },
        timeout: 3000
      });
      if (r.status === 401) {
        return { server: server.name, url: server.url, online: true, needsAuth: true, sessions: [] };
      }
      if (!r.ok) return { server: server.name, url: server.url, online: false, sessions: [] };
      const remoteSessions = JSON.parse(r.body);
      // Fetch version from remote — and its CAPABILITIES, which ride the same answer.
      // A client must be able to ask "can the server that owns this session take this
      // write?" BEFORE offering the control; discovering it as a 404 means the user
      // sees the action flash on and snap off with no explanation. A peer too old to
      // answer (or one whose probe fails) reports none — the client then offers
      // nothing, which is the honest thing to do.
      let version = '', capabilities = [], resources = null;
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
        directConnect, sessions: mapped,
        // #56 — the peer's OWN account usage. It reports the raw facts (each session's
        // metrics, now carrying `agent` + `ts`) on its /api/sessions, which is a bare array
        // and cannot carry a server-level block; the SAME roll-up rule is applied to them
        // here, so local and remote are one rule, not two. No extra fan-out GET, and a peer
        // too old to send `ts` simply reports nothing rather than a wrong number.
        usage: rollUpUsage(mapped),
      };
    } catch (e) {
      return { server: server.name, url: server.url, online: false, sessions: [] };
    }
  });

  const _tClusterFetch = _LATENCY_DEBUG ? performance.now() : 0;
  const remotes = await Promise.all(remotePromises);
  if (_LATENCY_DEBUG) {
    const dur = performance.now() - _tClusterFetch;
    if (dur > 30) console.log(`[slow-op] ${new Date().toISOString()} cluster-sessions-fetch peers=${remotePromises.length} dur=${dur.toFixed(0)}ms`);
  }
  for (const r of remotes) {
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
        // #152 — machine-wide CPU%/memory, sampled independently of this request (see
        // the warm sampler above). Always present locally; a peer carries its own the
        // same way `usage` does below.
        resources: _resourceSampler.read(),
        ...(localUsage ? { usage: localUsage } : {}),
      },
      ...remotes.map(r => ({
        name: r.server, url: r.url, online: r.online, needsAuth: r.needsAuth,
        version: r.version || '', capabilities: r.capabilities || [], directConnect: r.directConnect === true,
        ...(r.resources ? { resources: r.resources } : {}),
        ...(r.usage ? { usage: r.usage } : {}),
      }))
    ]
  };
}

app.get('/api/cluster/sessions', async (req, res) => {
  // Direct-mode (issue #20): look up the current user from the session cookie so
  // minted tokens bind to them. Cluster API calls via Bearer have no cookie —
  // in that case we fall back to the configured server user.
  const reqUser = (() => {
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
  })();

  try {
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
    const payload = await entry.promise;
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

  function connectRemote() {
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false, perMessageDeflate: false });

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
    // Absorb client heartbeats — don't forward to remote PTY
    const firstByte = Buffer.isBuffer(msg) ? msg[0] : (msg.length > 0 ? msg.charCodeAt(0) : 0);
    if (firstByte === 0x7B) {
      const str = Buffer.isBuffer(msg) ? msg.toString() : msg;
      if (str.startsWith('{"heartbeat":')) { localWs._wtAlive = true; return; }
    }
    if (remoteWs && remoteWs.readyState === WebSocket.OPEN) {
      try { remoteWs.send(msg, { binary: isBinary }); } catch (e) {}
    } else if (buffered.length < MAX_BUFFER_SIZE) {
      buffered.push({ msg, isBinary });
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
//   - Cheap keys (hash, date, dirty, local-hash)  — refreshed every 30s.
//   - Expensive keys (behind = `git fetch --dry-run` + `rev-list`) —
//     refreshed every 5 minutes, never on the request path.
// On request we just return the cached struct synchronously. If the
// cache is empty (first call) we do a single sync call (for `hash`
// only — cheap), and schedule a full refresh. Behind=-1 until ready.
let _gitCache = null;       // { hash, date, behind, dirty, hashOnlyFallback }
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
    const [hash, date, dirtyRaw] = await Promise.all([
      _gitExecAsync('git', ['rev-parse', '--short', 'HEAD']),
      _gitExecAsync('git', ['log', '-1', '--format=%ci']),
      _gitExecAsync('git', ['status', '--porcelain']),
    ]);
    let behind = _gitCache ? _gitCache.behind : -1;
    if (includeBehind && !_gitBehindRefreshing) {
      _gitBehindRefreshing = true;
      try {
        // git fetch --dry-run with 5s timeout — in background so it NEVER
        // blocks the request path. Once it returns, the cached `behind`
        // updates and subsequent responses pick it up.
        const fetchOk = await _gitExecAsync('git', ['fetch', '--dry-run'], 5000);
        if (fetchOk !== null) {
          const count = await _gitExecAsync('git', ['rev-list', 'HEAD..@{u}', '--count']);
          behind = (count != null && count !== '') ? (parseInt(count) || 0) : 0;
          _gitBehindTime = Date.now();
        } else {
          behind = -1;
        }
      } finally {
        _gitBehindRefreshing = false;
      }
    }
    _gitCache = {
      hash: hash || 'unknown',
      date: date || '',
      behind,
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
  // Cold start: no cached value at all. Do ONE cheap sync call (git rev-parse
  // is fast — ~50ms typical — and the alternative is reporting `unknown`
  // forever until the first async refresh lands, which is awkward for the
  // UI. Behind=-1 until the async refresh arrives.
  try {
    const { execSync } = require('child_process');
    const hash = execSync(`git ${gitSafeArgs(['rev-parse', '--short', 'HEAD']).join(' ')}`, { cwd: __dirname, encoding: 'utf8', windowsHide: true, env: gitSafeEnv() }).trim();
    _gitCache = { hash, date: '', behind: -1, dirty: false };
    _gitCacheTime = Date.now();
  } catch {
    _gitCache = { hash: 'unknown', date: '', behind: -1, dirty: false };
  }
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
    'session-resources'];
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
    version: SERVER_VERSION,
    hash: info.hash,
    date: info.date,
    behind: info.behind,
    dirty: info.dirty,
    serverName: getServerName(),
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
app.get('/api/sessions', async (req, res) => {
  try {
    const { sessions: list } = await workerClient.rpc('listSessions');
    const listMetrics = await Promise.all(list.map((s) => sessionMetrics(s).catch(() => null)));
    const listConvIds = await Promise.all(list.map((s) => sessionConversationId(s).catch(() => null)));
    const listBgTasks = await Promise.all(list.map((s) => sessionRunningWork(s).catch(() => [])));
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
      // (lib/usage-limit.js), shared with the worker's arming gate, so the badge can
      // never claim something the timer disagrees with.
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
    }));
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

// --- API: create session ---
const MAX_SESSIONS = config.maxSessions || 10;
const DEDUP_WINDOW_MS = 2000; // reject duplicate name+cwd within 2 seconds
let _lastSessionCreate = { name: '', cwd: '', time: 0 };
app.post('/api/sessions', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { sessions: existing } = await workerClient.rpc('listSessions');
    if (existing.length >= MAX_SESSIONS) {
      return res.status(429).json({ error: `Session limit reached (max ${MAX_SESSIONS})` });
    }
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
    const autoCommand = String(req.body?.autoCommand || getDefaultCommand() || '').substring(0, 500);
    // Which AI agent this session runs. An explicit pick from the client wins; an
    // unknown id is rejected rather than silently coerced, so a typo can't persist a
    // bogus agent onto the session. Absent → the worker infers it from the command.
    let agent = null;
    if (req.body?.agent != null && req.body.agent !== '') {
      if (!agentsLib.isKnownAgent(req.body.agent)) {
        return res.status(400).json({ error: `Unknown agent: ${String(req.body.agent).slice(0, 40)}` });
      }
      agent = req.body.agent;
    }
    // Deduplicate rapid session creation (same name + cwd within time window)
    const now = Date.now();
    if (name === _lastSessionCreate.name && cwd === _lastSessionCreate.cwd && now - _lastSessionCreate.time < DEDUP_WINDOW_MS) {
      return res.status(409).json({ error: 'Duplicate session — please wait before creating another with the same name and folder' });
    }
    _lastSessionCreate = { name, cwd, time: now };
    // Verify cwd exists — return error if user specified a bad path
    try {
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        if (req.body?.cwd) return res.status(400).json({ error: `Folder does not exist: ${cwd}` });
        cwd = liveCwd;
      }
    } catch (e) {
      if (req.body?.cwd) return res.status(400).json({ error: `Folder does not exist: ${cwd}` });
      cwd = liveCwd;
    }
    const created = await workerClient.rpc('createSession', { id, cwd, name, autoCommand, agent });
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
    res.json({
      id: created.id,
      name: created.name,
      agent: agentsLib.resolveAgent(created.agent, autoCommand),
      agentReady: created.agentReady ?? true,
    });
  } catch (e) {
    console.error(`Failed to create session: ${e.message}`);
    res.status(500).json({ error: 'Failed to create session' });
  }
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

  // Resolve the transcript path (stash → validated derivation; SSOT helper).
  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });

  let fd;
  try {
    const size = fs.statSync(tpath).size;
    // A stale cursor past EOF just reads the tail rather than erroring.
    if (before != null && before > size) before = size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = (off, len) => {
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      return read === len ? buf : buf.slice(0, read);
    };
    // Which agent wrote this transcript decides how a LINE is parsed; the paging,
    // cursor and tool_use↔result pairing are shared (lib/agents.js is the registry).
    const agent = agentForTranscriptPath(tpath);
    const adapter = getAdapter(agent);
    const { turns, cursor, hasMore } = transcript.scanTurnsBackward(readChunk, size, {
      before, limit, parseLine: adapter.parseLine, extractResults: adapter.extractResults,
    });
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
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
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
app.get('/api/sessions/:id/speech', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;

  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });

  let fd;
  try {
    const size = fs.statSync(tpath).size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = (off, len) => {
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      return read === len ? buf : buf.slice(0, read);
    };
    const agent = agentForTranscriptPath(tpath);
    const adapter = getAdapter(agent);
    const { turns } = transcript.scanTurnsBackward(readChunk, size, {
      limit: SPEECH_SCAN_TURNS, parseLine: adapter.parseLine, extractResults: adapter.extractResults,
    });
    // An empty `text` is a normal answer meaning "nothing worth saying" (the last
    // turns were all tool calls, or were pure code). The client must stay silent
    // on it — it is NOT an error and NOT a reason to fall back to raw text.
    const { text, ts } = speech.speechFromTurns(turns);
    res.json({ text, ts, agent });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/speech failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read transcript' });
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
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
app.get('/api/sessions/:id/recap', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;

  let session;
  try { session = await workerClient.rpc('getSession', { id }); }
  catch { return res.status(404).json({ error: 'no such session' }); }
  if (!session) return res.status(404).json({ error: 'no such session' });

  const base = {
    name: session.name,
    cwd: session.cwd,
    status: session.status,
    agent: session.agent ?? null,
    lastActivity: session.lastActivity ?? null,
    waitingFor: sessionWaitingFor(session),
    prompt: null,
    reply: null,
    since: { turns: 0, tools: [] },
    tasks: null,
  };

  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.json(base);

  let fd;
  try {
    const size = fs.statSync(tpath).size;
    fd = fs.openSync(tpath, 'r');
    const readChunk = (off, len) => {
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      return read === len ? buf : buf.slice(0, read);
    };
    const agent = agentForTranscriptPath(tpath);
    const adapter = getAdapter(agent);
    // Page backward until a HUMAN prompt is in hand (or the budget/file runs out).
    // The stop condition asks recap's own rule, so the scan can never stop on a
    // turn buildRecap would then reject.
    let turns = [];
    let before = null;
    while (turns.length < RECAP_MAX_TURNS) {
      const page = transcript.scanTurnsBackward(readChunk, size, {
        before, limit: RECAP_PAGE_TURNS,
        parseLine: adapter.parseLine, extractResults: adapter.extractResults,
      });
      // Older page goes in FRONT — the list stays newest-LAST for buildRecap.
      turns = page.turns.concat(turns);
      if (recap.findHumanPromptIndex(page.turns) >= 0) break;
      if (!page.cursor) break; // reached the start of the file
      const next = transcript.decodeCursor(page.cursor);
      if (next == null || next === before) break; // malformed or no progress
      before = next;
    }
    res.json({
      ...base,
      agent,
      ...recap.buildRecap(turns),
      tasks: recap.summariseTasks(readSessionTaskList(id, agent, tpath)),
    });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/recap failed: ${e.message}`);
    res.json(base); // a partial card beats an error dialog
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
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
    const readChunk = (off, len) => {
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = fs.readSync(fd, buf, read, len - read, off + read);
        if (n <= 0) break;
        read += n;
      }
      return read === len ? buf : buf.slice(0, read);
    };
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
  return waitingForRule(s.status, !!(_notifyState.get(s.id) || {}).pendingQuestion);
}

app.get('/api/sessions/:id/pending-question', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.params.id;
  // Prefer the LIVE question captured from the PreToolUse hook — it's present
  // while the prompt is on screen, unlike the transcript (which only gets the
  // tool_use after the answer). The transcript scan below stays as a fallback.
  const live = (_notifyState.get(id) || {}).pendingQuestion;
  if (live) return res.json({ pending: true, question: live });
  const tpath = await resolveSessionTranscriptPath(id);
  if (!tpath) return res.status(404).json({ error: 'no transcript for session' });
  try {
    const size = fs.statSync(tpath).size;
    const TAIL = 262144; // 256KB tail — a pending question is the last tool_use
    const start = Math.max(0, size - TAIL);
    const len = size - start;
    let text = '';
    if (len > 0) {
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(tpath, 'r');
      try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
      text = buf.toString('utf8');
      if (start > 0) { const nl = text.indexOf('\n'); if (nl >= 0) text = text.slice(nl + 1); }
    }
    const q = transcript.pendingQuestion(text);
    res.json(q ? { pending: true, question: q } : { pending: false });
  } catch (e) {
    console.error(`GET /api/sessions/${id}/pending-question failed: ${e.message}`);
    res.status(500).json({ error: 'Failed to read transcript' });
  }
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
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    // Verify session exists before delete so we return 404 properly.
    try { await workerClient.rpc('getSession', { id: req.params.id }); }
    catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: 'not found' });
      throw e;
    }
    await workerClient.rpc('killSession', { id: req.params.id });
    invalidateClusterSessionsCache(); // removed session must drop from the sidebar immediately
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

// --- Terminal page ---
app.get('/s/:id', async (req, res) => {
  try {
    await workerClient.rpc('getSession', { id: req.params.id });
    res.sendFile(path.join(__dirname, 'terminal.html'));
  } catch (e) {
    res.redirect('/');
  }
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
  let attached = false;
  const pendingMessages = []; // messages received before attach completes

  // Set up message/close handlers IMMEDIATELY so early mode messages aren't dropped.
  ws._wtAlive = true;
  ws._wtBackground = true;   // default until mode message arrives
  ws._wtBrowserId = null;
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
    if (msg.length > 65536) {
      console.error(`[${new Date().toISOString()}] WS input DROPPED session ${id}: ${msg.length} bytes exceeds the 65536 cap`);
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

            if (parsed.mode === 'active') {
              ws._wtBackground = false;
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
              ws._wtBackground = true;
              // #146 — ...and one that backgrounded loses it, so a phone left open in a
              // pocket stops holding a desktop session at phone width.
              applyNegotiatedSize(id);
            }
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
    } catch {}
  }

  ws.on('message', (msg) => {
    if (!attached) { pendingMessages.push(msg); return; }
    handleMessage(msg);
  });

  let closedEarly = false;
  ws.on('close', () => {
    closedEarly = !attached;
    clientsSet.delete(ws);
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
    }

    clientsSet.add(ws);
    ensurePtyOutSubscription(id);
    attached = true;
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
