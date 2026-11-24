#!/usr/bin/env node
'use strict';
// END-TO-END proof, on the ORPHAN RIG, of #510 with a REAL claude and the REAL Analyst:
//   a claude session asks an AskUserQuestion -> it is a `question` card (GET /api/mc/now);
//   GET /api/mc/questions/:cardId/context answers at all three levels;
//   POST .../followup asks about an option (twice) and POST .../suggest proposes options -
//   real model runs (counts and shapes printed, never their words);
//   the person's FINAL pick (the first suggestion) goes out as the question's `Other` answer,
//   through POST /api/sessions/:id/answer with the frames the companion builds
//   (buildAnswerFrames for one compact two-option question, pinned in
//   ai-terminal/test/mc_question_test.dart);
//   and the session's TRANSCRIPT (the ground truth) holds exactly ONE answer to the question -
//   the pick - and no user turn carries a follow-up's words.
// Nothing here touches production.
//
// HOOKS: the session runs in a folder whose project settings send hooks to the rig
// (rig-http.js writeProjectHooks). Start the rig with CLAUDE* scrubbed from the env:
//   env $(env | grep -o '^CLAUDE[A-Z_]*' | sed 's/^/-u /') node scripts/rig/rig.js up
//   node scripts/rig/verify-mc-question.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { login, api, writeProjectHooks } = require('./rig-http');
const { openTerminal } = require('./rig-ws');
const { claudeProjectDirName } = require('../../lib/transcript');

const RIG = require('../scratch-dirs').DIRS.rig;
const FOLLOWUPS = ['Which of the two is easier to read for colour-blind users?', 'What would change in the code if I pick this one?'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A follow-up or a suggestion is a model run: past the helper's default 8 s, and never retried.
const MODEL = { timeout: 150000 };
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

/** What the session's own transcript holds: the AskUserQuestion results, and the user turns
 *  that carry any of [words]. */
function transcriptFacts(cwd, conv, words) {
  const file = path.join(os.homedir(), '.claude', 'projects', claudeProjectDirName(cwd), `${conv}.jsonl`);
  if (!fs.existsSync(file)) return { file, answers: null, leaked: null };
  const askIds = new Set();
  const answers = [];
  let leaked = 0;
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use' && c.name === 'AskUserQuestion') askIds.add(c.id);
      if (c && c.type === 'tool_result' && askIds.has(c.tool_use_id)) answers.push(JSON.stringify(c.content));
    }
    if (j.type === 'user' && words.some((w) => JSON.stringify(j.message || {}).includes(w))) leaked += 1;
  }
  return { file, answers, leaked };
}

(async () => {
  const cookie = await login();
  let id = null;
  let pass = false;
  try {
    const cwd = path.join(RIG, 'mc-question');
    writeProjectHooks(cwd);
    ({ id } = await api(cookie, 'POST', '/api/sessions', {
      name: `mc-question-${Date.now().toString(36)}`, cwd, agent: 'claude', autoCommand: 'claude --dangerously-skip-permissions',
    }));
    say(`session ${id}`);
    await until(async () => (await rowOf(cookie, id))?.agentReady === true, 'the composer', 90000);
    const term = await openTerminal(cookie, id);
    await sleep(2000);
    term.send('This is a test of Mission Control. Use the AskUserQuestion tool to ask me exactly ONE question, single '
      + 'select, no previews: question "Which colour should the Save button be?", header "Colour", options "Red" '
      + '(description "warm, draws the eye") and "Blue" (description "calm, matches the theme"). After I answer, reply '
      + 'with one sentence naming my answer and end your turn. Do nothing else.\r');
    term.close();
    const card = await until(async () => {
      const now = await api(cookie, 'GET', '/api/mc/now');
      return now.answerNow.find((c) => c.sessionId === id && c.kind === 'question') || null;
    }, 'its question card', 240000);
    say(`card ${card.id} kind ${card.kind}`);

    const enc = encodeURIComponent(card.id);
    for (const level of ['ask', 'context', 'everything']) {
      const c = await api(cookie, 'GET', `/api/mc/questions/${enc}/context?level=${level}`);
      say(`context ${level}: sections [${c.sections.map((s) => s.title).join(', ')}]; options ${c.ask.options.length}; canSuggest ${c.ask.canSuggest}`);
    }
    for (const [i, q] of FOLLOWUPS.entries()) {
      const f = await api(cookie, 'POST', `/api/mc/questions/${enc}/followup`, { option: i % 2, question: q }, MODEL);
      say(`follow-up ${i + 1}: option ${f.option}; answer ${typeof f.answer === 'string' ? f.answer.length : 'none'} chars; sources ${(f.sources || []).length}; ${f.status || 'ok'}`);
    }
    const sug = await api(cookie, 'POST', `/api/mc/questions/${enc}/suggest`, {}, MODEL);
    say(`suggest: ${(sug.options || []).length} options (labels ${(sug.options || []).map((o) => o.label.length).join('/')} chars); canSend ${sug.canSend}`);
    const pick = sug.options && sug.options[0] ? sug.options[0].label : 'Green';

    // The person's final pick, as the companion sends it: buildAnswerFrames(questions, [{}],
    // otherText: [pick]) for one compact two-option question = the "Type something." row's
    // digit, the text as a bracketed paste, Enter (pinned in mc_question_test.dart).
    const esc = String.fromCodePoint(0x1b);
    const frames = [{ keys: '3', delayMs: 600 }, { keys: `${esc}[200~${pick}${esc}[201~`, delayMs: 600 }, { keys: '\r', delayMs: 0 }];
    const sent = await api(cookie, 'POST', `/api/sessions/${id}/answer`, { frames });
    say(`answer sent: ${JSON.stringify(sent)}`);

    const done = await until(async () => {
      const r = await rowOf(cookie, id);
      return r && r.status === 'idle' && r.brief && Number.isFinite(r.brief.stoppedAt) && r.brief.stoppedAt >= r.brief.turnAt ? r : null;
    }, 'the turn after the answer to end', 180000);
    const conv = done.agentSessionId || done.claudeSessionId;
    await sleep(3000);
    const facts = transcriptFacts(cwd, conv, [...FOLLOWUPS, ...(sug.options || []).slice(1).map((o) => o.label)]);
    say(`transcript ${path.basename(facts.file)}: ${facts.answers ? facts.answers.length : 'no'} AskUserQuestion answer(s); `
      + `the pick in it: ${facts.answers ? facts.answers.some((a) => a.includes(pick)) : false}; user turns with a follow-up or another suggestion: ${facts.leaked}`);
    pass = !!facts.answers && facts.answers.length === 1 && facts.answers[0].includes(pick) && facts.leaked === 0;
  } finally {
    if (id) await api(cookie, 'DELETE', `/api/sessions/${id}`).catch(() => {});
  }
  console.log(pass ? '[verify] PASS - the session got ONE answer, the pick; no follow-up or other suggestion reached it.' : '[verify] FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('[verify] error:', e.message); process.exit(1); });
