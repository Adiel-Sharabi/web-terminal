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
// So: classify, strip, and only then take the newest surviving HUMAN turn.
const { extractSummary } = require('./speech');

// How much of each field survives into the recap. The prompt gets the most room
// because it is the user's own words and recognition is the whole point — a
// prompt cut to a stub defeats the feature. The reply is a reminder, not a
// re-read: the chat lens is one click away.
const PROMPT_CHARS = 400;
const REPLY_CHARS = 280;
// How many recent tool calls to name. Past a handful it stops being a glance.
const MAX_TOOLS = 4;

/// The kinds of `role:user` turn. Only `human` is a prompt the user typed.
const USER_KINDS = Object.freeze({
  HUMAN: 'human',
  TEAMMATE: 'teammate', // another agent session messaged this one
  SYSTEM: 'system',     // harness injection: task-notification, hook, compaction
  COMMAND: 'command',   // a slash command and its local output
});

// --- injection signatures ----------------------------------------------------
// Kept as named constants so a new harness wrapper is one line, and so the tests
// can enumerate them.
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const TEAMMATE_ID_RE = /teammate_id="([^"]*)"/;
const TEAMMATE_TAG_RE = /<\/?teammate-message[^>]*>/g;
const TASK_TAG_RE = /<\/?task-[a-z-]+>/g;
const TASK_AGENT_RE = /Agent "([^"]+)"/;
const COMMAND_NAME_RE = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_TAG_RE = /<\/?(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/g;

// Inner text of the first <tag>…</tag>, trimmed, or '' when absent. Non-greedy so
// a `<uint32_t>` in a code sample cannot swallow the closing tag.
function _innerTag(s, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(s);
  return m ? m[1].trim() : '';
}

/// Classifies one `role:user` turn's [text] and returns
/// `{ kind, from, body }` — `body` being the readable text with the injection
/// wrapper (and any `<system-reminder>` blocks) removed.
///
/// A turn matching no signature is `human` with the reminders stripped. If
/// stripping leaves nothing, it was pure injection and is reported as `system`,
/// so it can never be mistaken for something the user typed.
///
/// This is the JS twin of `classifyUserTurn` in the companion's
/// conversation_view.dart, which does the same job for BUBBLE LABELLING. Two
/// copies of one rule is a drift risk and is tracked as such: the server copy is
/// the authority, and it recognises strictly more (slash commands,
/// system-reminders) because a recap is ruined by a false prompt in a way a
/// mislabelled bubble is not. Consolidating the Dart side onto a server-published
/// field is a separate, additive change.
function classifyUserTurn(text) {
  const raw = typeof text === 'string' ? text : '';
  const t = raw.trimStart();

  // Another agent session's message (multi-agent / workflow).
  if (t.startsWith('Another Claude session sent a message') || t.startsWith('<teammate-message')) {
    const id = (TEAMMATE_ID_RE.exec(t) || [])[1] || '';
    const body = t
      .replace('Another Claude session sent a message:', '')
      .replace(TEAMMATE_TAG_RE, '')
      .trim();
    return { kind: USER_KINDS.TEAMMATE, from: id.trim(), body };
  }

  // Harness task/agent notification injected as a user turn.
  if (t.startsWith('<task-notification')) {
    const result = _innerTag(t, 'result');
    const summary = _innerTag(t, 'summary');
    const agent = ((TASK_AGENT_RE.exec(summary) || [])[1] || '').trim();
    const body = result || summary ||
      t.replace(TASK_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
    return { kind: USER_KINDS.SYSTEM, from: agent || 'Task update', body };
  }

  // Stop-hook feedback fires on the user's behalf — not typed by them.
  if (t.startsWith('Stop hook feedback')) {
    return { kind: USER_KINDS.SYSTEM, from: 'Hook', body: t.replace('Stop hook feedback:', '').trim() };
  }

  // Post-compaction summary, re-injected as a user turn on continue.
  if (t.startsWith('This session is being continued')) {
    return { kind: USER_KINDS.SYSTEM, from: 'Session continued', body: t };
  }

  // A slash command. THE trap this module exists to avoid: `/compact` and friends
  // land as ordinary user turns, and the newest user turn in a just-compacted
  // session is almost always one of them. Matched by the tag OR by the caveat
  // prose, because the caveat arrives without the tag when the command produced
  // stdout.
  if (t.startsWith('<local-command-caveat') || t.startsWith('<command-name>') ||
      t.startsWith('Caveat: The messages below were generated by the user while running local commands')) {
    const name = ((COMMAND_NAME_RE.exec(t) || [])[1] || '').trim();
    const body = t.replace(COMMAND_TAG_RE, ' ').replace(/\s+/g, ' ').trim();
    return { kind: USER_KINDS.COMMAND, from: name ? `/${name.replace(/^\//, '')}` : 'command', body };
  }

  // Looks human. Strip the reminder blocks that ride along with real prompts —
  // they are injected context, not part of the sentence the user wrote.
  const body = raw.replace(SYSTEM_REMINDER_RE, '').trim();
  if (!body) {
    // The turn was nothing BUT injected context. Not a prompt.
    return { kind: USER_KINDS.SYSTEM, from: 'Context', body: '' };
  }
  return { kind: USER_KINDS.HUMAN, from: '', body };
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
///   reply    {text, at, isSummary} | null  — the agent's newest prose since then
///   since    {turns, tools}                — work done after the prompt
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
  const replyChars = opts.replyChars || REPLY_CHARS;

  // Newest human prompt, walking backward.
  let promptIdx = -1;
  let promptBody = '';
  let promptAt = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (!t || t.role !== 'user') continue;
    const c = classifyUserTurn(t.text);
    if (c.kind !== USER_KINDS.HUMAN) continue;
    promptIdx = i;
    promptBody = c.body;
    promptAt = t.ts || null;
    break;
  }

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

  const promptText = condense(promptBody, promptChars);
  return {
    prompt: promptIdx >= 0
      ? { text: promptText, at: promptAt, truncated: promptText.endsWith('…') }
      : null,
    reply,
    since,
  };
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
  condense,
  toolTally,
  summariseTasks,
  USER_KINDS,
  PROMPT_CHARS,
  REPLY_CHARS,
};
