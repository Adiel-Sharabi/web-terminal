// #492 - the ONE "Needs you" queue, arranged for a glance: what the inbox groups by, what
// its header counts, which option Claude recommends, the supervisor's cards and
// escalations, the work items waiting on the owner, and what changed since the person
// last looked. Pure. Every judgement about a SESSION stays the board's (`needs_you.dart`)
// or the server's; this file only arranges what they said.

import '../api/models.dart';
import '../api/supervisor_models.dart';
import 'inbox_items.dart';
import 'needs_you.dart';

// ---- the recommended option ---------------------------------------------------------

/// Claude's own mark for the option it recommends: the label ENDS with "(Recommended)"
/// (its AskUserQuestion instructions put it there). Nothing else counts: the app never
/// guesses a recommendation.
final RegExp _recommendedMark = RegExp(r'\s*\(\s*recommended\s*\)\s*$', caseSensitive: false);

/// Whether [label] carries Claude's "(Recommended)" mark.
bool isRecommendedLabel(String label) => _recommendedMark.hasMatch(label);

/// [label] without the mark, for a button that says it another way.
String withoutRecommendedMark(String label) => label.replaceFirst(_recommendedMark, '').trim();

/// The option of [q] Claude recommends, or null: none is marked, more than one is
/// (which one would be a guess), or [q] is multi-select (one mark is not the whole
/// answer of a question that takes several).
int? recommendedOption(PendingQuestionItem q) {
  if (q.multiSelect) return null;
  int? found;
  for (final (i, o) in q.options.indexed) {
    if (!isRecommendedLabel(o.label)) continue;
    if (found != null) return null;
    found = i;
  }
  return found;
}

/// The whole answer "take every recommendation" gives [q], one selection per question
/// in [buildAnswerFrames]'s shape, or null unless EVERY question has a recommended
/// option. Null for an empty ask.
List<Set<int>>? recommendedSelections(PendingQuestion q) {
  if (q.questions.isEmpty) return null;
  final out = <Set<int>>[];
  for (final item in q.questions) {
    final i = recommendedOption(item);
    if (i == null) return null;
    out.add({i});
  }
  return out;
}

// ---- the supervisor's cards and escalations -----------------------------------------

/// The listed session [server] (a server NAME, as the authority says it) runs as [id].
Session? _rowOf(List<Session> rows, String? server, String? id) {
  if (id == null) return null;
  final want = server?.toLowerCase();
  for (final s in rows) {
    if (s.id == id && (want == null || s.server.name.toLowerCase() == want)) return s;
  }
  return null;
}

/// The supervisor's items for the owner (#492): each pending recommendation card, and
/// each escalated case still open, oldest first. [authority] is the server that served
/// [state] (and the only one that takes a decision); [rows] are every server's session
/// rows, so a card can open its session. A case the RULES escalated (`auto`) about a
/// session already blocking here ([blockingKeys], by [sessionKey]) is that session's own
/// wait: its card is already in the queue, and a second one would say it twice.
List<InboxItem> supervisorItemsOf(
  SupervisorState? state,
  ServerConfig? authority,
  List<Session> rows, {
  Set<String> blockingKeys = const {},
}) {
  if (state == null || authority == null || !state.isAuthority || !state.enabled) return const [];
  final out = <InboxItem>[];
  for (final c in state.cards) {
    if (!c.pending) continue;
    final s = _rowOf(rows, c.server, c.sessionId);
    out.add(InboxItem(
      kind: InboxKind.card,
      key: '${authority.baseUrl}|card|${c.id}',
      server: s?.server ?? authority,
      session: s,
      since: state.local(c.at),
      card: c,
      authority: authority,
    ));
  }
  for (final c in state.cases) {
    if (!c.waitsOnOwner) continue;
    final s = _rowOf(rows, c.server, c.sessionId);
    if (c.escalatedAuto && s != null && blockingKeys.contains(sessionKey(s))) continue;
    out.add(InboxItem(
      kind: InboxKind.escalation,
      key: '${authority.baseUrl}|case|${c.id}',
      server: s?.server ?? authority,
      session: s,
      since: state.local(c.escalatedAt ?? c.openedAt),
      supCase: c,
      authority: authority,
    ));
  }
  out.sort((a, b) => (a.since ?? 0).compareTo(b.since ?? 0));
  return out;
}

// ---- work items that wait on the owner ----------------------------------------------

/// The work-item states the inbox lists as its third, non-blocking group (#492).
const String kItemBlocked = 'blocked';
const String kItemToTest = 'ready-for-test';

/// One work item a session reported in [state], with the session reporting it.
class WorkItemEntry {
  const WorkItemEntry(this.item, this.session);
  final BriefItem item;
  final Session session;

  /// Stable across refreshes and servers: the item's cross-session identity.
  String get key => 'item|${item.key.isEmpty ? item.ref : item.key}';
}

/// Every work item a visible session reports as [state], once per item (two sessions
/// on one item are one entry: the one active last reports it), most recently active
/// first.
List<WorkItemEntry> workItemsOf(List<Session> rows, String state) {
  final byKey = <String, WorkItemEntry>{};
  for (final s in rows) {
    if (boardIsHidden(s)) continue;
    for (final it in s.brief?.items ?? const <BriefItem>[]) {
      if (it.state != state) continue;
      final e = WorkItemEntry(it, s);
      final had = byKey[e.key];
      if (had == null || (s.lastActivity ?? 0) > (had.session.lastActivity ?? 0)) byKey[e.key] = e;
    }
  }
  final out = byKey.values.toList()
    ..sort((a, b) => (b.session.lastActivity ?? 0).compareTo(a.session.lastActivity ?? 0));
  return out;
}

