'use strict';
// --- #470 Supervisor phase 5: replacement sessions ------------------------------------------
//
// docs/SUPERVISOR-DESIGN.md section 8 (spawning a replacement), R7 (dead agent) and R8
// (capacity). A job whose session can no longer carry it gets a replacement session on the
// SAME machine (its working folder exists only there), linked through `replaces` so its lead's
// and its children's links still hold.
//
// Two ways, by whether the old session's agent still runs:
//   handoff  the agent runs: it writes its own brief. This is the #340 hand-off, started by the
//            supervisor (lib/handoff.js startRun trigger 'supervisor'): wrap-up prompt, brief,
//            verdict, successor, proof it is up, the old session closed only on a clean verdict.
//   dead     the agent is gone (R7): the SUPERVISOR writes the brief (briefText: the last
//            report and items, the tracker refs, the goal, the dispatcher's note, the last
//            turns), and the run starts at `spawning` with the server's own verdict. The
//            successor resumes the same conversation (`--resume`) when the transcript is sound,
//            and starts fresh from the brief otherwise.
//
// R7's FACT, measured on claude 2.1.325 (2026-11-16, a node-pty probe with an http hook): a
// `/exit` or Ctrl-C twice fires SessionEnd (reason `prompt_input_exit`) about 0.8 s before the
// process exits; a hard kill fires nothing. So SessionEnd marks a DELIBERATE exit, and a crash
// leaves no hook at all. "The agent died" is therefore: its process was SEEN under the
// session's shell and is gone now, and no SessionEnd came since its last hook. A deliberate
// exit is someone's choice and is never replaced. An agent whose process was never seen (an
// agent with no declared process name, a machine where it runs under another image) is never
// judged dead: it fails closed.
//
// R8: never spawn on a machine at its slot cap or below its free-commit floor; a commit that
// cannot be read refuses too (the floor exists because one box hung on commit exhaustion).
//
// Pure: no I/O, no clock (every function takes what it reads).

const { clip } = require('./session-brief');
const { HANDOFF_PROMPT_TAG: TAG } = require('./user-turn');
const { oneLine } = require('./one-line');

const _isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const GB = 1024 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest note the dispatcher may add to a brief, in characters. */
const NOTE_MAX = 1000;
/** Every prompt the server types stays under this (the #213 bracketing threshold). */
const PROMPT_BYTES_MAX = 511;

/// config.json `supervisor.spawn`, read on the session's OWN server (the floor is per machine):
///   goneMin        R7: minutes the agent must have been gone before a case opens (5)
///   commitFloorGb  R8: free commit below this refuses a spawn (8)
function spawnConfig(raw) {
  const c = _isObj(raw) ? raw : {};
  const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    goneMs: Math.round(num(c.goneMin, 1, 24 * 60, 5) * 60 * 1000),
    commitFloorBytes: Math.round(num(c.commitFloorGb, 0, 1024, 8) * GB),
  };
}

/// The `agentGone` field on a session row. Null unless the agent's process was SEEN under the
/// PTY and is not there now.
///   found     true: the agent's process is under the PTY now | false: it is not | null: cannot tell
///   seenAt    when this server last saw it running there (epoch ms), or null (never)
///   endedAt   the session's SessionEnd hook, standing (any later hook clears it), or null
///   endReason that hook's `reason`
/// `{seenAt, endedAt, reason}`: endedAt set means a deliberate exit, null means it died.
function agentGoneField({ found, seenAt, endedAt, endReason }) {
  if (found !== false || !Number.isFinite(seenAt)) return null;
  const deliberate = Number.isFinite(endedAt);
  return { seenAt, endedAt: deliberate ? endedAt : null, reason: deliberate ? clip(endReason, 40) || null : null };
}

/// What this server can say about a session's agent: `{state, gone}`.
///   running  its process is under the PTY in the newest snapshot
///   gone     it is not, and that snapshot is NEWER than the last sighting and the last hook
///            (an older snapshot cannot outvote a newer proof of life), the sighting is of
///            THIS shell, and the exit hook is installed (or no exit tells from a death).
///            `gone` is its agentGoneField.
///   unknown  anything else: never seen, cannot read, a stale snapshot, no exit hook. Never
///            "running" and never "gone": nothing is typed into it and nothing replaces it.
///   found   true | false | null (the snapshot could not be read)
///   snapAt  the snapshot's time; seenAt: the last sighting under this shell (null: never)
///   hookAt  the session's last hook on this server (null: none since it started)
function agentState({ found, snapAt, seenAt, hookAt, hooked, endedAt, endReason }) {
  if (found === true) return { state: 'running', gone: null };
  const unknown = { state: 'unknown', gone: null };
  if (found !== false || !Number.isFinite(snapAt) || !Number.isFinite(seenAt) || snapAt <= seenAt) return unknown;
  if (Number.isFinite(hookAt) && snapAt <= hookAt) return unknown;
  if (hooked !== true) return unknown;
  const gone = agentGoneField({ found, seenAt, endedAt, endReason });
  return gone ? { state: 'gone', gone } : unknown;
}

