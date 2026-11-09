// The pure rules behind the questions inbox (#383): which sessions and background agents
// are waiting on the person, as what kind of item, in what order. Every judgement about a
// SESSION is the board's ([boardNeedsYou], [needKindOf]) or the server's (`reason`,
// `waitingFor`, the transcript's last turn); this only arranges them, so the inbox and
// the board can never disagree about who needs you.

import 'dart:convert';

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
    this.dismissed = false,
  });

  final InboxKind kind;

  /// The person dismissed this ask (#445): it is listed under "Dismissed", not with the
  /// others. Only an item with an [inboxDismissSig] can be; a blocker never is.
  final bool dismissed;

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

/// What a dismissal of [it] is kept under (#445), or null when it cannot be dismissed.
///
/// Only a prose ask ("Not a question"): it never blocks the agent, and it belongs to a
/// session whose server can keep the dismissal. A question, a permission, a menu or a
/// bare wait blocks the agent; a reported wait leaves only through the server's own
/// clear (`Not waiting`), so the inbox's blocking count stays the board's Needs-you
/// count. A background agent may be waiting on a permission, often runs in no listed
/// session (nowhere to keep a dismissal for other devices), and leaves by itself once
/// it stops waiting.
///
/// It names WHAT was asked, from server data alone (never the device's base URL), so
/// every device computes the same signature and the session's server can keep it for
/// all of them (`brief.inboxDismissed`, `lib/session-brief.js` applyInboxDismiss: 1-200
/// printable ASCII). A new reply is a new signature: that is what brings a dismissed
/// item back, and nothing else does.
String? inboxDismissSig(InboxItem it) {
  if (it.kind != InboxKind.prose || it.session == null) return null;
  final r = it.turn;
  return r == null ? null : 'a|${_fnv1a(r.at ?? r.prose)}';
}

/// 32-bit FNV-1a over [s]'s UTF-8 bytes, as 8 hex digits: stable across runs and
/// platforms, unlike [String.hashCode].
String _fnv1a(String s) {
  var h = 0x811c9dc5;
  for (final b in utf8.encode(s)) {
    h = ((h ^ b) * 0x01000193) & 0xffffffff;
  }
  return h.toRadixString(16).padLeft(8, '0');
}

/// Whether the person dismissed [item], whose [inboxDismissSig] is [sig].
typedef InboxDismissed = bool Function(InboxItem item, String sig);

/// What a card's right-click / long-press menu offers (#445). None answers, rejects or
/// types anything into the session.
enum InboxCardAction {
  /// A prose ask: the focused view's own "Not a question".
  notAQuestion,

  /// A reported wait, where the server can clear it (#320): the focused view's own
  /// "Not waiting".
  notWaiting,

  /// Open the session.
  open,

  /// Copy the card's ask.
  copy,
}

/// The menu for [it], in order: its own way out first, then Open, then Copy. A blocker
/// gets no dismissal at all ([inboxDismissSig]); a reported wait only the server's clear.
List<InboxCardAction> inboxCardMenuActions(InboxItem it, {required bool canClearWait, required bool hasCopyText}) => [
      if (it.kind == InboxKind.prose && inboxDismissSig(it) != null) InboxCardAction.notAQuestion,
      if (it.kind == InboxKind.reported && canClearWait) InboxCardAction.notWaiting,
      if (it.session != null) InboxCardAction.open,
      if (hasCopyText) InboxCardAction.copy,
    ];

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
/// [isDismissed] says which asks the person dismissed (#445): those items come back
/// with [InboxItem.dismissed] set, in their place, for the caller to list apart. Only
/// an item with an [inboxDismissSig] is asked about, so a blocker never is.
List<InboxItem> inboxItemsOf(
  List<Session> rows, {
  Map<String, PendingQuestion?> questions = const {},
  Map<String, AgentTurn?> turns = const {},
  Map<String, List<BackgroundAgentRow>> agents = const {},
  InboxDismissed? isDismissed,
}) {
  InboxItem flag(InboxItem it) {
    final sig = isDismissed == null ? null : inboxDismissSig(it);
    if (sig == null || !isDismissed!(it, sig)) return it;
    return InboxItem(
      kind: it.kind,
      key: it.key,
      server: it.server,
      session: it.session,
      agent: it.agent,
      since: it.since,
      question: it.question,
      turn: it.turn,
      dismissed: true,
    );
  }

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
    background.add(flag(InboxItem(
      kind: InboxKind.prose,
      key: k,
      server: s.server,
      session: s,
      since: s.lastActivity,
      turn: reply,
    )));
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
      background.add(flag(InboxItem(
        kind: InboxKind.background,
        key: key,
        server: a.server,
        session: runs,
        agent: a,
        since: a.startedAt,
      )));
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
