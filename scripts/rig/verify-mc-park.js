#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, of #506 "To my to-do" with a REAL claude:
//   a session reports a `you` wait -> it is an Answer-now card (GET /api/mc/now);
//   POST /api/mc/todo moves it to My to-do and the park message is DELIVERED;
//   a second press sends nothing (`already`);
//   the agent parks the wait (reports it as external), the card leaves Answer now;
//   and its TRANSCRIPT (the JSONL claude writes, the ground truth) holds the park message
//   in exactly ONE user turn, a minute later still.
// Nothing here touches production.
//
// HOOKS: the session runs in a folder whose project settings send hooks to the rig
// (rig-http.js writeProjectHooks). Start the rig with CLAUDE* scrubbed from the env, so the
// spawned claude is not a child of this one:
//   env $(env | grep -o '^CLAUDE[A-Z_]*' | sed 's/^/-u /') node scripts/rig/rig.js up
//   node scripts/rig/verify-mc-park.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { login, api, writeProjectHooks } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { claudeProjectDirName } = require('../../lib/transcript');

const RIG = require('../scratch-dirs').DIRS.rig;
const CFG = path.join(RIG, 'config.json');
const MARK = '[Mission Control] The user moved';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (m) => console.log(`[verify +${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

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
/** The user turns of the session's own transcript JSONL that carry the park message. */
function parkTurns(cwd, conv) {
  const file = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd), `${conv}.jsonl`);
  if (!fs.existsSync(file)) return { file, n: null };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let n = 0;
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== 'user' || !j.message) continue;
    if (JSON.stringify(j.message.content).includes(MARK)) n += 1;
  }
  return { file, n };
}

(async () => {
  const cfgBefore = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : '{}';
  const base = JSON.parse(cfgBefore);
  // The prompt below is typed over the terminal socket, which counts as a person typing:
  // the gated prompt waits typingQuietMin after it (10 min by default), shortened to 12 s.
  fs.writeFileSync(CFG, JSON.stringify({ ...base, checkIn: { ...(base.checkIn || {}), typingQuietMin: 0.2 } }, null, 2));
  const cookie = await login();
  let id = null;
  let pass = false;
  try {
    const cwd = path.join(RIG, 'mc-park');
    writeProjectHooks(cwd);
    ({ id } = await api(cookie, 'POST', '/api/sessions', {
      name: `mc-park-${Date.now().toString(36)}`, cwd, agent: 'claude', autoCommand: 'claude --dangerously-skip-permissions',
    }));
    say(`session ${id}`);
    await until(async () => (await rowOf(cookie, id))?.agentReady === true, 'the composer', 90000);
    const term = await openTerminal(cookie, id);
    await sleep(2000);
    term.send('This is a test of Mission Control. Do exactly this and nothing else: send a dashboard report (the command '
      + 'is in the dashboard note) with "items": [{"ref": "ado:4711", "title": "Try the build", "state": "in-progress"}], '
      + '"headline": "mc park probe" and "wait": {"on": "you", "what": "try the build on the desk"}. '
      + 'Then end your turn with one short sentence. If you are later told a wait was moved to the user\'s to-do list, '
      + 'do what that message says and then end your turn.\r');
    const asked = await until(async () => {
      const r = await rowOf(cookie, id);
      return r && r.status === 'idle' && r.brief && Number.isFinite(r.brief.stoppedAt) && r.brief.stoppedAt >= r.brief.turnAt
        && r.brief.wait && r.brief.wait.on === 'you' ? r : null;
    }, 'its turn to end on a you-wait', 240000);
    term.close();
    say(`turn over; reason ${JSON.stringify(asked.reason)}`);

    const card = await until(async () => {
      const now = await api(cookie, 'GET', '/api/mc/now');
      return now.answerNow.find((c) => c.sessionId === id) || null;
    }, 'its Answer-now card', 30000);
    say(`card ${card.id} kind ${card.kind} rank ${card.rank} why ${JSON.stringify(card.why.text)}`);

    await sleep(15000); // past the shortened typing gate
    const first = await api(cookie, 'POST', '/api/mc/todo', { cardId: card.id, text: 'try the build at the desk' });
    say(`To my to-do: parked ${JSON.stringify(first.parked)}; todo ${first.todo.id}`);
    const second = await api(cookie, 'POST', '/api/mc/todo', { cardId: card.id });
    say(`pressed again: parked ${JSON.stringify(second.parked)}`);

    const parked = await until(async () => {
      const r = await rowOf(cookie, id);
      return r && r.status === 'idle' && r.brief && r.brief.turnAt > first.todo.park.at && r.brief.stoppedAt >= r.brief.turnAt
        && r.brief.wait && r.brief.wait.on !== 'you' ? r : null;
    }, 'the agent to park the wait', 240000);
    say(`after the park: wait ${JSON.stringify(parked.brief.wait)}; reason ${JSON.stringify(parked.reason)}`);
    const conv = parked.agentSessionId || parked.claudeSessionId;
    const turns1 = parkTurns(cwd, conv);
    say(`transcript ${path.basename(turns1.file)}: ${turns1.n} user turn(s) with the park message`);
    await sleep(60000);
    const turns2 = parkTurns(cwd, conv);
    const now = await api(cookie, 'GET', '/api/mc/now');
    const stillCard = now.answerNow.some((c) => c.sessionId === id);
    const todo = now.todo.find((t) => t.id === first.todo.id);
    say(`a minute later: ${turns2.n} user turn(s); card in Answer now: ${stillCard}; to-do ${JSON.stringify(todo && todo.park)}`);
    pass = first.parked.delivered === true && second.parked.already === true && second.todo.park.at === first.todo.park.at
      && turns1.n === 1 && turns2.n === 1 && !stillCard && todo && todo.park.state === 'delivered';
  } finally {
    fs.writeFileSync(CFG, cfgBefore);
    if (id) await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  }
  console.log(pass ? '[verify] PASS - the card moved to My to-do, its session got the park message in ONE user turn, and parked it.' : '[verify] FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('[verify] error:', e.message); process.exit(1); });
