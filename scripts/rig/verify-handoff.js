#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, that a hand-off (#340) works with a REAL claude:
// the old session writes its brief and posts its verdict, a successor starts in the same
// folder, takes its first turn from the brief, and the old session closes. Nothing here
// touches production's sessions.
//
// HOOKS. The installed http hooks post to production's port, so a rig session's events
// would never reach the rig. The session's folder therefore carries a project-level
// `.claude/settings.local.json` registering the same hooks against the rig's port; Claude
// fires both. Production answers its copy with "session not found" and drops it.
//
// The context gate is forced (`force: true`): a 500k-token session cannot be made on
// demand, and the status line pushes to production, so the rig has no metrics at all.
// Force skips only judgement gates (lib/handoff.js FORCEABLE_GATES); the safety gates
// still apply, which is part of what this proves.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/verify-handoff.js

const fs = require('fs');
const path = require('path');
const { PORT, WS_BASE, login, api } = require('./rig-http');
const { openTerminal } = require('./rig-ws');

const RIG = require('../scratch-dirs').DIRS.rig;
const CWD = path.join(RIG, 'handoff-e2e');
const NAME = `handoff-e2e-${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (m) => console.log(`[verify +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart',
  'SubagentStop', 'Notification', 'Stop', 'PreCompact'];

function writeProjectHooks() {
  fs.mkdirSync(path.join(CWD, '.claude'), { recursive: true });
  const hook = {
    type: 'http', url: `http://127.0.0.1:${PORT}/api/hook`,
    headers: { 'X-WT-Session-ID': '$WT_SESSION_ID', 'X-WT-Hook-Token': '$WT_HOOK_TOKEN' },
    allowedEnvVars: ['WT_SESSION_ID', 'WT_HOOK_TOKEN'],
  };
  const hooks = Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [hook] }]]));
  fs.writeFileSync(path.join(CWD, '.claude', 'settings.local.json'), JSON.stringify({ hooks }, null, 2));
}

async function rowOf(cookie, id) {
  return (await api(cookie, 'GET', '/api/sessions')).find((s) => s.id === id) || null;
}

async function until(fn, what, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
    await sleep(1000);
  }
}

(async () => {
  say(`rig ${WS_BASE}, folder ${CWD}`);
  writeProjectHooks();
  const cookie = await login();
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: NAME, cwd: CWD, agent: 'claude', autoCommand: 'claude --dangerously-skip-permissions',
  });
  say(`old session ${id}`);
  await until(async () => (await rowOf(cookie, id))?.agentReady === true, 'the composer', 90000);

  // One real turn, so the session has a finished turn and a report behind it.
  const term = await openTerminal(cookie, id);
  await sleep(2000);
  term.send('Write the single word hello into a file named notes.txt in the current folder. That is the whole task.\r');
  await until(async () => {
    const r = await rowOf(cookie, id);
    return r && r.status === 'idle' && r.brief && Number.isFinite(r.brief.stoppedAt) && r.brief.stoppedAt >= r.brief.turnAt;
  }, 'the first turn to finish', 180000);
  term.close();
  say(`first turn done; handoff field: ${JSON.stringify((await rowOf(cookie, id)).handoff)}`);

  await api(cookie, 'POST', `/api/sessions/${id}/handoff`, { force: true });
  say('hand-off started');

  let last = '';
  let succId = null;
  const outcome = await until(async () => {
    const r = await rowOf(cookie, id);
    if (!r) return 'closed';
    const run = r.handoff && r.handoff.run;
    const now = run ? `${run.state}${run.reason ? ` (${run.reason})` : ''}` : 'no run';
    if (now !== last) { say(`run: ${now}`); last = now; }
    if (run && run.successorId) succId = run.successorId;
    return run && (run.state === 'kept' || run.state === 'failed') ? JSON.stringify(run) : null;
  }, 'the hand-off to end', 20 * 60 * 1000);

  const brief = path.join(RIG, 'handoffs', `handoff-${id}.md`);
  say(`outcome: ${outcome}`);
  say(`brief ${fs.existsSync(brief) ? `written, ${fs.statSync(brief).size} bytes` : 'MISSING'}`);
  if (fs.existsSync(brief)) console.log(fs.readFileSync(brief, 'utf8').split('\n').slice(0, 25).map((l) => `    | ${l}`).join('\n'));
  const succ = succId && await rowOf(cookie, succId);
  say(`successor: ${succ ? `${succ.name} cwd=${succ.cwd} status=${succ.status} turnAt=${succ.brief && succ.brief.turnAt}` : 'none'}`);
  // The closed record is written on the worker's sessionExited event, which lands a moment
  // AFTER the row leaves the list - reading it at once raced that (the first run did).
  const closed = outcome !== 'closed' ? null : await until(async () =>
    (await api(cookie, 'GET', '/api/dashboard/closed')).closed.find((c) => c.id === id), 'the closed record', 15000)
    .catch(() => null);
  say(`closed record handedOffTo: ${JSON.stringify(closed && closed.handedOffTo)}`);

  const pass = outcome === 'closed' && succ && succ.cwd === CWD && closed && closed.handedOffTo
    && closed.handedOffTo.id === succId && fs.existsSync(brief);
  // Leave nothing running: the successor is a real claude.
  if (succId) await api(cookie, 'DELETE', `/api/sessions/${succId}`).catch(() => {});
  if (outcome !== 'closed') await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  console.log(pass ? '[verify] PASS - briefed, successor up in the same folder, old session closed.' : '[verify] FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('[verify] error:', e.message); process.exit(1); });
