'use strict';
// --- Mission Control: questions with context on demand (#510) ------------------------------
// An Answer-now card (#506) is a session stuck on the person: an AskUserQuestion on screen, a
// decision card (#492), a reported "you" wait. Before answering, the person can:
//   - read it at three levels (`buildContext`): JUST THE ASK (+ the recommendation), CONTEXT
//     (the work item, what the session did, what each answer does, the inbox digest when one is
//     cached) and EVERYTHING (the last turns, every link). Built from data the server already
//     holds, on demand, with no model run and never on a poll;
//   - ask about one option (`followupInput` + `followupPrompt`): the Analyst (#511) answers,
//     from the asking session's bundle plus the card itself;
//   - have the Analyst suggest more options (`suggestPrompt` + `parseSuggestions`).
// NONE of it types into the waiting session: the follow-ups and suggestions are tools-off model
// runs (lib/mc-analyst.js, lib/model-cli.js); only the person's final pick reaches the session,
// through the companion's existing answer path.
//
// The ask's own text (the question, the options) was written by an agent: in a model prompt it
// sits INSIDE the Analyst's data fence (`withAskBlock`), and the person's question outside it
// names an option by its number only.
//
// Pure. server.js reads the card, the row, the pending question, the digest, the recap and the
// tracker cache, and owns the HTTP shape. HOT-RELOAD ONLY: loaded by server.js alone.

const { cliJsonObject } = require('./model-cli');
const mcAnalyst = require('./mc-analyst');

const { clip, toMs, ageText, textAt } = mcAnalyst;

const LEVELS = Object.freeze(['ask', 'context', 'everything']);
const CARD_ID_MAX = 400;
/** A suggestion is sent as an answer: the decision card's own label cap (lib/session-brief.js). */
const SUGGEST_LABEL_MAX = 80;
const SUGGEST_CONSEQUENCE_MAX = 240;
const SUGGEST_MAX = 4;
const RECAP_PROMPTS_SHOWN = 3;
// Every C0 control, DEL and the C1 range: a suggested label is one line of plain words.
const CONTROL_RE = new RegExp(`[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}]+`, 'g');

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// --- the request -----------------------------------------------------------------------------

/** `:cardId` -> the id, or null when it cannot be a card id. */
function cardIdOf(raw) {
  const id = typeof raw === 'string' ? raw : '';
  return id && id.length <= CARD_ID_MAX ? id : null;
}

/** `?level=` -> a level; absent is `ask`; anything else null. */
function levelOf(raw) {
  if (raw === undefined || raw === null || raw === '') return 'ask';
  return LEVELS.includes(raw) ? raw : null;
}

// --- what the card asks ---------------------------------------------------------------------

/** Claude marks a recommended option in its label. */
const RECOMMENDED_RE = /\(recommended\)/i;

/**
 * What the card puts to the person, from the card and (for a question on screen) the live
 * AskUserQuestion. `options` is FLAT across the questions, numbered from 0 (`index`), each
 * naming its question (`question`); the follow-up route takes that index.
 * @returns {{kind, questions: [{text, header, multiSelect, hasPreview}], options: [{index, question, label, detail, recommended}],
 *   recommended: number|null, context: string|null, canSuggest: boolean}}
 */
function askOf(card, pending) {
  const out = { kind: card.kind, questions: [], options: [], recommended: null, context: null, canSuggest: false };
  const add = (qi, label, detail, recommended) => {
    const o = { index: out.options.length, question: qi, label: str(label) || '(no label)', detail: str(detail), recommended: !!recommended };
    out.options.push(o);
    if (recommended && out.recommended === null) out.recommended = o.index;
  };
  const d = card.decision;
  // #526: an ask is a decision answered like the wait it is not (a reply).
  if ((card.kind === 'decision' || card.kind === 'ask') && d && typeof d === 'object') {
    out.questions.push({ text: str(d.question) || str(card.what) || '', header: null, multiSelect: false, hasPreview: false });
    out.context = str(d.context);
    (Array.isArray(d.options) ? d.options : []).forEach((o, i) => add(0, o && o.label, o && o.consequence, d.recommended === i));
    out.canSuggest = true;
    return out;
  }
  const qs = pending && Array.isArray(pending.questions) ? pending.questions : [];
  if (card.kind === 'question' && qs.length) {
    qs.forEach((q, qi) => {
      out.questions.push({ text: str(q && q.question) || '', header: str(q && q.header), multiSelect: !!(q && q.multiSelect), hasPreview: !!(q && q.hasPreview) });
      for (const o of Array.isArray(q && q.options) ? q.options : []) add(qi, o && o.label, o && o.description, RECOMMENDED_RE.test((o && o.label) || ''));
    });
    // A free-text answer exists only through `Other`: one question, compact (CLAUDE.md
    // "AskUserQuestion" - side-by-side has no Other row).
    out.canSuggest = qs.length === 1 && !(qs[0] && qs[0].hasPreview);
    return out;
  }
  // A reported wait (or a question whose text could not be read, or a permission prompt):
  // the ask is its words. A wait (and a possible unreported question, #526: the sentence the
  // reply put) is answered by a reply, so any words can be suggested.
  out.questions.push({ text: str(card.what) || '', header: null, multiSelect: false, hasPreview: false });
  out.canSuggest = card.kind === 'wait' || card.kind === 'possible-ask';
  return out;
}

