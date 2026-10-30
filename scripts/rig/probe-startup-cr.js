#!/usr/bin/env node
'use strict';
// #404 - does a prompt sent right after Claude's FIRST composer draw keep its Enter?
//
// The worker's #147 latch flips on the first `❯`+NBSP. Two hand-off successors on
// busy boxes (2026-10-29/30, claude 2.1.314) kept the typed words in the composer and
// started no turn. Their PTY bytes showed the prompt landing BEFORE Claude's second
// round of terminal queries (`ESC[>0q`, `ESC[?u`, OSC 7501) and its status line; a
// successful successor had both BEFORE the prompt.
//
// This probe sends `text\r` as ONE frame (as the hand-off and the companion do; the
// worker splits off the CR) at a fixed delay after the first composer draw, and takes
// the verdict from the only honest source: did a turn START (`brief.turnAt`, from the
// UserPromptSubmit hook). It also records, for each trial, whether the second query
// had been seen when the prompt went out - the candidate "startup is over" marker.
//
//   node scripts/rig/rig.js up
//   node scripts/rig/probe-startup-cr.js [delayMs|ready,...] [repeats]
//
// Rig only (port 7999, own worker and data dir). It never touches production.

const path = require('path');
const { login, api, writeProjectHooks } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { DIRS } = require('../scratch-dirs');

// Hook-driven verdict, so the session runs where its hooks reach the rig.
const CWD = path.join(DIRS.rig, 'startup-cr');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMPOSER = String.fromCodePoint(0x276f, 0x00a0); // ASCII-only source, as lib/agents.js
const QUERY = '\u001b[>0q';
// The worker writes the CR alone this long after the text (lib/agents.js claude submit.gapMs).
const GAP_MS = require('../../lib/agents').submitPolicy('claude').gapMs;
const PROMPT = 'reply with exactly the single word OK and nothing else, no punctuation and no explanation at all';

// A number is a fixed delay after the composer (measures CLAUDE). `ready` waits for the
// worker's own agentReady and sends at once, as a hand-off does (measures the GATE).
const delays = (process.argv[2] || '0,250,1000,4000').split(',').map((d) => (d === 'ready' ? d : Number(d)));
const repeats = Number(process.argv[3] || 2);

async function rowOf(cookie, id) {
  return (await api(cookie, 'GET', '/api/sessions')).find((s) => s.id === id) || null;
}

async function trial(cookie, delay) {
  const { id } = await api(cookie, 'POST', '/api/sessions', {
    name: `probe-startup-cr-${delay}`,
    cwd: CWD,
    autoCommand: 'claude --dangerously-skip-permissions',
    agent: 'claude',
  });
  const term = await openTerminal(cookie, id);
  const t0 = Date.now();
  let out = '';
  let composerAt = null;
  let composerPos = -1;
  const queries = [];
  let statusLineAt = null;
  term.ws.on('message', (d) => {
    const s = d.toString('utf8');
    const before = out.length;
    out += s;
    const now = Date.now() - t0;
    // Every query, by byte position, so "the second one" is countable.
    let k = Math.max(0, before - QUERY.length);
    while ((k = out.indexOf(QUERY, k)) >= 0) {
      if (!queries.some((q) => q.pos === k)) queries.push({ pos: k, at: now });
      k += QUERY.length;
    }
    if (composerAt === null && out.includes(COMPOSER)) { composerAt = now; composerPos = out.indexOf(COMPOSER); }
    if (statusLineAt === null && composerAt !== null && /bypass permissions|Opus|Sonnet/.test(s) && /\|/.test(s)) statusLineAt = now;
  });
  try {
    for (let i = 0; i < 120 && composerAt === null; i++) await sleep(100);
    if (composerAt === null) throw new Error('ABORT: no composer marker within 12 s - setup failure, not a verdict');
    if (delay === 'ready') {
      let ok = false;
      for (let i = 0; i < 600 && !ok; i++) {
        const r = await rowOf(cookie, id);
        ok = !!(r && r.agentReady === true);
        if (!ok) await sleep(25);
      }
      if (!ok) throw new Error('ABORT: the worker never reported agentReady - setup failure, not a verdict');
    } else if (delay) {
      await sleep(delay);
    }
    const sentAt = Date.now() - t0;
    const sentWall = Date.now();
    term.send(PROMPT + '\r');
    let turnAt = null;
    for (let i = 0; i < 40 && turnAt === null; i++) {
      await sleep(500);
      const r = await rowOf(cookie, id);
      const ta = r && r.brief && r.brief.turnAt;
      if (Number.isFinite(ta) && ta >= sentWall - 1000) turnAt = ta;
    }
    const verdict = turnAt !== null ? 'TURN' : 'NO-TURN';
    // The predicate under test: did the CR (text + GAP_MS) arrive after the query Claude
    // sends once its composer is up? Wall-clock on this side, so it is approximate by the
    // loopback latency - a few ms.
    // By BYTE POSITION, not time: a pre-banner query can arrive in the composer's own read.
    const post = queries.find((q) => q.pos > composerPos);
    const crAt = sentAt + GAP_MS;
    const crAfterQuery = !!post && crAt > post.at;
    console.log(JSON.stringify({ delay, verdict, composerAt, sentAt, crAt, postComposerQueryAt: post ? post.at : null, crAfterQuery, queriesAt: queries.map((q) => q.at), statusLineAt }));
    return { delay, verdict, crAfterQuery };
  } finally {
    term.close();
    await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  }
}

(async () => {
  writeProjectHooks(CWD);
  const cookie = await login();
  const results = [];
  for (let r = 0; r < repeats; r++) {
    for (const d of delays) results.push(await trial(cookie, d));
  }
  // A probe ABORTS on a setup failure rather than reporting a negative: if even the
  // longest delay never turned, the verdict source is broken, not the submit.
  const numeric = delays.filter((d) => typeof d === 'number');
  const control = numeric.length ? Math.max(...numeric) : 'ready';
  if (!results.some((x) => x.delay === control && x.verdict === 'TURN')) {
    console.error(`ABORT: no turn at the control delay (${control}) - hooks are not reaching the rig, so no verdict here means anything`);
    process.exit(3);
  }
  console.log('--- summary');
  for (const d of delays) {
    const rs = results.filter((x) => x.delay === d);
    console.log(`delay ${String(d).padStart(5)} ms: ${rs.filter((x) => x.verdict === 'TURN').length}/${rs.length} turned`
      + `  (CR after the post-composer query: ${rs.filter((x) => x.crAfterQuery).length}/${rs.length})`);
  }
  const agree = results.filter((x) => (x.verdict === 'TURN') === x.crAfterQuery).length;
  console.log(`predicate "CR after the post-composer query" matches the verdict in ${agree}/${results.length} trials`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(2); });
