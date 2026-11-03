#!/usr/bin/env node
'use strict';
// Prepare a web-terminal machine for a restart (#359), from a shell or an agent.
//
//   node scripts/wt-maintenance.js prepare "Windows update"   [--server <url|name>]
//   node scripts/wt-maintenance.js status [--wait [minutes]]  [--server <url|name>] [--json]
//   node scripts/wt-maintenance.js cancel                     [--server <url|name>]
//   node scripts/wt-maintenance.js answer yes|no|later [--minutes N] [--reason "..."]
//
// `prepare` sets the restart hold: every agent session is ASKED whether a restart suits
// it now (#407), and new sessions are refused until the restart. `status` is the server's
// own answer to "can I restart now?", one verdict per session, decided from state and
// never from what the agents wrote; `--wait` polls until it is yes. The hold clears
// itself once the restart has happened, and the sessions it told get a "machine is back"
// notice; `cancel` tells them the restart is off.
//
// `answer` is what an asked session runs, from inside its own session ($WT_SESSION_ID;
// `--session <id>` overrides): yes (it has stopped safely), no (with a --reason) or
// later (asked again after --minutes, default 30). "no" and "later" are fine answers.
//
// --server picks a cluster peer by URL or by its name in cluster-tokens.json, and uses
// that peer's bearer token. Without it, this machine's own server is used, with a token
// from its api-tokens.json.
//
// Exit code: 0 = safe to restart (or the command succeeded), 1 = not yet, 2 = error /
// no hold.

const api = require('./wt-api');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--server', '--wait', '--minutes', '--reason', '--session'].includes(args[i - 1])));
const [cmd, ...rest] = positional;
const asJson = args.includes('--json');

/** { url, token } for --server, or for this machine. */
const target = () => api.target(flag('--server'));
const call = api.call;

function render(t, s) {
  if (!s.hold) {
    const back = s.back ? ` - telling ${s.back.pending} restored session(s) the machine is back` : '';
    return `${t.url}: no restart hold${back}`;
  }
  const lines = [`${t.url}: restart hold "${s.hold.reason}" since ${new Date(s.hold.startedAt).toLocaleTimeString()} - ${s.safeToRestart ? 'SAFE TO RESTART' : 'NOT YET'}`];
  for (const v of s.sessions) {
    lines.push(`  ${v.state.padEnd(10)} ${String(v.name || v.id).slice(0, 40).padEnd(40)} ${v.why}${v.startedDuringHold ? ' (started during the hold)' : ''}`);
    if (v.answer) {
      const when = v.answer === 'later' && v.until ? ` until ${new Date(v.until).toLocaleTimeString()}` : '';
      lines.push(`             answered ${v.answer}${when}${v.answerReason ? `: ${String(v.answerReason).slice(0, 200)}` : ''}`);
    }
    if (v.reply) lines.push(`             said: ${String(v.reply).replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return lines.join('\n');
}

async function main() {
  const t = target();
  if (cmd === 'prepare') {
    const reason = rest.join(' ').trim();
    if (!reason) throw new Error('prepare needs a reason: wt-maintenance.js prepare "Windows update"');
    const r = await call(t, 'POST', '/api/maintenance/prepare', { reason });
    if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); if (r.json.hold) console.log(render(t, r.json)); return 2; }
    console.log(asJson ? JSON.stringify(r.json, null, 2) : render(t, r.json));
    return 0;
  }
  if (cmd === 'answer') {
    const answer = rest[0];
    const sessionId = flag('--session') !== undefined && flag('--session') !== true ? flag('--session') : process.env.WT_SESSION_ID;
    if (!['yes', 'no', 'later'].includes(answer)) throw new Error('answer needs yes, no or later: wt-maintenance.js answer later --minutes 30');
    if (!sessionId) throw new Error('not inside a web-terminal session ($WT_SESSION_ID is not set); pass --session <id>');
    const body = { sessionId, answer };
    const m = flag('--minutes');
    if (m !== undefined) {
      if (m === true || !Number.isFinite(Number(m))) throw new Error('--minutes needs a number');
      body.minutes = Number(m);
    }
    const why = flag('--reason');
    if (why !== undefined && why !== true) body.reason = why;
    const r = await call(t, 'POST', '/api/maintenance/answer', body);
    if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); return 2; }
    console.log(`${t.url}: answered ${r.json.answer}${r.json.minutes ? ` (asked again in ${r.json.minutes} min)` : ''}`);
    return 0;
  }
  if (cmd === 'cancel') {
    const r = await call(t, 'DELETE', '/api/maintenance');
    if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); return 2; }
    console.log(`${t.url}: ${r.json.cancelled ? 'restart hold cancelled' : 'there was no restart hold'}`);
    return 0;
  }
  if (cmd === 'status') {
    const w = flag('--wait');
    const until = w ? Date.now() + (w === true ? 60 : Number(w)) * 60000 : 0;
    let last = '';
    for (;;) {
      const r = await call(t, 'GET', '/api/maintenance/status');
      if (r.status !== 200) { console.error(`${t.url}: ${r.json.error || `HTTP ${r.status}`}`); return 2; }
      const out = asJson ? JSON.stringify(r.json, null, 2) : render(t, r.json);
      if (out !== last) { console.log(out); last = out; }
      if (!r.json.hold) return 2;
      if (r.json.safeToRestart) return 0;
      if (!until || Date.now() > until) return 1;
      await new Promise((res) => setTimeout(res, 15000));
    }
  }
  console.error('usage: wt-maintenance.js prepare "<reason>" | status [--wait [minutes]] | cancel | answer yes|no|later [--minutes N] [--reason "..."]   [--server <url|name>] [--json]');
  return 2;
}

main().then((c) => process.exit(c), (e) => { console.error(`wt-maintenance: ${e.message}`); process.exit(2); });