/// The visible sessions whose agent is working now.
List<Session> runningOf(List<Session> rows) =>
    [for (final s in rows) if (s.status == 'working' && !boardIsHidden(s)) s];

// ---- the glance header --------------------------------------------------------------

/// What the inbox's header line counts. Each count is also a filter ([InboxFilter]).
class InboxGlance {
  const InboxGlance({this.needYou = 0, this.running = 0, this.blocked = 0, this.toTest = 0});
  final int needYou;
  final int running;
  final int blocked;
  final int toTest;

  int of(InboxFilter f) => switch (f) {
        InboxFilter.all => needYou + running + blocked + toTest,
        InboxFilter.needsYou => needYou,
        InboxFilter.running => running,
        InboxFilter.blocked => blocked,
        InboxFilter.toTest => toTest,
      };
}

/// The inbox's filters: everything, or only what one header count counts.
enum InboxFilter { all, needsYou, running, blocked, toTest }

/// The header's counts: [needYou] is the blocking items (questions, waits, cards,
/// escalations) the inbox lists; the rest are read off [rows].
InboxGlance glanceOf({required int needYou, required List<Session> rows}) => InboxGlance(
      needYou: needYou,
      running: runningOf(rows).length,
      blocked: workItemsOf(rows, kItemBlocked).length,
      toTest: workItemsOf(rows, kItemToTest).length,
    );

// ---- grouping by work item and project ----------------------------------------------

/// The item [s] is on: the first reported item that is not done, else the first one.
BriefItem? currentItemOf(Session? s) {
  final items = s?.brief?.items ?? const <BriefItem>[];
  for (final it in items) {
    if (it.state != 'done') return it;
  }
  return items.isEmpty ? null : items.first;
}

/// The last segment of a path, either separator.
String pathTail(String path) {
  final parts = path.split(RegExp(r'[\\/]+')).where((p) => p.isNotEmpty).toList();
  return parts.isEmpty ? '' : parts.last;
}

final RegExp _githubKey = RegExp(r'^[\w.-]+/([\w.-]+)#\d+$');
final RegExp _adoProject = RegExp(r'dev\.azure\.com/[^/]+/([^/]+)/_workitems', caseSensitive: false);

/// The project [item] belongs to, from its own identity: a GitHub item's repo, an
/// Azure DevOps item's project (from its link), else null.
String? projectOfItem(BriefItem item) {
  final g = _githubKey.firstMatch(item.key);
  if (g != null) return g.group(1);
  final url = item.url;
  if (url != null) {
    final a = _adoProject.firstMatch(url);
    if (a != null) return Uri.decodeComponent(a.group(1)!);
  }
  if (item.key.startsWith('ado:') || item.ref.startsWith('ado:')) return 'Azure DevOps';
  return null;
}

/// The project an inbox item is grouped under: its work item's project, else the
/// folder its session (or background agent) runs in, else its server's name.
String projectOf(InboxItem it) {
  final item = currentItemOf(it.session);
  final fromItem = item == null ? null : projectOfItem(item);
  if (fromItem != null) return fromItem;
  final cwd = it.session?.cwd ?? '';
  final tail = cwd.isEmpty ? (it.agent?.cwdTail ?? '') : pathTail(cwd);
  return tail.isEmpty ? it.server.name : tail;
}

/// One group of the inbox: a project, with its items.
class InboxGroup {
  const InboxGroup(this.label, this.items);
  final String label;
  final List<InboxItem> items;
}

/// [items] grouped by project ([projectOf], case-insensitive), groups in the order
/// their first item comes (the caller's order: the longest wait first), and inside a
/// group the items of one work item side by side, in the order each item first comes.
List<InboxGroup> groupInbox(List<InboxItem> items) {
  final order = <String>[];
  final labels = <String, String>{};
  final members = <String, List<InboxItem>>{};
  for (final it in items) {
    final label = projectOf(it);
    final k = label.toLowerCase();
    if (!members.containsKey(k)) {
      order.add(k);
      labels[k] = label;
      members[k] = [];
    }
    members[k]!.add(it);
  }
  return [
    for (final k in order) InboxGroup(labels[k]!, _byWorkItem(members[k]!)),
  ];
}

List<InboxItem> _byWorkItem(List<InboxItem> list) {
  final order = <String>[];
  final by = <String, List<InboxItem>>{};
  for (final (i, it) in list.indexed) {
    final item = currentItemOf(it.session);
    // An item with no work item stands alone, in its own place.
    final k = item == null ? '\u0000$i' : (item.key.isEmpty ? item.ref : item.key);
    (by[k] ??= (() {
      order.add(k);
      return <InboxItem>[];
    })())
        .add(it);
  }
  return [for (final k in order) ...by[k]!];
}

// ---- what changed since the person last looked --------------------------------------

/// What an inbox entry IS, for "new since you last looked": the same key with a
/// different signature is a new ask (a new wait, a new reply, a new question). Built
/// from server data only, so loading a question's details never makes it "new" again.
String inboxSeenSig(InboxItem it) {
  final at = it.kind == InboxKind.prose ? '|${it.turn?.at ?? ''}' : '';
  return '${it.kind.name}|${it.since ?? ''}$at';
}

/// The signature of a work-item entry: its state and the session reporting it.
String workItemSeenSig(WorkItemEntry e) => '${e.item.state}|${e.session.id}';

/// The keys of [current] (key -> signature) that are new or changed against [seen],
/// the signatures as they were when the person last looked. Null [seen] (this device
/// never looked) marks nothing: the first look is the baseline, not a wall of "new".
Set<String> changedSince(Map<String, String>? seen, Map<String, String> current) {
  if (seen == null) return const {};
  return {
    for (final e in current.entries)
      if (seen[e.key] != e.value) e.key,
  };
}
