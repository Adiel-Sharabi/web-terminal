// The agent's own words for the turn the person is looking at (#383): every text block
// it wrote since the person last typed something, in order. The ONE place the question
// overlay's lead-up and the questions inbox's replies are read from, so the session
// screen and the inbox can never show two different "Claude said".
//
// Why a whole turn and not one line. Claude Code writes each content block of a message
// as its own transcript line, so one reply is several `assistant` turns on the wire, with
// tool calls between them. The lead-up used to be the newest of those lines alone, read
// from a 12-turn page: measured over 122 AskUserQuestion calls in 434 local transcripts,
// 46 turns had more than one text block (so part of the turn was missing, often the list
// a final "Pick one:" pointed at), the human prompt sat more than 12 turns back for 51,
// and 63 turns had no prose at all, which made the overlay show a reply from BEFORE the
// person's last prompt as if it led up to the question.

import '../api/models.dart';
import '../widgets/conversation_view.dart' show UserTurnKind, classifyUserTurn, userTurnKindFromWire;

/// The first page read: covers the turn for most questions (the median human prompt
/// sits 8 turns back).
const int kAgentTurnFirstPage = 50;

/// Each further page: the server's own per-page maximum.
const int kAgentTurnMorePage = 200;

/// Never read more than this many turns for one lead-up. Measured over the same 122
/// questions: the human prompt sat at most 413 turns back (p95 133, p99 212), so 450
/// (one 50-turn page and two 200-turn ones) reaches every one of them, and three
/// requests is the most a single question can cost.
const int kAgentTurnMaxTurns = 450;

/// Whether [t] is a prompt the person TYPED, which is what begins a turn: the server's
/// own rule (`lib/recap.js` `isHumanPrompt`), a `role:user` turn whose verdict is
/// `human`. A turn with no verdict the client knows (an older server, a Codex rollout)
/// falls back to the local classifier, as the server's `kindOfTurn` does.
///
/// A `command` verdict is NOT a boundary. Measured over 436 local transcripts: the 87
/// name-first trios the server reads as `command` (`/cost`, `/model`, `/mcp`,
/// `/clear`, `/compact`, ...) and their `<local-command-stdout>` (read as `system`)
/// are local commands that start no agent turn, so a reply asking "Should I push
/// it?" still stands after one. A command that runs a prompt or a skill (`/issue`,
/// `/dds-recap`) is written message-first, which the server reads as `human` - all
/// 56 such turns were answered by the agent - so it IS a boundary. The chat lens
/// still renders `command` as the person's own bubble ([userTurnKindFromWire]); that
/// is a rendering choice, not where a turn begins.
bool isHumanPrompt(TranscriptTurn t) {
  if (!t.isUser) return false;
  if (userTurnKindFromWire(t.userKind) != null) return t.userKind == 'human';
  return classifyUserTurn(t.text).kind == UserTurnKind.human;
}

/// What the person typed for the human turn [t]: the server's `typedText` when it sent
/// one, else the turn's readable body.
String promptTextOf(TranscriptTurn t) {
  final typed = t.typedText?.trim() ?? '';
  return typed.isNotEmpty ? typed : classifyUserTurn(t.text).body.trim();
}

/// The agent's current turn, read from its transcript.
class AgentTurn {
  const AgentTurn({
    required this.prose,
    this.youAsked,
    this.earlier,
    this.reachedPrompt = false,
    this.capped = false,
    this.at,
    this.pendingTool,
  });

  /// Every assistant text block since the last human prompt, oldest first, joined with
  /// blank lines. Empty when the turn has no prose yet.
  final String prose;

  /// The human prompt that began the turn, when it was reached.
  final String? youAsked;

  /// Only when [prose] is empty: the previous turn's prose, so the person still sees
  /// what the agent last said, labelled as earlier.
  final String? earlier;

  /// The human prompt was found within the read cap: [prose] is the WHOLE turn.
  final bool reachedPrompt;

  /// The read stopped at [kAgentTurnMaxTurns] with older turns left unread, so [prose]
  /// may be only the newer part of the turn. [leadUp] says so.
  final bool capped;