// --- context on demand ----------------------------------------------------------------------

function optionLine(o) {
  return `${o.index + 1}. ${o.label}${o.recommended ? ' (recommended)' : ''}`;
}

function askSection(ask) {
  const lines = [];
  ask.questions.forEach((q, qi) => {
    if (ask.questions.length > 1) lines.push(`Question ${qi + 1}${q.header ? ` (${q.header})` : ''}: ${q.text}`);
    else lines.push(q.text || '(the ask has no words)');
    if (q.multiSelect) lines.push('(more than one can be picked)');
    for (const o of ask.options.filter((x) => x.question === qi)) lines.push(optionLine(o));
  });
  return { title: 'The ask', body: lines.join('\n') };
}

function recommendationSection(ask) {
  const o = ask.recommended === null ? null : ask.options[ask.recommended];
  return { title: 'Recommendation', body: o ? `Option ${o.index + 1}: ${o.label}` : 'The agent did not recommend an option.' };
}

/**
 * The card at one [level]: `{level, text, sections: [{title, body}], sources, ask}`.
 * @param {object} a
 * @param {object} a.card      the Answer-now card (lib/mc-needs.js)
 * @param {object} a.ask       askOf's result
 * @param {object|null} a.row  the session's cluster row (its reported brief)
 * @param {object|null} a.meta the subject's tracker details from the CACHE (never a read)
 * @param {object|null} a.digest  the session's cached inbox digest (status 'ready'), else null
 * @param {object|null} a.recap   the session's recap (level everything), else null
 * @param {number} a.now
 */
