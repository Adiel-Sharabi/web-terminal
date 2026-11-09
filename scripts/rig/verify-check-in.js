#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, of the #443 check-in with a REAL claude:
//   A  reports wait "self" with nothing running -> exactly ONE check-in after the
//      (shortened) threshold, and the wait it reports afterwards is the answer.
//   B  reports wait "self" with a live background shell -> NO check-in at all.
// The result is read from the TRANSCRIPT (/transcript, /recap) as well as the row: the
// check-in must be a system turn there, never "You". Nothing here touches production.
//
// HOOKS: the sessions run in a folder whose project settings send hooks to the rig
// (rig-http.js writeProjectHooks). Start the rig with CLAUDE* scrubbed from the env, so the
// spawned claude is not a child of this one:
//   env $(env | grep -o '^CLAUDE[A-Z_]*' | sed 's/^/-u /') node scripts/rig/rig.js up
//   node scripts/rig/verify-check-in.js

const fs = require('fs');
const path = require('path');
const { WS_BASE, login, api, writeProjectHooks } = require('./rig-http');
const { openTerminal } = require('./rig-ws');

const RIG = require('../scratch-dirs').DIRS.rig;
const CFG = path.join(RIG, 'config.json');
const LOG = path.join(RIG, 'handoffs', 'check-in-log.jsonl');
const TAG = '[web-terminal check-in]';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (m) => console.log(`[verify +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const logOf = (id) => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n')
  .filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.id === id);

async function rowOf(cookie, id) {
  return (await api(cookie, 'GET', '/api/sessions')).find((s) => s.id === id) || null;
}
async function until(fn, what, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`);
    await sleep(2000);
  }
}

async function start(cookie, name, cwd, prompt) {
  writeProjectHooks(cwd);
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name, cwd, agent: 'claude', autoCommand: 'claude --dangerously-skip-permissions',
  });
  say(`${name}: session ${id}`);
  await until(async () => (await rowOf(cookie, id))?.agentReady === true, `${name} composer`, 90000);
  const term = await openTerminal(cookie, id);
  await sleep(2000);
  term.send(`${prompt}\r`);
  await until(async () => {
    const r = await rowOf(cookie, id);
    return r && r.status === 'idle' && r.brief && Number.isFinite(r.brief.stoppedAt) && r.brief.stoppedAt >= r.brief.turnAt
      && r.brief.wait && r.brief.wait.on === 'self';
  }, `${name}: its turn to end on a self-wait`, 240000);
  term.close();
  const r = await rowOf(cookie, id);
  say(`${name}: turn over; reason ${JSON.stringify(r.reason)}; live work ${JSON.stringify((r.backgroundTasks || []).map((t) => t.kind))}`);
  return id;
}

(async () => {
  say(`rig ${WS_BASE}`);
  const cfgBefore = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : '{}';
  const base = JSON.parse(cfgBefore);
  // Shortened clocks: stale after 30 s, asked 30 s after that, scanned every 5 s. The
  // prompt below is typed over the terminal socket, which counts as a person typing
  // (the 10-min typing gate): shortened to 12 s, or nothing is asked for 10 min.
  fs.writeFileSync(CFG, JSON.stringify({ ...base, handoff: { ...(base.handoff || {}), staleSelfMin: 0.5 },
    checkIn: { afterMin: 0.5, everyMs: 5000, typingQuietMin: 0.2 } }, null, 2));
  const cookie = await login();
  const made = [];
  let pass = false;
  try {
    const a = await start(cookie, `checkin-A-${Date.now().toString(36)}`, path.join(RIG, 'checkin-a'),
      'This is a test of an idle-session check-in. Do exactly this and nothing else: send a dashboard report '
      + '(the command is in the dashboard note) with "items": [], "headline": "check-in probe" and '
      + '"wait": {"on": "self", "what": "a CI run that will notify me"}. Do not start any background task, monitor, '
      + 'timer or subagent. Then end your turn with one short sentence.');
    made.push(a);
    const b = await start(cookie, `checkin-B-${Date.now().toString(36)}`, path.join(RIG, 'checkin-b'),
      'This is a test. Do exactly this and nothing else: run the shell command `sleep 900` with the Bash tool and '
      + 'run_in_background set to true, then send a dashboard report (the command is in the dashboard note) with '
      + '"items": [], "headline": "check-in probe B" and "wait": {"on": "self", "what": "the sleep finishing"}. '
      + 'Do not wait for the sleep. Then end your turn with one short sentence.');
    made.push(b);

    // A: one check-in, then its answer.
    const sent = await until(async () => (await rowOf(cookie, a))?.checkIn, 'A: a check-in', 5 * 60 * 1000);
    say(`A: check-in ${JSON.stringify(sent)}`);
    const answered = await until(async () => {
      const r = await rowOf(cookie, a);
      const c = r && r.checkIn;
      return c && !['sent', 'answering'].includes(c.state) && r.status === 'idle' ? r : null;
    }, 'A: the answer', 6 * 60 * 1000);
    say(`A: answered ${answered.checkIn.state}; wait now ${JSON.stringify(answered.brief.wait)}; reason ${JSON.stringify(answered.reason)}`);

    // The transcript: the check-in is a system turn named Check-in, followed by the reply.
    const tr = await api(cookie, 'GET', `/api/sessions/${a}/transcript?limit=50`);
    const turns = (tr && (tr.turns || tr.messages || tr.items)) || [];
    const ciTurn = turns.find((t) => typeof t.text === 'string' && t.text.includes(TAG.slice(1, -1)))
      || turns.find((t) => JSON.stringify(t).includes('check-in'));
    say(`A: transcript check-in turn: ${ciTurn ? JSON.stringify({ role: ciTurn.role, userKind: ciTurn.userKind, from: ciTurn.from, text: String(ciTurn.text || '').slice(0, 90) }) : 'NOT FOUND'}`);
    const recap = await api(cookie, 'GET', `/api/sessions/${a}/recap`);
    say(`A: recap prompt ${JSON.stringify(recap.prompt && String(recap.prompt.text || recap.prompt).slice(0, 80))}; reply ${JSON.stringify(recap.reply && { at: recap.reply.at, text: String(recap.reply.text || '').slice(0, 160) })}`);

    // Several scans later: still exactly one for A, and none for B.
    await sleep(60000);
    const aSent = logOf(a).filter((l) => l.event === 'sent').length;
    const bRow = await rowOf(cookie, b);
    const bSent = logOf(b).filter((l) => l.event === 'sent').length;
    say(`A: ${aSent} check-in(s) sent; log ${JSON.stringify(logOf(a))}`);
    say(`B: ${bSent} check-in(s) sent; reason ${JSON.stringify(bRow.reason)}; checkIn ${JSON.stringify(bRow.checkIn)}`);
    const sysTurn = ciTurn && ciTurn.userKind === 'system';
    const recapNotIt = !(recap.prompt && String(recap.prompt.text || recap.prompt).includes(TAG));
    pass = aSent === 1 && answered.checkIn.state !== 'lost' && sysTurn && recapNotIt
      && bSent === 0 && !bRow.checkIn && bRow.reason && bRow.reason.source === 'background';
  } finally {
    fs.writeFileSync(CFG, cfgBefore);
    for (const id of made) await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  }
  console.log(pass ? '[verify] PASS - one check-in on the stale self-wait, answered as state; none beside a live waker.' : '[verify] FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('[verify] error:', e.message); process.exit(1); });