  /// The timestamp of the turn's newest text block, or null.
  final String? at;

  /// The one tool call of the turn still without a result, when exactly one is
  /// ([pendingToolUse]): what a permission prompt may be asking to run. Show it only
  /// through [permissionToolCall].
  final ToolUse? pendingTool;

  /// The text shown above a question or a permission, as markdown: the turn's prose,
  /// or, when it has none, "You asked" and "Earlier it said", each labelled; led by a
  /// note when the read cap cut the turn ([capped]). Null when there is nothing to show.
  String? get leadUp {
    final body = prose.isNotEmpty
        ? prose
        : [
            if ((youAsked ?? '').isNotEmpty) '**You asked:**\n\n$youAsked',
            if ((earlier ?? '').isNotEmpty) '**Earlier it said:**\n\n$earlier',
          ].join('\n\n');
    final parts = [if (capped) kAgentTurnCappedNote, if (body.isNotEmpty) body];
    return parts.isEmpty ? null : parts.join('\n\n');
  }

  /// The heading [leadUp] goes under: the agent's words are "Claude said"; the
  /// fallback is the person's own prompt and an EARLIER reply, which did not lead up
  /// to the wait, so it is not.
  String get leadUpLabel => prose.isNotEmpty ? kLeadUpLabel : kLeadUpFallbackLabel;
}

/// The heading over the agent's own words for the turn.
const String kLeadUpLabel = 'Claude said';

/// The heading over the "You asked / Earlier it said" fallback.
const String kLeadUpFallbackLabel = 'Before it asked';

/// What a lead-up begins with when the read cap cut it.
const String kAgentTurnCappedNote = '_Earlier text not loaded - open the session._';

/// The current turn of [turns] (newest last): pure, so the paging in [loadAgentTurn]
/// and every rule here can be tested on a plain list.
AgentTurn agentTurnOf(List<TranscriptTurn> turns, {ToolUse? pendingTool, bool capped = false}) {
  final prose = _proseBack(turns, turns.length);
  if (prose.prompt == null) {
    return AgentTurn(prose: prose.text, at: prose.at, pendingTool: pendingTool, capped: capped);
  }
  final youAsked = promptTextOf(turns[prose.prompt!]);
  final earlier = prose.text.isEmpty ? _proseBack(turns, prose.prompt!).text : null;
  return AgentTurn(
    prose: prose.text,
    youAsked: youAsked,
    earlier: earlier == null || earlier.isEmpty ? null : earlier,
    reachedPrompt: true,
    capped: capped,
    at: prose.at,
    pendingTool: pendingTool,
  );
}

/// The assistant prose before index [end] back to the nearest human prompt: the joined
/// text, the prompt's index (null when none was reached), and the newest block's time.
({String text, int? prompt, String? at}) _proseBack(List<TranscriptTurn> turns, int end) {
  final blocks = <String>[];
  String? at;
  for (var i = end - 1; i >= 0; i--) {
    final t = turns[i];
    if (isHumanPrompt(t)) return (text: blocks.reversed.join('\n\n'), prompt: i, at: at);
    if (t.isAssistant && t.text.trim().isNotEmpty) {
      blocks.add(t.text.trim());
      at ??= t.ts;
    }
  }
  return (text: blocks.reversed.join('\n\n'), prompt: null, at: at);
}

/// Whether [turns] still lacks what [agentTurnOf] needs: the human prompt that began the
/// turn, and when the turn has no prose and [earlier] is wanted, the prompt before it.
bool _needsOlder(List<TranscriptTurn> turns, {required bool earlier}) {
  final cur = _proseBack(turns, turns.length);
  if (cur.prompt == null) return true;
  if (!earlier || cur.text.isNotEmpty) return false;
  return _proseBack(turns, cur.prompt!).prompt == null;
}

/// Tools whose open call means a SUBAGENT is at work: a permission asked while one
/// is open may be the subagent's own, which the main transcript does not hold.
const Set<String> _subagentTools = {'Agent', 'Task'};