function buildContext({ card, level, ask, row = null, meta = null, digest = null, recap = null, now }) {
  const sources = [];
  const source = (src) => { const id = `S${sources.length + 1}`; sources.push({ id, ...src }); return id; };
  const server = str(card.server);
  const name = str(card.sessionName) || card.sessionId;
  source({ kind: 'session', label: name, server, sessionId: card.sessionId, at: toMs(card.askedAt), url: null });
  const sections = [askSection(ask), recommendationSection(ask)];

  if (level !== 'ask') {
    const m = meta && meta.fetchedAt ? meta : null;
    const itemLines = [];
    if (card.ref || card.subjectKey) {
      const title = (m && m.title) || card.title;
      itemLines.push(`${card.ref || card.subjectKey}${title ? ` ${title}` : ''}`);
      if (m) {
        const bits = [m.type, m.state && `state ${m.state}`, m.closed ? 'closed' : 'open',
          Number.isFinite(m.severity) && `severity ${m.severity}`, Number.isFinite(m.priority) && `priority ${m.priority}`,
          m.assignee && `assigned to ${m.assignee}`].filter(Boolean);
        itemLines.push(`${bits.join(', ')} (tracker read ${ageText(m.fetchedAt, now)})`);
        for (const pr of Array.isArray(m.prs) ? m.prs.slice(0, 5) : []) {
          if (pr && pr.url) itemLines.push(`Pull request #${pr.number || '?'}: ${pr.state || 'state unknown'}${pr.draft ? ' (draft)' : ''}`);
        }
      } else {
        itemLines.push('No tracker details are cached yet: only what the session reported is known.');
      }
      source({ kind: 'workitem', label: card.ref || card.subjectKey, server: null, sessionId: null, at: m ? toMs(m.fetchedAt) : null, url: (m && m.url) || null });
    } else {
      itemLines.push('This wait names no work item.');
    }
    sections.push({ title: 'The work item', body: itemLines.join('\n') });

    const b = (row && row.brief) || {};
    const did = [];
    if (b.headline) did.push(`Headline: ${clip(b.headline, 400)}`);
    for (const it of Array.isArray(b.items) ? b.items : []) {
      const bits = [it.key || it.ref, it.title, it.state && `state ${it.state}`, it.note && `note: ${clip(it.note, 200)}`].filter(Boolean);
      if (bits.length) did.push(`Work item: ${bits.join(' - ')}`);
    }
    const lastDid = textAt(b.did);
    if (lastDid.text) did.push(`Last turn: ${clip(lastDid.text, 800)} (${ageText(lastDid.at, now)})`);
    const nowLine = textAt(b.now);
    if (nowLine.text) did.push(`Doing now: ${clip(nowLine.text, 200)}`);
    const prompt = textAt(b.prompt);
    if (prompt.text) did.push(`Your last prompt: ${clip(prompt.text, 400)} (${ageText(prompt.at, now)})`);
    if (!did.length) did.push('The session has not reported what it did.');
    else source({ kind: 'report', label: `${name}: report`, server, sessionId: card.sessionId, at: toMs(b.reportAt), url: null });
    sections.push({ title: 'What the session did', body: did.join('\n') });

    if (ask.context) sections.push({ title: 'Why it asks', body: ask.context });
    if (ask.options.length) {
      sections.push({ title: 'What each answer does', body: ask.options.map((o) => `${optionLine(o)}: ${o.detail || 'not said'}`).join('\n') });
    }
    if (digest && digest.status === 'ready') {
      const lines = [];
      if (digest.about) lines.push(clip(digest.about, 600));
      for (const a of Array.isArray(digest.asking) ? digest.asking : []) lines.push(`- ${clip(a, 300)}`);
      for (const k of Array.isArray(digest.know) ? digest.know : []) lines.push(`- ${clip(k, 300)}`);
      if (lines.length) sections.push({ title: 'Summary (inbox digest)', body: lines.join('\n') });
    }
  }

  if (level === 'everything') {
    const lines = [];
    if (recap && !recap.error) {
      const prompts = Array.isArray(recap.prompts) && recap.prompts.length ? recap.prompts : (recap.prompt ? [recap.prompt] : []);
      for (const p of prompts.slice(0, RECAP_PROMPTS_SHOWN)) {
        const t = textAt(p);
        if (t.text) lines.push(`You (${ageText(t.at, now)}): ${clip(t.text, 600)}`);
      }
      const reply = textAt(recap.reply);
      if (reply.text) lines.push(`The agent's latest reply (${ageText(reply.at, now)}): ${clip(reply.text, 1200)}`);
      const tools = recap.since && Array.isArray(recap.since.tools) ? recap.since.tools : [];
      if (tools.length) lines.push(`Since your prompt: ${recap.since.turns || 0} turns; tools ${tools.slice(0, 8).map((x) => (x && x.name) || String(x)).join(', ')}`);
      if (lines.length) source({ kind: 'recap', label: `${name}: recap`, server, sessionId: card.sessionId, at: reply.at, url: null });
    } else if (recap && recap.error) {
      lines.push(`The last turns could not be read: ${clip(recap.error, 80)}`);
    }
    if (!lines.length) lines.push('No turns could be read.');
    sections.push({ title: 'Last turns', body: lines.join('\n') });

    const links = [];
    const m = meta && meta.fetchedAt ? meta : null;
    if (m && m.url) links.push(`${card.ref || card.subjectKey}: ${m.url}`);
    for (const pr of m && Array.isArray(m.prs) ? m.prs.slice(0, 10) : []) {
      if (!pr || !pr.url) continue;
      links.push(`Pull request #${pr.number || '?'}: ${pr.url}`);
      source({ kind: 'pr', label: `PR ${pr.repo || ''}#${pr.number || '?'}`, server: null, sessionId: null, at: toMs(m.fetchedAt), url: pr.url });
    }
    links.push(`Session: ${name}${server ? ` on ${server}` : ''} (id ${card.sessionId})`);
    sections.push({ title: 'Links', body: links.join('\n') });
  }

  const text = sections.map((s) => `${s.title}\n${s.body}`).join('\n\n');
  return { level, text, sections, sources, ask };
}

// --- the Analyst's calls ---------------------------------------------------------------------

/** The follow-up body -> `{ok, option: number|null, question}` or `{ok:false, error}`. */
function followupInput(body, ask) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  if (!question) return { ok: false, error: 'question is required' };
  if (question.length > mcAnalyst.QUESTION_MAX) return { ok: false, error: `question is longer than ${mcAnalyst.QUESTION_MAX} characters` };
  if (b.option === undefined || b.option === null) return { ok: true, option: null, question };
  if (!Number.isInteger(b.option) || b.option < 0 || b.option >= ask.options.length) {
    return { ok: false, error: ask.options.length ? `option must be an option's index, 0-${ask.options.length - 1}, or null` : 'this card has no options: option must be null' };
  }
  return { ok: true, option: b.option, question };
}

/** The bundle with the card's own block last, as one more source the model may cite. The
 *  block is agent text: it goes inside the fence with the rest of the bundle. */
