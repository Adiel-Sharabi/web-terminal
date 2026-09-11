'use strict';
// --- Session recap: "where was I in this one?" -------------------------------
// With a dozen sessions open, the sidebar answers *that* something is running,
// never *what*. This module turns a transcript tail into the three facts that
// actually re-orient you: what you last ASKED, what the agent last SAID, and what
// it has been DOING since.
//
// PURE by design — turns in, a recap object out. No fs, no net, no agent
// knowledge. The caller (server.js) hands us typed turns from whichever adapter
// parsed the file, so Claude and Codex are covered without a single branch, and
// every rule below is unit-testable against hand-written turns.
//
// THE HARD PART IS "MY LAST PROMPT", AND IT IS NOT `role === 'user'`.
// A transcript is full of user-role turns the human never typed: another
// session's message, a task-notification, Stop-hook feedback, a post-compaction
// summary, and — the one that bites hardest — slash commands. Running `/compact`
// writes a user turn whose text is `<command-name>/compact</command-name>`; take
// the newest user turn naively and the recap proudly reports that your last
// prompt was "compact". Worse, real prompts arrive with `<system-reminder>`
// blocks stapled to them, so even a genuine prompt needs its wrapper stripped or
// the recap shows a screenful of injected instructions instead of your sentence.
//
// So: classify, strip, and only then take the newest surviving HUMAN turn. That
// classification now lives in `lib/user-turn.js` — see the note on the require
// below; this module owns what a recap DOES with it.
const { extractSummary } = require('./speech');
// The `role:user` classification rule lives in its own dependency-free module so
// `lib/transcript.js` can use it too (#149) — requiring recap.js from there would
// close the cycle recap -> speech -> transcript. Re-exported below so every
// existing importer of `recap.classifyUserTurn` / `recap.USER_KINDS` is untouched.
const { classifyUserTurn, kindOfTurn, USER_KINDS } = require('./user-turn');

// How much of each field survives into the recap. The prompt gets the most room
// because it is the user's own words and recognition is the whole point — a
// prompt cut to a stub defeats the feature. The reply is a reminder, not a
// re-read: the chat lens is one click away.
const PROMPT_CHARS = 400;
const REPLY_CHARS = 280;
// How many recent tool calls to name. Past a handful it stops being a glance.
const MAX_TOOLS = 4;

// ONE PROMPT IS NOT ENOUGH STATE TO RE-ORIENT ON (#246). Reported from the phone
// as "that was not my last prompt": the selection was CORRECT - a 13h-old prompt
// with 598 turns and ~40 injected user turns behind it, every one of them
// classified right - and the card was still useless, because the single thing it
// led with was the least current thing on it.
//
// Three is the smallest number that is a TRAIL rather than a reading: it shows
// CADENCE (three sends in one minute, then silence for half a day) where one
// entry can only show a moment. It is also what the card has room for - the older
// entries are one line each on a phone bottom sheet, and past three that sheet
// becomes a scroll, which is the opposite of a glance.
const MAX_PROMPTS = 3;
// The older entries are a one-line trail, so they get their own much smaller
// budget. K prompts therefore cost PROMPT_CHARS + (K-1) * PROMPT_TRAIL_CHARS on
// the wire, never K * PROMPT_CHARS - the same "not K times the cost" rule the
// caller's backward walk obeys. 140 is well past what one ellipsised line shows
// on a phone, so a client is free to give a row two lines without ever
// approaching the newest prompt's budget.
const PROMPT_TRAIL_CHARS = 140;

/// True when [turn] is a prompt the USER actually typed.
///
/// Asks [kindOfTurn], not [classifyUserTurn], because the parser may have seen
/// something the text cannot show: a skill body is injected as a `role:user` turn
/// with the whole SKILL.md and NO wrapper, and only the transcript record's
/// `isMeta` flag distinguishes it from a prompt (#163). A turn carrying no
/// recorded verdict — a Codex rollout turn, a page built before that shipped —
/// falls back to the text rule unchanged.
function isHumanPrompt(turn) {
  return Boolean(turn) && turn.role === 'user' && kindOfTurn(turn) === USER_KINDS.HUMAN;
}

/// Indexes of the newest [max] human prompts in [turns] (newest-LAST), returned
/// NEWEST FIRST, or [].
///
/// Exported because the CALLER has to page the transcript backward until this
/// finds something — and it must ask the question with exactly the rule
/// [buildRecap] will later apply, or the scan stops on a turn the build then
/// rejects. Measured on the live fleet: 3 of 12 sessions had **zero** user turns
/// in their newest 80, because one tool-heavy stretch produces enough turns to
/// bury the prompt. The same sessions had 1–5 human prompts within 200. A fixed
/// window is therefore not a tuning choice, it is a correctness bug — hence
/// paging rather than a bigger constant.
///
/// It answers "how many so far", not just "any", because the caller's stop
/// condition is now K prompts rather than one (#246). Capped at [max] so the
/// count a caller loops on can never grow without bound on a chatty page.
function findHumanPromptIndexes(turns, max = MAX_PROMPTS) {
  const list = Array.isArray(turns) ? turns : [];
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < max; i--) {
    if (isHumanPrompt(list[i])) out.push(i);
  }
  return out;
}

/// Index of the newest human prompt in [turns] (newest-LAST), or -1.
/// The one-prompt form of [findHumanPromptIndexes], kept because that is the
/// question most callers ask.
function findHumanPromptIndex(turns) {
  const [i] = findHumanPromptIndexes(turns, 1);
  return i === undefined ? -1 : i;
}