/// Is web-terminal's own hook (scripts/install-hooks.js isWtHook, passed as [isOurs]) installed
/// for [event] in the agent's parsed [settings]? Without it no exit can be told from a death.
function exitHookInstalled(settings, event, isOurs) {
  const groups = _isObj(settings) && _isObj(settings.hooks) ? settings.hooks[event] : null;
  return Array.isArray(groups) && groups.some((g) => _isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => Boolean(isOurs(h))));
}

/// Did [gone] die (not exit on purpose), at least goneMs ago? R7's predicate.
function diedAgo(gone, now, goneMs) {
  return Boolean(gone && !Number.isFinite(gone.endedAt) && Number.isFinite(gone.seenAt) && now - gone.seenAt >= goneMs);
}

/// R8 on the session's own server. Returns null (room) or why not:
/// 'slot-cap' | 'commit-unknown' | 'commit-floor'.
function capacityRefusal({ sessions, cap, commitAvailBytes, floorBytes }) {
  if (!Number.isFinite(sessions) || !Number.isFinite(cap) || sessions >= cap) return 'slot-cap';
  if (!Number.isFinite(commitAvailBytes)) return 'commit-unknown';
  if (Number.isFinite(floorBytes) && commitAvailBytes < floorBytes) return 'commit-floor';
  return null;
}

/// Which way session [row] is replaced, or why it is not. [agent] is its agentState.
///   { mode: 'dead' }      the agent died: the supervisor writes the brief
///   { mode: 'handoff' }   the agent is SEEN running: it writes its own (the #340 path and its
///                         gates). Only then: a wrap-up typed into a bare shell is a command.
///   { why }               refused: 'deliberate' (someone exited it), 'agent-unknown' (neither
///                         seen running nor proven dead), 'restart-hold', 'in-progress' (a
///                         hand-off runs), 'handed-off' (it already has a successor, or its last
///                         run ended kept or failed and nobody typed since), 'declined' (a
///                         person said no to a hand-off and has not typed since), 'typing',
///                         'supervisor' (the dispatcher is never replaced this way: the server
///                         restarts it)
function replaceMode({ agent, hold, handoffActive, handedOff, declined, typing, dispatcher }) {
  if (dispatcher) return { why: 'supervisor' };
  if (hold) return { why: 'restart-hold' };
  if (handoffActive) return { why: 'in-progress' };
  if (handedOff) return { why: 'handed-off' };
  if (declined) return { why: 'declined' };
  if (typing) return { why: 'typing' };
  const a = agent || {};
  if (a.state === 'gone' && a.gone && Number.isFinite(a.gone.endedAt)) return { why: 'deliberate' };
  if (a.state === 'gone' && a.gone) return { mode: 'dead' };
  if (a.state === 'running') return { mode: 'handoff' };
  return { why: 'agent-unknown' };
}

/// Validate the dispatcher's note for the brief: `{ok, note}` (null when absent) or
/// `{ok: false, error}`. Refused, never cut: a note cut short says something else.
function noteOf(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, note: null };
  if (typeof raw !== 'string') return { ok: false, error: 'note must be a string' };
  const note = raw.trim();
  if (note.length > NOTE_MAX) return { ok: false, error: `note must be at most ${NOTE_MAX} characters` };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(note)) return { ok: false, error: 'note must be one line with no control characters' };
  return { ok: true, note: note || null };
}

/// Is the transcript fit to resume? [tail] is its last bytes as text (null: no transcript).
/// Sound = its last complete line is a JSON object: a file cut mid-write (the agent died while
/// appending) would put the resumed agent on a broken conversation.
function transcriptSound(tail) {
  if (typeof tail !== 'string') return false;
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  try { return _isObj(JSON.parse(lines[lines.length - 1])); } catch { return false; }
}

/// The successor's launch command when it resumes conversation [conversationId]: the fresh
/// command (lib/handoff.js freshLaunchCommand) plus the agent's own resume flag, the first of
/// its declared `handoff.resumeFlags.withValue` (lib/agents.js: `--resume` for Claude). null
/// when the agent declares none or the id is not a conversation id.
function resumeLaunchCommand(fresh, policy, conversationId) {
  const flag = policy && policy.resumeFlags && Array.isArray(policy.resumeFlags.withValue) ? policy.resumeFlags.withValue[0] : null;
  if (typeof fresh !== 'string' || !fresh.trim() || !flag || !UUID_RE.test(String(conversationId || ''))) return null;
  return `${fresh.trim()} ${flag} ${conversationId}`;
}