function withAskBlock(bundle, { card, ask, now }) {
  const id = `S${bundle.sources.length + 1}`;
  const src = { id, kind: 'session', label: `${clip(card.sessionName || card.sessionId, 80)}: the waiting question`,
    server: str(card.server), sessionId: card.sessionId, at: toMs(card.askedAt), url: null };
  const lines = [`[${id}] THE QUESTION WAITING FOR THE PERSON (asked ${ageText(card.askedAt, now)}), from session "${clip(card.sessionName || card.sessionId, 120)}":`];
  ask.questions.forEach((q, qi) => {
    lines.push(`  question${ask.questions.length > 1 ? ` ${qi + 1}` : ''}: ${clip(q.text, 600)}${q.multiSelect ? ' (more than one can be picked)' : ''}`);
    for (const o of ask.options.filter((x) => x.question === qi)) {
      lines.push(`  option ${o.index + 1}: "${clip(o.label, 120)}"${o.detail ? ` - ${clip(o.detail, 300)}` : ''}${o.recommended ? ' (the agent recommends it)' : ''}`);
    }
  });
  if (ask.context) lines.push(`  why it asks: ${clip(ask.context, 800)}`);
  return { ...bundle, text: `${bundle.text}\n${lines.join('\n')}`, sources: [...bundle.sources, src], askId: id };
}

const ROLE_FOLLOWUP = 'You help a person decide how to answer a question a coding agent is waiting on. Nothing you say reaches the agent; the person decides.';
const ROLE_SUGGEST = 'You help a person answer a question a coding agent is waiting on, by proposing OTHER answers they could give. Nothing you say reaches the agent; the person picks.';

/** The follow-up's model stdin. The person's words sit after the fence; the option is named
 *  by its number only. */
function followupPrompt({ bundle, input, scope, now, nonce }) {
  const about = input.option === null
    ? `About the waiting question [${bundle.askId}]:`
    : `About option ${input.option + 1} of the waiting question [${bundle.askId}]:`;
  return mcAnalyst.buildPrompt({ question: `${about} ${input.question}`, scope, bundle, now, nonce, role: ROLE_FOLLOWUP });
}

const SUGGEST_REPLY = Object.freeze([
  'Reply with ONE JSON object and nothing else (no code fence), exactly:',
  '{"options": [{"label": string, "consequence": string}], "sources": [string]}',
  `- options: 2 to ${SUGGEST_MAX} answers the person could give that are NOT among the options already`,
  `  offered. label: the answer itself, one line, at most ${SUGGEST_LABEL_MAX} characters, written as the person`,
  `  would send it. consequence: what the agent would then do, at most ${SUGGEST_CONSEQUENCE_MAX} characters.`,
  '- sources: the ids of the blocks the suggestions rely on, most important first (at most 20).',
]);

function suggestPrompt({ bundle, scope, now, nonce }) {
  return mcAnalyst.buildPrompt({
    question: `Suggest more options for the waiting question [${bundle.askId}].`,
    scope, bundle, now, nonce, role: ROLE_SUGGEST, reply: SUGGEST_REPLY,
  });
}

function oneLine(s, n) {
  return mcAnalyst.cutAt(String(s || '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim(), n);
}

/** stdout -> `{options: [{label, consequence}], cited}` or null. A label already offered (no
 *  case), given twice, or starting with ! or / is dropped; at least one must be left. */
function parseSuggestions(stdout, offeredIds, existingLabels = []) {
  const obj = cliJsonObject(stdout, { bareKey: 'options' });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Array.isArray(obj.options)) return null;
  const seen = new Set(existingLabels.map((l) => String(l || '').trim().toLowerCase()));
  const options = [];
  for (const o of obj.options) {
    if (options.length >= SUGGEST_MAX) break;
    const label = oneLine(o && o.label, SUGGEST_LABEL_MAX);
    // A label is sent as the answer: one starting with ! or / would run as a shell or slash
    // command at a wait's reply, not be read as words. Never offered.
    if (!label || seen.has(label.toLowerCase()) || /^[!/]/.test(label)) continue;
    seen.add(label.toLowerCase());
    options.push({ label, consequence: oneLine(o && o.consequence, SUGGEST_CONSEQUENCE_MAX) || null });
  }
  if (!options.length) return null;
  return { options, cited: mcAnalyst.citedIds(obj.sources, '', offeredIds) };
}

module.exports = {
  LEVELS, SUGGEST_LABEL_MAX, SUGGEST_CONSEQUENCE_MAX, SUGGEST_MAX,
  cardIdOf, levelOf, askOf, buildContext, followupInput, withAskBlock, followupPrompt, suggestPrompt, parseSuggestions,
};