/// The tool call a permission prompt waits on, read from the newest page [turns], or
/// null unless that is UNAMBIGUOUS: exactly one call since the person's last prompt
/// has no result, and it is not a subagent's dispatch. A wrong command on an
/// approval screen is worse than none, and each of these would show a wrong one:
///  * parallel calls (`rm -rf dist` and `git push --force`, both waiting): which of
///    them is asking is not on disk;
///  * an allow-listed call still running beside the one that asks;
///  * a subagent asking: the main transcript's open call is the `Agent`/`Task` that
///    started it, and its input is the subagent's brief.
/// Read from the newest page only: a result is attached to its call only when both
/// are on one page, and the newest page holds everything newer than any call on it.
/// Show it through [permissionToolCall], which also checks it against the server.
ToolUse? pendingToolUse(List<TranscriptTurn> turns) {
  ToolUse? open;
  for (var i = turns.length - 1; i >= 0; i--) {
    final t = turns[i];
    if (isHumanPrompt(t)) break;
    if (!t.isAssistant) continue;
    for (final u in t.toolUses) {
      if (u.result != null) continue;
      if (open != null) return null;
      open = u;
    }
  }
  return open == null || _subagentTools.contains(open.name) ? null : open;
}

/// The call a permission prompt waits on, as the approval screen may show it:
/// [pending] ([pendingToolUse]) when the server's own "now" line [now] agrees, else
/// null. [now] is `brief.now`, written from the newest PreToolUse
/// (`lib/session-brief.js` describeTool: `Bash <dot> <what>`, `Subagent: ...` for a
/// subagent's call and `Subagent <dot> ...` for a dispatch, `<server> <dot> <tool>`
/// for an MCP tool; the dot is U+00B7). A subagent's line, or one naming another
/// tool, means the open call in the transcript is not the one asking. No line (an
/// older server, no hooks) leaves [pending] as the transcript says.
ToolUse? permissionToolCall(ToolUse? pending, String? now) {
  if (pending == null) return null;
  final line = now?.trim() ?? '';
  if (line.isEmpty) return pending;
  if (line.startsWith('Subagent')) return null;
  final head = line.split(' \u00b7 ').first.trim();
  final name = pending.name;
  final want = name.startsWith('mcp__') ? name.split('__')[1] : name;
  return head == want ? pending : null;
}

/// One transcript page: older than [before] (null for the newest), at most [limit].
typedef TranscriptPageReader = Future<TranscriptPage> Function(String? before, int limit);

/// Reads the agent's current turn, paging back from the newest page with [read] until
/// the human prompt that began it is found (and, when the turn has no prose and
/// [earlier] is true, the one before that), the transcript runs out, or
/// [kAgentTurnMaxTurns] have been read. Errors propagate: a caller decides what a
/// failed read shows.
Future<AgentTurn> loadAgentTurn(TranscriptPageReader read, {bool earlier = true}) async {
  final first = await read(null, kAgentTurnFirstPage);
  var turns = first.messages;
  var cursor = first.cursor;
  while (cursor != null && turns.length < kAgentTurnMaxTurns && _needsOlder(turns, earlier: earlier)) {
    final want = (kAgentTurnMaxTurns - turns.length).clamp(1, kAgentTurnMorePage);
    final page = await read(cursor, want);
    if (page.messages.isEmpty && page.cursor == cursor) break;
    turns = [...page.messages, ...turns];
    cursor = page.cursor;
  }
  // Stopped by the cap, not by the prompt or the transcript's start.
  final capped = cursor != null && turns.length >= kAgentTurnMaxTurns && _needsOlder(turns, earlier: false);
  return agentTurnOf(turns, pendingTool: pendingToolUse(first.messages), capped: capped);
}

/// What a tool call [t] acts on, as the person approving it needs to read it: a
/// shell command, else the file, path, URL or pattern it names, else the server's
/// short preview of its input. Null when it carries none of them.
String? toolCallText(ToolUse t) {
  for (final k in const ['command', 'file_path', 'notebook_path', 'path', 'url', 'pattern', 'query']) {
    final v = t.input[k];
    if (v is String && v.trim().isNotEmpty) return v.trim();
  }
  final p = t.inputPreview.trim();
  return p.isEmpty || p == '{}' ? null : p;
}
