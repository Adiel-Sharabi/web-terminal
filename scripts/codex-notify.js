#!/usr/bin/env node
'use strict';
// Codex `notify` program — tells web-terminal WHICH conversation belongs to WHICH session.
//
// THE PROBLEM IT SOLVES. A Codex rollout is keyed by date+uuid, never by cwd, so
// resolution was "the newest rollout matching this cwd" — which quietly assumes one Codex
// per directory. Run two in one folder and both sessions collapse onto the same
// conversation: measured on Office, a dead session's chat lens showed a live session's
// work beside a terminal that was correctly showing nothing.
//
// WHY THIS MECHANISM. Two other routes were tried and rejected against the real machine:
//   * Process ancestry — walk the PTY's descendants to find its codex. DOESN'T WORK: the
//     chain runs codex <- node <- sh, and when that intermediate shell exits the parent
//     link is severed (Office had sh.exe pointing at dead pids 52440/52060), so the
//     session's own codex is unreachable from its PTY.
//   * Lifecycle hooks — exact, but adding or CHANGING one blocks every Codex session at
//     startup behind an interactive "Hooks need review" trust prompt. Unusable unattended.
//
// `notify` has neither problem. Measured 2026-07-22 on codex-cli 0.144.6: it fires with
// no trust prompt at all, and its payload carries `thread-id` — the conversation id. The
// program inherits the PTY's environment, which pty-worker.js already stamps with
// WT_SESSION_ID and WT_SESSION_PORT. An INHERITED ENV VAR SURVIVES ITS PARENT EXITING,
// which is exactly what defeated the ancestry approach.
//
// So the pair (WT_SESSION_ID, thread-id) is an exact, unambiguous mapping that holds for
// any number of Codex sessions in one folder.
//
// Contract: Codex passes one JSON argument. Exit 0 ALWAYS and stay silent — this runs on
// the agent's turn-completion path, and a notifier that throws, hangs or prints must
// never disturb the session it is reporting on.
const http = require('http');

function main() {
  let payload;
  try { payload = JSON.parse(process.argv[2] || '{}'); } catch { return; }
  if (!payload || typeof payload !== 'object') return;

  const sessionId = process.env.WT_SESSION_ID;
  const conversationId = payload['thread-id'];
  // No session id means this Codex was not launched inside a web-terminal PTY — a plain
  // terminal, or a nested tool. Nothing to report; that is normal, not an error.
  if (!sessionId || !conversationId) return;

  const body = Buffer.from(JSON.stringify({
    sessionId,
    conversationId,
    cwd: payload.cwd || '',
  }));

  const req = http.request({
    host: '127.0.0.1',
    port: process.env.WT_SESSION_PORT || 7681,
    path: '/api/codex-session',
    method: 'POST',
    timeout: 2000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  });
  // Every failure path is a no-op: the server may be restarting, or this may be a machine
  // where web-terminal is not running at all.
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

try { main(); } catch { /* never let a notifier break a turn */ }
