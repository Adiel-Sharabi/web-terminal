// The pure rules behind the questions inbox (#383): which sessions and background agents
// are waiting on the person, as what kind of item, in what order. Every judgement about a
// SESSION is the board's ([boardNeedsYou], [needKindOf]) or the server's (`reason`,
// `waitingFor`, the transcript's last turn); this only arranges them, so the inbox and
// the board can never disagree about who needs you.

import '../api/models.dart';
import 'agent_turn.dart';
import 'needs_you.dart';
import 'reply_text.dart';

export 'reply_text.dart' show askingInProse;

/// What an inbox item is waiting on, which decides its card and what can be written.
enum InboxKind {
  /// (a) Claude's AskUserQuestion prompt, answered through the question card.
  question,

  /// (b) A tool waiting for permission. Answered in the session (the keys are
  /// unmeasured), so the inbox shows what is asked and opens it.
  permission,

  /// (c) An idle agent whose last reply ends by asking something in prose.
  prose,

  /// (d) The agent reported that it waits on the person (`reason.kind == you`).
  reported,

  /// (e) A panel covers the composer (`reason.kind == menu`); a lone Esc closes it.
  menu,

  /// (f) A background agent the CLI lists as waiting. Read-only.
  background,

  /// A session the board counts as needing you that is none of the above (status
  /// `waiting` with no `waitingFor`). Kept so the inbox's blocking count is the
  /// board's Needs-you count, never fewer.
  waiting,
}

/// One thing waiting on the person.
class InboxItem {
  const InboxItem({
    required this.kind,
    required this.key,
    required this.server,
    this.session,
    this.agent,
    this.since,
    this.question,
    this.turn,
  });

  final InboxKind kind;

  /// Stable across refreshes: the session's `<baseUrl>|<id>` ([sessionKey]), or for a
  /// background agent `<baseUrl>|agent|<id or conversation>`.
  final String key;
  final ServerConfig server;

  /// The session row; for a background agent, the row whose conversation it runs, or
  /// null when no listed session runs it.
  final Session? session;
  final BackgroundAgentRow? agent;

  /// When the wait began (epoch ms), or null when nobody said.
  final int? since;

  /// (a) The live question, once it has been read.
  final PendingQuestion? question;

  /// The agent's current turn, read from its transcript: for (c) the reply that asks,
  /// for (d) what it said when it reported the wait, for (b) the lead-up and the tool
  /// call waiting for permission. Null until read.
  final AgentTurn? turn;

  /// Blocks the agent until the person acts. Prose and background agents do not.
  bool get blocking => kind != InboxKind.prose && kind != InboxKind.background;
}

/// One session, across servers: two servers can each have an `s1`.
String sessionKey(Session s) => '${s.server.baseUrl}|${s.id}';

/// The key under which a "not a question" dismissal of [s]'s reply [reply] is kept:
/// a NEW reply asks afresh.
String proseDismissKey(Session s, AgentTurn reply) => '${sessionKey(s)}|${reply.at ?? reply.prose.hashCode}';

/// Whether [s] could be asking in prose (c), before its reply has been read: an idle
/// agent that owes nothing the board knows of, did not report a wait of its own
/// (`self`, `done`, `you` are its own words about its state), and is not hidden. Only
/// these sessions' last replies are read for (c).
bool proseCandidate(Session s) =>
    s.agent != null &&
    s.status == 'idle' &&
    !boardNeedsYou(s) &&
    !boardIsHidden(s) &&
    s.reason?.source != 'reported' &&
    s.reason?.kind != 'working';

InboxKind _kindOfNeed(NeedKind k) => switch (k) {
      NeedKind.question => InboxKind.question,
      NeedKind.permission => InboxKind.permission,
      NeedKind.menu => InboxKind.menu,
      NeedKind.reported => InboxKind.reported,
      NeedKind.other => InboxKind.waiting,
    };

/// Every item waiting on the person, blocking ones first, each section oldest wait
/// first (an unknown start sorts last), so the longest-blocked session is the first
/// one met.
///
/// [rows] are the session rows on every server. [questions], [turns] are keyed by
/// [sessionKey]: the live question of a question row, the agent's current turn (read
/// for a [proseCandidate], a reported wait and a permission). [agents] are each server's background agents, by base URL.
/// [dismissed] holds the [proseDismissKey]s the person marked "not a question".
List<InboxItem> inboxItemsOf(
  List<Session> rows, {
  Map<String, PendingQuestion?> questions = const {},
  Map<String, AgentTurn?> turns = const {},
  Map<String, List<BackgroundAgentRow>> agents = const {},
  Set<String> dismissed = const {},
}) {
  final blocking = <InboxItem>[];
  final background = <InboxItem>[];
  for (final s in rows) {
    final k = sessionKey(s);
    if (boardNeedsYou(s)) {
      final kind = _kindOfNeed(needKindOf(s));
      blocking.add(InboxItem(
        kind: kind,
        key: k,
        server: s.server,
        session: s,
        since: s.reason?.since ?? s.lastActivity,
        question: kind == InboxKind.question ? questions[k] : null,
        turn: kind == InboxKind.reported || kind == InboxKind.permission ? turns[k] : null,
      ));
      continue;
    }
    if (!proseCandidate(s)) continue;
    final reply = turns[k];
    if (reply == null || reply.prose.isEmpty || !askingInProse(reply.prose)) continue;
    if (dismissed.contains(proseDismissKey(s, reply))) continue;
    background.add(InboxItem(
      kind: InboxKind.prose,
      key: k,
      server: s.server,
      session: s,
      since: s.lastActivity,
      turn: reply,
    ));
  }
  final blockingKeys = {for (final it in blocking) it.key};
  final agentKeys = <String>{};
  for (final e in agents.entries) {
    for (final a in e.value) {
      if ((a.waitingFor ?? '').isEmpty) continue;
      Session? runs;
      for (final s in rows) {
        if (a.sessionId != null && s.server.baseUrl == a.server.baseUrl && s.claudeSessionId == a.sessionId) {
          runs = s;
          break;
        }
      }
      // Its session already blocks on the person: that item is the one to answer, and
      // a second card for the same wait would only say it twice.
      if (runs != null && blockingKeys.contains(sessionKey(runs))) continue;
      // Unique even for rows the CLI gives no id: two cards may never share a key.
      final base = '${a.server.baseUrl}|agent|${a.id ?? a.sessionId}';
      var key = base;
      for (var n = 2; !agentKeys.add(key); n++) {
        key = '$base#$n';
      }
      background.add(InboxItem(
        kind: InboxKind.background,
        key: key,
        server: a.server,
        session: runs,
        agent: a,
        since: a.startedAt,
      ));
    }
  }
  return [..._oldestFirst(blocking), ..._oldestFirst(background)];
}

List<InboxItem> _oldestFirst(List<InboxItem> list) {
  // A stable sort: equal (or unknown) starts keep the server's own order.
  final indexed = list.indexed.toList();
  indexed.sort((a, b) {
    final x = a.$2.since;
    final y = b.$2.since;
    if (x == null && y == null) return a.$1.compareTo(b.$1);
    if (x == null) return 1;
    if (y == null) return -1;
    final c = x.compareTo(y);
    return c != 0 ? c : a.$1.compareTo(b.$1);
  });
  return [for (final e in indexed) e.$2];
}

/// The dashboard's inbox badge: the blocking items only, from the session rows alone
/// (no request). The same rows give the board's Needs-you count.
int inboxBadgeCount(List<Session> rows) => inboxItemsOf(rows).where((i) => i.blocking).length;