/// The brief the supervisor writes for a dead agent's successor: everything this server knows
/// that the successor cannot see. Markdown, self-contained.
///   old       { id, name, cwd, conversationId }
///   reported  the last dashboard report { headline, items: [{ref, title, state, note}], wait, at }
///   touches   tracker refs the session touched since that report [{ref, kind}]
///   goal      what the session was opened for (spawn goal)
///   tail      the last turns [{role, text}] (oldest first)
///   gone      its agentGone field; note: the dispatcher's note; resumed: --resume or fresh
function briefText({ old, reported, touches, goal, tail, gone, note, resumed, now }) {
  const o = old || {};
  const r = _isObj(reported) ? reported : {};
  const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : 'unknown');
  const out = [
    `# Replacement brief: ${oneLine(o.name || o.id || 'a session', 100)}`,
    '',
    `Written by the web-terminal supervisor at ${iso(now)}. The previous session's agent stopped `
      + `(last seen running ${iso(gone && gone.seenAt)}; no exit hook, so it did not exit on purpose) `
      + 'and could not write its own brief. Everything below is what the server knew about it.',
    '',
    `- Working folder: ${oneLine(o.cwd || 'unknown', 260)}`,
    `- Previous session: ${o.id || 'unknown'}${o.conversationId ? `, conversation ${o.conversationId}` : ''}`,
    `- This session: ${resumed ? 'RESUMES that conversation, so the history above your first prompt is its own' : 'starts FRESH: the history is not here, only this brief'}`,
  ];
  if (goal) out.push(`- Opened for: ${oneLine(goal, 300)}`);
  out.push('', '## Its last report');
  if (r.headline) out.push(`Headline: ${oneLine(r.headline, 200)}`);
  const items = Array.isArray(r.items) ? r.items : [];
  if (items.length) for (const it of items.slice(0, 20)) {
    if (_isObj(it)) out.push(`- ${oneLine(it.ref, 60)} ${oneLine(it.title, 120)}: ${oneLine(it.state, 30)}${it.note ? ` (${oneLine(it.note, 160)})` : ''}`);
  } else out.push('- (no work items reported)');
  const w = _isObj(r.wait) ? r.wait : null;
  out.push(w ? `Waiting on: ${oneLine(w.on, 20)}${w.what ? ` "${oneLine(w.what, 160)}"` : ''}${w.target && w.target.kind ? ` (target ${oneLine(w.target.kind, 20)})` : ''}` : 'Waiting on: nothing reported');
  out.push(`Reported at: ${iso(r.at)}`);
  const refs = (Array.isArray(touches) ? touches : []).filter(_isObj).slice(-20);
  if (refs.length) {
    out.push('', '## Tracker items it touched since that report');
    for (const t of refs) out.push(`- ${oneLine(t.ref, 80)}${t.kind && t.kind !== 'item' ? ` (${oneLine(t.kind, 20)})` : ''}`);
  }
  if (note) out.push('', '## From the supervisor', oneLine(note, NOTE_MAX));
  const turns = (Array.isArray(tail) ? tail : []).filter((t) => _isObj(t) && typeof t.text === 'string' && t.text.trim());
  if (turns.length) {
    out.push('', '## Its last turns (oldest first)');
    for (const t of turns.slice(-8)) out.push('', `**${t.role === 'user' ? 'Prompt' : 'Agent'}:** ${clip(t.text.replace(/\s+/g, ' '), 1200)}`);
  }
  out.push('', '## First steps',
    '1. Check the real state before acting on this brief: `git status`, the branch, open PRs, the tracker items above.',
    '2. Carry on from where it stopped. Anything half-done in the working folder is the previous agent\'s.',
    '3. Report your work items to the dashboard as usual.', '');
  return out.join('\n');
}

/// The first prompt typed into a dead agent's successor, once its composer is up. Under 512
/// bytes (one line, so it is delivered as plain text + CR): [briefFile] is a server path.
function replacementPrompt({ briefFile, oldName, resumed }) {
  const n = clip(oldName || 'the previous session', 60).replace(/"/g, "'");
  const head = resumed
    ? `${TAG} The agent of the session "${n}" stopped; this session resumes the same conversation. `
    : `${TAG} You continue the work of the session "${n}", whose agent stopped. `;
  const text = `${head}The supervisor wrote a brief at ${briefFile}: read it, check the real state (git, the tracker), then carry on. Report your work items to the dashboard as usual.`;
  return Buffer.byteLength(text, 'utf8') <= PROMPT_BYTES_MAX ? text : null;
}

module.exports = {
  NOTE_MAX, PROMPT_BYTES_MAX,
  spawnConfig, agentGoneField, agentState, exitHookInstalled, diedAgo, capacityRefusal, replaceMode, noteOf, transcriptSound,
  resumeLaunchCommand, briefText, replacementPrompt,
};