// A fenced code block reads as noise in a one-line recap and eats the whole
// budget. Same reasoning as lib/speech.js, different medium.
const FENCE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n?[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g;

/// Squeezes [text] to at most [maxChars] of single-spaced prose for a one-glance
/// card. Cuts on a word boundary so the tail is not a severed word, and marks the
/// cut with an ellipsis so a truncated recap is never mistaken for a short one.
function condense(text, maxChars) {
  let s = typeof text === 'string' ? text : '';
  if (!s) return '';
  s = s.replace(FENCE_RE, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const sp = cut.lastIndexOf(' ');
  return (sp > maxChars * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/// Names the tools used across [turns], newest first, as `Edit ×3` style labels.
/// Deliberately a TALLY rather than a list: "what has it been doing" is answered
/// by `Bash ×7, Edit ×2`, not by seven identical rows.
function toolTally(turns, max = MAX_TOOLS) {
  const counts = new Map();
  for (let i = turns.length - 1; i >= 0; i--) {
    for (const tu of (turns[i] && turns[i].toolUses) || []) {
      const name = tu && tu.name;
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}

/// Builds the recap from a transcript tail. [turns] are newest-LAST, exactly as
/// `scanTurnsBackward` returns them.
///
/// Returns:
///   prompt   {text, at, truncated} | null  — the newest turn the USER typed
///   prompts  [{text, at, truncated}]       — that turn and up to MAX_PROMPTS-1
///                                            older ones, NEWEST FIRST (#246)
///   reply    {text, at, isSummary} | null  — the agent's newest prose since then
///   since    {turns, tools}                — work done after the NEWEST prompt
///
/// `prompt` IS `prompts[0]` — the same object, not a second derivation — so the
/// list is a strictly additive field and a client that has not been rebuilt keeps
/// rendering exactly what it renders today.
///
/// `reply` prefers an author-marked TL;DR/Summary (lib/speech.js's extractSummary,
/// reused rather than re-implemented) because that section is written to be
/// exactly this: the standalone recap of a long answer.
///
/// A null `prompt` is a normal answer, not an error: an agent started by an
/// autoCommand may genuinely have no human turn in the scanned window.
function buildRecap(turns, opts = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const promptChars = opts.promptChars || PROMPT_CHARS;
  const trailChars = opts.trailChars || PROMPT_TRAIL_CHARS;
  const replyChars = opts.replyChars || REPLY_CHARS;

  // Newest human prompts, walking backward. The first keeps the full budget
  // because it is the one you are most likely still acting on; the rest are the
  // trail that says how long ago that was in your OWN sends (#246).
  const promptIdxs = findHumanPromptIndexes(list, opts.maxPrompts || MAX_PROMPTS);
  const prompts = promptIdxs.map((idx, n) =>
    promptEntry(list[idx], n === 0 ? promptChars : trailChars));
  const promptIdx = promptIdxs.length ? promptIdxs[0] : -1;

  // Newest assistant PROSE after that prompt. Tool-only turns carry no text and
  // are skipped — "what did it say" is not answered by a tool call. When there is
  // no prompt in the window, fall back to the newest prose overall so a recap of
  // an autoCommand session is still useful.
  let reply = null;
  for (let i = list.length - 1; i > promptIdx; i--) {
    const t = list[i];
    if (!t || t.role !== 'assistant') continue;
    const text = (t.text || '').trim();
    if (!text) continue;
    const summary = extractSummary(text);
    reply = {
      text: condense(summary || text, replyChars),
      at: t.ts || null,
      isSummary: Boolean(summary),
    };
    break;
  }

  // Work done since the prompt: how many turns, and which tools.
  const after = promptIdx >= 0 ? list.slice(promptIdx + 1) : [];
  const since = { turns: after.length, tools: toolTally(after) };

  return {
    prompt: prompts[0] || null,
    prompts,
    reply,
    since,
  };
}

/// One prompt as the card carries it: the typed words, when, and whether the cut
/// shows. [maxChars] is the caller's budget — the newest prompt gets the full one,
/// the trail a much smaller one.
function promptEntry(turn, maxChars) {
  const text = condense(classifyUserTurn(turn.text).body, maxChars);
  // U+2026 is condense's own cut marker, written as an escape rather than a
  // literal: a non-ASCII source character is invisible in a diff and normalises
  // in transit, which this repo has paid for more than once.
  return { text, at: turn.ts || null, truncated: text.endsWith('\u2026') };
}

/// Reduces a task list (lib/task-list.js item shape) to the two numbers and the
/// one title a recap card has room for: `{ done, total, current }`.
///
/// `current` is the in-progress task, falling back to the first task not yet
/// done — because a list where nothing is marked in_progress still has an obvious
/// "next", and showing nothing there wastes the most useful line on the card.
/// Returns null for an absent or empty list so the card can omit the row entirely.
function summariseTasks(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let done = 0;
  let inProgress = null;
  let firstOpen = null;
  for (const it of items) {
    if (!it) continue;
    if (it.status === 'completed') { done++; continue; }
    if (it.status === 'in_progress' && !inProgress) inProgress = it;
    if (!firstOpen) firstOpen = it;
  }
  const pick = inProgress || firstOpen;
  return {
    done,
    total: items.length,
    current: pick ? (pick.subject || `Task #${pick.id}`) : null,
    currentIsActive: Boolean(inProgress),
  };
}

module.exports = {
  buildRecap,
  classifyUserTurn,
  isHumanPrompt,
  findHumanPromptIndex,
  findHumanPromptIndexes,
  condense,
  toolTally,
  summariseTasks,
  USER_KINDS,
  PROMPT_CHARS,
  PROMPT_TRAIL_CHARS,
  REPLY_CHARS,
  MAX_PROMPTS,
};
