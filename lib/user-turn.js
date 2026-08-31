'use strict';
// --- What a `role:user` turn actually IS --------------------------------------
// A transcript is full of user-role turns the human never typed: another
// session's message, a task-notification, Stop-hook feedback, a post-compaction
// summary, and slash commands. Two features need to tell them apart — the recap
// ("what did I last ASK?") and the chat lens's optimistic echo ("has the prompt
// I just sent landed yet?", #149) — so the rule lives here, once.
//
// DEPENDENCY-FREE ON PURPOSE, and that is not tidiness. The rule started in
// `lib/recap.js`, which requires `./speech`, which requires `./transcript` — so
// `transcript.js` cannot require `recap.js` without a cycle, and `transcript.js`
// is exactly where the echo field has to be published. Same idiom as
// `lib/submit-frames.js` and `lib/agent-ready.js`: the pure rule in its own file,
// imported by everyone who needs it. `recap.js` re-exports its half so its
// existing importers are untouched.

/// The kinds of `role:user` turn. Only `human` is a prompt the user typed.
const USER_KINDS = Object.freeze({
  HUMAN: 'human',
  TEAMMATE: 'teammate', // another agent session messaged this one
  SYSTEM: 'system',     // harness injection: task-notification, hook, compaction,
                        // and a local command's OUTPUT (#192 — see the branch)
  COMMAND: 'command',   // a slash command the user TYPED. Not its output.
  META: 'meta',         // harness-injected with NO wrapper to sniff (#163)
});
const _KNOWN_KINDS = new Set(Object.values(USER_KINDS));

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
// SGR/CSI/OSC escapes. Command output is captured off a TERMINAL, so it arrives
// carrying rendering instructions — 47 of the 61 measured turns hold `ESC[2m`
// dim markers. They are never content, and a chat lens is not a terminal.
// Stripped ONLY where the text is known to be machine output: a human who pastes
// terminal output into a prompt typed those bytes, and editing their sentence is
// not this module's job.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

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
/// [opts.isMeta] is the transcript record's own `isMeta` flag — see the note on
/// [USER_KINDS.META] below. It is an OPTIONS BAG rather than a second positional
/// argument, and the function stays PURE (it is handed the flag, it never reads a
/// record): `classifyUserTurn(text)` is called from half a dozen places that have
/// only the text, and every one of them must keep behaving exactly as before.
///
/// This is the JS twin of `classifyUserTurn` in the companion's
/// conversation_view.dart, which does the same job for BUBBLE LABELLING. Two
/// copies of one rule is a drift risk and is tracked as such: the server copy is
/// the authority, and it recognises strictly more (slash commands,
/// system-reminders) because a recap is ruined by a false prompt in a way a
/// mislabelled bubble is not. Consolidating the Dart side onto a server-published
/// field is a separate, additive change.
function classifyUserTurn(text, opts = {}) {
  const raw = typeof text === 'string' ? text : '';
  const t = raw.trimStart();
  const isMeta = Boolean(opts && opts.isMeta);

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

  // --- #192: a command's OUTPUT, which the user did not type -----------------
  // `/compact`'s own stdout (plus, on this fleet, our hook's JSON reply) lands as
  // a `role:user` turn and read as HUMAN — so the chat lens showed it in a "You"
  // bubble and the recap reported it as the user's last prompt, in a
  // just-compacted session, which is precisely when a recap is reached for.
  //
  // Measured 2026-08-31 over 1066 transcripts / 3902 `role:user` turns: 61 turns
  // LEAD with this tag, all 61 classified human, NONE carries `isMeta` (so
  // #163's structural backstop misses it) and NONE carries a `<command-name>`
  // (so the branch below misses it too). It sits in the gap between the two.
  //
  // ANCHORED, never a substring test. Exactly one turn in that corpus contains
  // the tag without leading on it, and it is a genuine prompt — one asking how
  // this very label is decided. An `includes` would have reclassified the
  // question as its own answer. That is #138's rule (our own text is a live
  // input) showing up in the corpus rather than in theory.
  //
  // SYSTEM RATHER THAN COMMAND, forced by the consumer. `conversation_view.dart`
  // maps the wire's `command` onto `UserTurnKind.human` on purpose — a slash
  // command IS the user's own turn, and #32's collapsed chip renders on that
  // branch — so publishing `command` here would leave the reported bubble
  // untouched. A NEW kind would be worse: `userTurnKindFromWire` yields null for
  // anything it does not recognise, the client falls back to its weaker Dart
  // twin, and the turn reads as human again — shipping the bug to every client
  // not yet rebuilt. `system` is the one verdict that already renders muted and
  // left-aligned on the CURRENT companion, so this fix needs no client release.
  if (t.startsWith('<local-command-stdout')) {
    const body = t
      .replace(COMMAND_TAG_RE, ' ')
      .replace(ANSI_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { kind: USER_KINDS.SYSTEM, from: 'Command output', body };
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
  // --- #163: the injection with NOTHING to sniff -----------------------------
  // A skill is expanded into a `role:user` turn carrying the WHOLE SKILL.md and
  // no wrapper at all, so every signature above misses it and it read as a
  // prompt: the chat lens labelled 142 KB of skill instructions "You" and the
  // recap reported it as the user's last sentence. Content-signature sniffing is
  // WHY it was missed — it is the one injection with no signature — so the
  // answer has to be structural. The transcript record carries the harness's own
  // `isMeta` flag, and the caller passes it down.
  //
  // Re-measured 2026-08-26 over 803 transcripts / 3153 `role:user` turns:
  // 648 `isMeta:true` (51 bare skill bodies, 222 reminder-only, 375 other
  // injections — `[Image: …]` notes, `## Context Usage`, effort-level notes,
  // `Continue from where you left off.`) and 2505 `isMeta:false`, of which 2363
  // are genuine prompts. **Not one genuine prompt carries the flag**, and not one
  // bare skill body lacks it. Two of the skill bodies do not open with
  // `Base directory for this skill:` at all, which is the argument for the flag
  // over a fourth signature.
  //
  // DELIBERATELY LAST. A content signature that matched already NAMED its source
  // ('Hook', the teammate's id, the command) and `meta` can only say "the harness
  // put this here" — never trade a name for a shrug. It is also why the flag
  // COMPLEMENTS the command branch instead of replacing it: all 142
  // `<command-name>` trios in that corpus are `isMeta:FALSE`, contrary to what
  // #163's own text assumed.
  if (isMeta) return { kind: USER_KINDS.META, from: 'Injected', body };
  return { kind: USER_KINDS.HUMAN, from: '', body };
}

/// The kind of an already-parsed turn object, preferring the verdict the parser
/// recorded on it (`turn.userKind`, which is the only thing that has seen the
/// record's `isMeta`) and falling back to classifying its text.
///
/// The fallback is not defensive padding: only the Claude adapter reads `isMeta`,
/// so a Codex rollout turn — and any page produced before this shipped — carries
/// no field at all and must behave exactly as it did before.
function kindOfTurn(turn) {
  if (!turn) return USER_KINDS.SYSTEM;
  if (typeof turn.userKind === 'string' && _KNOWN_KINDS.has(turn.userKind)) return turn.userKind;
  return classifyUserTurn(turn.text).kind;
}

/// The text the USER actually typed to produce this `role:user` turn, or `''`
/// when they typed nothing (a teammate message, a notification, hook feedback, a
/// compaction summary, a command's local output, or a turn that was pure
/// injected context).
///
/// This is what an optimistic "Queued" echo in the chat lens compares itself
/// against (#149). The raw turn text CANNOT serve: a real prompt arrives with
/// `<system-reminder>` blocks stapled on, and a typed slash command arrives as a
/// tag trio, so equality against the raw text never fires and the badge never
/// clears.
///
/// **It is not [classifyUserTurn]'s `body` either, and that is the trap.** `body`
/// means "readable text", so for a command it folds the `<command-message>` prose
/// in alongside the name: the real turn for `/compact` reads `"/compact compact"`,
/// and with args `"/compact compact focus on the parser"` for something the user
/// typed as `/compact focus on the parser`. Comparing against `body` fails just
/// as reliably as comparing against the raw text.
///
/// **Nor is it `from` + args.** Measured across every transcript on this machine,
/// the trio arrives in EITHER order — 59 turns lead with `<command-name>` (the
/// harness-generated `/compact`, `/clear`) and 29 lead with `<command-message>`
/// (the ones a human actually typed, which is where the args live).
/// `classifyUserTurn`'s command branch is anchored on `<command-name>` alone, so
/// the message-first shape never reaches it: it classifies as `human` with the
/// raw XML as its body, and `from` is `''`. Since the message-first shape is
/// precisely the user-typed `/name <text>` that gets queued, the extraction has
/// to accept both orders.
///
/// **But it accepts them ANCHORED, and bare presence was a bug.** Testing only
/// whether the text CONTAINS a `<command-name>` reports a slash command for any
/// turn that merely QUOTES one — and the turns that quote one are exactly the
/// ones nobody typed. Of the 97 turns on this machine carrying a `<command-name>`,
/// 88 open with `<command-name>` or `<command-message>` and all 88 are genuine;
/// the other 9 are teammate messages and post-compaction summaries quoting a
/// trio, and unanchored presence reported every one of them as a typed command.
/// That both loses the real sentence and hands the echo a key that can never
/// match, which is #149 again for that class of input.
///
/// `<local-command-caveat>` is deliberately NOT part of the anchor: 62 turns open
/// with it and ZERO of them carry a trio, so admitting them would only add turns
/// that find no name and fall through anyway.
///
/// Deliberately does NOT change how a turn is CLASSIFIED. Re-anchoring the
/// command branch would flip those 29 message-first turns from `human` to
/// `command`, and they are genuine prompts — the recap would stop reporting them.
///
/// [opts] is forwarded to [classifyUserTurn] — so a turn the harness marked
/// `isMeta` yields `''` here for free (#163). The slash-command branch below runs
/// FIRST and is deliberately not gated on the flag: a command the user typed is
/// still something they typed, whatever the record says about the turn.
function typedTextOf(text, opts = {}) {
  const raw = typeof text === 'string' ? text : '';
  const t = raw.trimStart();

  // A slash command the user typed, in either tag order — but only when the trio
  // OPENS the turn. A trio anywhere else is one being quoted, not one being run.
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) {
    const name = ((COMMAND_NAME_RE.exec(t) || [])[1] || '').trim();
    if (name) {
      const slash = `/${name.replace(/^\//, '')}`;
      const args = _innerTag(t, 'command-args');
      return args ? `${slash} ${args}` : slash;
    }
  }

  // Everything else: only a genuine human turn carries typed text, and it is the
  // body with the reminder blocks already stripped.
  const { kind, body } = classifyUserTurn(raw, opts);
  return kind === USER_KINDS.HUMAN ? body : '';
}

module.exports = {
  classifyUserTurn,
  kindOfTurn,
  typedTextOf,
  USER_KINDS,
};
