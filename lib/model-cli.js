'use strict';
// --- One tools-off model call through the Claude CLI (#383, #511) ------------------
// The inbox digest (lib/inbox-digest.js) and the Mission Control Analyst (lib/mc-analyst.js)
// both ask a model a question about text this server already holds. Both run it the SAME
// way, and that way lives here once: `claude -p` with every tool, setting and MCP server
// off, the prompt on stdin, a scrubbed environment, a run-slot queue, a timeout that kills
// the one child it spawned, and a shutdown that kills only the children it recorded.
//
// What to send and how to read the answer stay with each caller; this file knows nothing
// about either.
//
// HOT-RELOAD ONLY: loaded by server.js (through its callers) alone, never by pty-worker.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

// Environment a nested `claude -p` must not inherit: the variables that tie a process to
// the session that spawned it (it would join, or confuse, that session), and our own hook
// and auth variables (the child must fire none of OUR hooks and holds no secret of ours).
// Everything else - CLAUDE_CODE_GIT_BASH_PATH, CLAUDE_CODE_OAUTH_TOKEN, the PATH - is what
// the child needs to run and to log in, so it is NOT scrubbed by prefix.
const SCRUB_EXACT = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET',
]);
function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    const up = k.toUpperCase();
    if (SCRUB_EXACT.has(up) || up.startsWith('WT_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Where the CLI is: config `command` first, then `claude.exe` on PATH, then the
 * installer's own folder. Windows `where claude` does not find the installed binary and
 * the server's PATH may not carry it either, so the last step is a path, not a lookup.
 * Returns an argv prefix `[exe, ...args]` or null. [exists] is injectable for tests.
 */
function resolveCommand(configured, env = process.env, exists = fs.existsSync) {
  if (typeof configured === 'string' && configured.trim()) configured = [configured.trim()];
  if (Array.isArray(configured) && configured.length && configured.every((s) => typeof s === 'string' && s)) {
    // An explicit command is trusted as the owner's choice - but it must exist when it
    // names a path, or `no-cli` would surface as a spawn error 90 s later.
    const exe = configured[0];
    if (/[\\/]/.test(exe) && !exists(exe)) return null;
    return configured;
  }
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (exists(p)) return [p];
    }
  }
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (home) {
    const p = path.join(home, '.local', 'bin', names[0]);
    if (exists(p)) return [p];
  }
  return null;
}

/** The flags that make `claude -p` a pure text-in, text-out call: no session saved, no
 *  settings or MCP servers (so no hooks run), no tools. NOT `--bare` - that turns OAuth
 *  off and these machines have no API key. */
function cliArgs(model) {
  return ['-p', '--model', model, '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--tools', ''];
}

/** The ONE JSON object a model replied with, or null. `claude -p --output-format json`
 *  wraps the reply as { is_error, result } (an error is null); a bare object that carries
 *  [bareKey] is also accepted (a custom command). The reply may sit in a code fence or
 *  between words: the outermost braces are parsed. Shape checks are the caller's. */
function cliJsonObject(stdout, { bareKey } = {}) {
  let text = typeof stdout === 'string' ? stdout.trim() : '';
  if (!text) return null;
  try {
    const outer = JSON.parse(text);
    if (outer && typeof outer === 'object' && !Array.isArray(outer) && typeof outer.result === 'string') {
      if (outer.is_error === true) return null;
      text = outer.result.trim();
    } else if (bareKey && outer && typeof outer === 'object' && bareKey in outer) {
      return outer;
    }
  } catch { /* not JSON as a whole: the text may still hold the object */ }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1];
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

/**
 * The run slots and the child processes of ONE caller.
 * @param {object} deps
 * @param {() => string} deps.scratchDir  cwd for the child: never a project
 * @param {Function} [deps.spawn]         child_process.spawn
 * @param {object} [deps.env]
 * @param {{maxRunning:number, maxQueued:number}} deps.limits
 */
function createCliRunner(deps) {
  const spawn = deps.spawn || nodeSpawn;
  const envSrc = deps.env || process.env;
  const L = deps.limits;
  const waiting = [];          // queued jobs: () => void
  const children = new Set();  // the child processes THIS runner spawned and has not seen exit
  let running = 0;

  /** One CLI run. Resolves { ok:true, text } or { ok:false, reason }. The child is the one
   *  WE spawned, and the one we kill on timeout - nothing is ever found by name. */
  function run(argv, promptText, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      let done = false;
      let out = '';
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: deps.scratchDir(),
          env: scrubEnv(envSrc),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch { finish({ ok: false, reason: 'error' }); return; }
      children.add(child);
      child.on('error', () => finish({ ok: false, reason: 'error' }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (out.length < 400000) out += d; });
      child.on('close', (code) => {
        children.delete(child);
        finish(code === 0 ? { ok: true, text: out } : { ok: false, reason: 'error' });
      });
      // The prompt goes on stdin, never in argv: argv is visible to every process on
      // the box and capped at 32 KB on Windows.
      child.stdin.on('error', () => { /* the child died before reading; 'close' reports it */ });
      child.stdin.end(promptText);
    });
  }

  /** Take a run slot or queue for one. Resolves a release fn, or null when full. */
  function acquire() {
    if (running < L.maxRunning) { running++; return Promise.resolve(release); }
    if (waiting.length >= L.maxQueued) return Promise.resolve(null);
    return new Promise((res) => waiting.push(() => { running++; res(release); }));
  }
  function release() {
    running--;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    acquire,
    run,
    /** Kill the children this runner spawned (a server exit or hot reload): they would
     *  otherwise outlive it, billed and unreachable. Only the handles recorded at spawn -
     *  nothing is ever found by name. Returns how many. */
    shutdown() {
      let n = 0;
      for (const child of children) { try { child.kill(); n++; } catch { /* already gone */ } }
      children.clear();
      return n;
    },
    stats: () => ({ children: children.size, running, queued: waiting.length }),
  };
}

module.exports = { scrubEnv, resolveCommand, cliArgs, cliJsonObject, createCliRunner };
