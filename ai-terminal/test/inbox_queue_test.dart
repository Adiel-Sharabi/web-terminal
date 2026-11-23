// #492 - the ONE "Needs you" queue's pure rules: the recommended option (Claude's own
// mark, never a guess), the supervisor's cards and escalations, the work items waiting
// on the owner, the glance counts, grouping by project and work item, and "new since
// you last looked".
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/api/supervisor_models.dart';
import 'package:ai_terminal/util/agent_turn.dart';
import 'package:ai_terminal/util/inbox_items.dart';
import 'package:ai_terminal/util/inbox_queue.dart';
import 'package:flutter_test/flutter_test.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 't');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 't');

Session _s(
  String id, {
  String status = 'idle',
  String? waitingFor,
  Map<String, dynamic>? reason,
  int? lastActivity,
  ServerConfig server = _home,
  String cwd = '/w',
  List<Map<String, dynamic>> items = const [],
  bool hidden = false,
  Map<String, dynamic>? now,
}) =>
    Session.fromJson(server, {
      'id': id,
      'name': id,
      'cwd': cwd,
      'status': status,
      'notifyLevel': 'important',
      'agent': 'claude',
      'waitingFor': waitingFor,
      'reason': reason,
      'lastActivity': lastActivity,
      'brief': {'v': 1, 'reporting': 'on', 'items': items, if (hidden) 'hidden': true, 'now': ?now},
    });

PendingQuestionItem _q(List<String> labels, {bool multi = false}) => PendingQuestionItem(
      header: 'h',
      question: 'q?',
      multiSelect: multi,
      options: [for (final l in labels) QuestionOption(label: l, description: '')],
    );

PendingQuestion _ask(List<PendingQuestionItem> qs) => PendingQuestion(toolUseId: 't1', questions: qs);

InboxItem _wait(Session s, {InboxKind kind = InboxKind.reported, int? since}) =>
    InboxItem(kind: kind, key: sessionKey(s), server: s.server, session: s, since: since);

SupervisorState _state(Map<String, dynamic> extra) =>
    SupervisorState.fromJson({'role': 'authority', 'enabled': true, ...extra}, receivedAt: DateTime.fromMillisecondsSinceEpoch(0))!;

void main() {
  group('recommendedOption', () {
    test('is the one option whose label ends with Claude\'s "(Recommended)" mark', () {
      expect(recommendedOption(_q(['Ship it (Recommended)', 'Wait'])), 0);
      expect(recommendedOption(_q(['Wait', 'Ship it (recommended) '])), 1);
    });

    test('is null with no mark: the app never guesses one', () {
      expect(recommendedOption(_q(['Ship it', 'Wait'])), isNull);
      // A label that merely MENTIONS the word is not the mark.
      expect(recommendedOption(_q(['Recommended path', 'Wait (Recommended later)'])), isNull);
    });

    test('is null when two options carry the mark, or the question is multi-select', () {
      expect(recommendedOption(_q(['A (Recommended)', 'B (Recommended)'])), isNull);
      expect(recommendedOption(_q(['A (Recommended)', 'B'], multi: true)), isNull);
    });

    test('withoutRecommendedMark strips only the mark', () {
      expect(withoutRecommendedMark('Ship it (Recommended)'), 'Ship it');
      expect(withoutRecommendedMark('Ship it'), 'Ship it');
    });
  });

  group('recommendedSelections', () {
    test('takes every question\'s recommendation, in buildAnswerFrames\' shape', () {
      final q = _ask([_q(['A', 'B (Recommended)']), _q(['C (Recommended)', 'D'])]);
      expect(recommendedSelections(q), [
        {1},
        {0},
      ]);
    });

    test('is null when any one question has none', () {
      expect(recommendedSelections(_ask([_q(['A (Recommended)']), _q(['C', 'D'])])), isNull);
      expect(recommendedSelections(_ask([])), isNull);
    });
  });

  group('supervisorItemsOf', () {
    final rows = [_s('s1', server: _office), _s('s2')];
    test('a pending card and an escalated open case are owner items, oldest first', () {
      final st = _state({
        'cards': [
          {'id': 'k1', 'cls': 'wake', 'sessionId': 's1', 'server': 'office', 'text': 'Wake: CI green', 'at': 20},
          {'id': 'k2', 'cls': 'wake', 'sessionId': 's1', 'server': 'Office', 'text': 'old', 'at': 5, 'decision': 'approve'},
        ],
        'cases': [
          {'id': 'c1', 'rule': 'R2', 'sessionId': 's2', 'server': 'Home', 'line': 'stuck', 'openedAt': 1,
            'escalated': {'question': 'Restart it?', 'at': 10}},
          {'id': 'c2', 'rule': 'R2', 'sessionId': 's2', 'server': 'Home', 'line': 'quiet', 'openedAt': 2},
          {'id': 'c3', 'rule': 'R2', 'sessionId': 's2', 'server': 'Home', 'line': 'done', 'openedAt': 3,
            'escalated': {'question': 'Close?', 'at': 4}, 'resolvedAt': 9},
        ],
      });
      final items = supervisorItemsOf(st, _office, rows);
      expect([for (final i in items) i.kind], [InboxKind.escalation, InboxKind.card]);
      expect(items.first.supCase!.question, 'Restart it?');
      expect(items.first.session!.id, 's2');
      expect(items.last.card!.id, 'k1');
      // The card's session, matched by server NAME case-insensitively, is the Office row.
      expect(items.last.session!.server.baseUrl, _office.baseUrl);
      expect(items.last.authority, _office);
      expect(items.every((i) => i.blocking), isTrue);
    });

    test('a rules-escalated case about a session already blocking here is not said twice', () {
      final st = _state({
        'cases': [
          {'id': 'c1', 'rule': 'R4', 'sessionId': 's2', 'server': 'Home', 'line': 'waits on you', 'openedAt': 1,
            'escalated': {'question': 'waits on you', 'at': 1, 'auto': true}},
        ],
      });
      expect(supervisorItemsOf(st, _office, rows, blockingKeys: {sessionKey(rows[1])}), isEmpty);
      // Not blocking here (say its server is down): it is the only trace, so it shows.
      expect(supervisorItemsOf(st, _office, rows), hasLength(1));
    });

    test("only the rules' own R4 escalation is folded into the session's wait, not any auto one", () {
      final st = _state({
        'cases': [
          {'id': 'c1', 'rule': 'R2', 'sessionId': 's2', 'server': 'Home', 'line': 'stuck', 'openedAt': 1,
            'escalated': {'question': 'stuck', 'at': 1, 'auto': true}},
        ],
      });
      expect(supervisorItemsOf(st, _office, rows, blockingKeys: {sessionKey(rows[1])}), hasLength(1));
    });

    group("the server's needsYou (supervisorNeed)", () {
      final st = _state({
        'needsYou': ['s2', 's2', 'gone', 'x9'],
        'sessions': [
          {'id': 's2', 'server': 'Home', 'name': 'Closer', 'headline': 'wrapping up',
            'wait': {'on': 'you', 'what': 'close it out?', 'at': 7}},
          {'id': 'x9', 'server': 'Elsewhere', 'name': 'Far'},
        ],
      });

      test('a session the server says needs you, that is not blocking here, is listed once', () {
        final items = supervisorItemsOf(st, _office, rows);
        expect([for (final i in items) i.kind], [InboxKind.supervisorNeed, InboxKind.supervisorNeed]);
        final close = items.firstWhere((i) => i.need!.id == 's2');
        expect(close.blocking, isTrue);
        expect(close.session!.id, 's2');
        expect(close.key, '${sessionKey(rows[1])}|need', reason: "never the bare session key: that is the session's own item");
        expect(supervisorNeedText(close.need!), 'close it out?');
        // A node with no listed row still shows (the push said it needs you); no key clash.
        final far = items.firstWhere((i) => i.need!.id == 'x9');
        expect(far.session, isNull);
        expect(far.key, '${_office.baseUrl}|need|x9');
        expect(supervisorNeedText(far.need!), 'It needs you');
      });

      test('not duplicated when the session already blocks here', () {
        final items = supervisorItemsOf(st, _office, rows, blockingKeys: {sessionKey(rows[1])});
        expect([for (final i in items) i.need!.id], ['x9']);
      });
    });

    test('nothing from a peer, a switched-off supervisor or no state', () {
      final card = {
        'cards': [
          {'id': 'k1', 'sessionId': 's1', 'server': 'Office', 'text': 't', 'at': 1},
        ],
      };
      expect(supervisorItemsOf(null, _office, rows), isEmpty);
      expect(supervisorItemsOf(_state({...card, 'enabled': false}), _office, rows), isEmpty);
      expect(
          supervisorItemsOf(
              SupervisorState.fromJson({'role': 'peer', ...card}, receivedAt: DateTime.fromMillisecondsSinceEpoch(0)),
              _office,
              rows),
          isEmpty);
    });
  });

  group('workItemsOf and the glance', () {
    test('blocked and ready-for-test items, once per item, hidden sessions left out', () {
      final rows = [
        _s('a', lastActivity: 1, items: [
          {'ref': '#1', 'key': 'o/r#1', 'state': 'blocked'},
          {'ref': '#2', 'key': 'o/r#2', 'state': 'ready-for-test'},
        ]),
        _s('b', lastActivity: 5, items: [
          {'ref': '#1', 'key': 'o/r#1', 'state': 'blocked'},
        ]),
        _s('h', hidden: true, items: [
          {'ref': '#3', 'key': 'o/r#3', 'state': 'blocked'},
        ]),
        _s('w', status: 'working'),
      ];
      final blocked = workItemsOf(rows, kItemBlocked);
      expect(blocked, hasLength(1));
      // Two sessions on one item: the one active last reports it.
      expect(blocked.single.session.id, 'b');
      expect(workItemsOf(rows, kItemToTest).single.item.ref, '#2');
      final g = glanceOf(needYou: 3, rows: rows);
      expect([g.needYou, g.running, g.blocked, g.toTest], [3, 1, 1, 1]);
      expect(g.of(InboxFilter.blocked), 1);
    });
  });

  group('groupInbox', () {
    test('groups by the work item\'s project, else the folder, longest wait first', () {
      final wt = _s('wt', cwd: r'C:\dev\web-terminal', items: [
        {'ref': '#5', 'key': 'adiel/web-terminal#5', 'state': 'in-progress'},
      ]);
      final am = _s('am', cwd: 'C:/dev/wt_25651', items: [
        {'ref': 'ado:25651', 'key': 'ado:25651', 'state': 'in-progress',
          'url': 'https://dev.azure.com/org/Amadeus8Core/_workitems/edit/25651'},
      ]);
      final wt2 = _s('wt2', cwd: 'C:/dev/web-terminal-wt/x', items: [
        {'ref': '#7', 'key': 'adiel/web-terminal#7', 'state': 'planning'},
      ]);
      final loose = _s('loose', cwd: 'C:/dev/offline_map');
      final groups = groupInbox([_wait(wt), _wait(am), _wait(loose), _wait(wt2)]);
      expect([for (final g in groups) g.label], ['web-terminal', 'Amadeus8Core', 'offline_map']);
      expect([for (final i in groups.first.items) i.session!.id], ['wt', 'wt2']);
    });

    test('inside a group, one work item\'s waits sit together', () {
      Session on(String id, String key) => _s(id, items: [
            {'ref': key, 'key': 'o/r$key', 'state': 'in-progress'},
          ]);
      final groups = groupInbox([_wait(on('a', '#1')), _wait(on('b', '#2')), _wait(on('c', '#1'))]);
      expect(groups, hasLength(1));
      expect([for (final i in groups.single.items) i.session!.id], ['a', 'c', 'b']);
    });

    test('a done item is not the one a session is on', () {
      final s = _s('x', items: [
        {'ref': '#1', 'key': 'o/old#1', 'state': 'done'},
        {'ref': '#2', 'key': 'o/new#2', 'state': 'in-progress'},
      ]);
      expect(projectOf(_wait(s)), 'new');
    });
  });

  group('changedSince and the seen signature', () {
    InboxItem waiting(Session s) => InboxItem(kind: InboxKind.reported, key: sessionKey(s), server: _home, session: s);
    Session reportedAt(int since, {int? lastActivity}) => _s('a',
        status: 'waiting',
        waitingFor: 'you',
        reason: {'kind': 'you', 'text': 'x', 'source': 'reported', 'since': since},
        lastActivity: lastActivity);

    test('marks a new key and a changed signature, not an unchanged one', () {
      final it = waiting(reportedAt(1));
      final cur = {it.key: inboxSeenSig(it)!, 'new': 'x'};
      final seen = {it.key: inboxSeenSig(it)!};
      expect(changedSince(seen, cur), {'new'});
      final again = waiting(reportedAt(2));
      expect(changedSince(seen, {again.key: inboxSeenSig(again)!}), {again.key});
    });

    test('a device that never looked marks nothing: the first look is the baseline', () {
      expect(changedSince(null, {'a': '1'}), isEmpty);
    });

    test('a waiting row whose lastActivity moves (every output chunk) keeps its signature', () {
      final a = waiting(reportedAt(5, lastActivity: 100));
      final b = waiting(reportedAt(5, lastActivity: 999));
      expect(inboxSeenSig(a), isNotNull);
      expect(inboxSeenSig(a), inboxSeenSig(b));
      final undated = InboxItem(
          kind: InboxKind.waiting, key: 'k', server: _home, session: _s('w', status: 'waiting', lastActivity: 1), since: 1);
      final moved = InboxItem(
          kind: InboxKind.waiting, key: 'k', server: _home, session: _s('w', status: 'waiting', lastActivity: 2), since: 2);
      expect(inboxSeenSig(undated), isNull, reason: 'an undated wait is unknown, never "new again"');
      expect(inboxSeenSig(moved), isNull);
    });

    test("a permission's signature is the tool call it waits on, not the agent's report time", () {
      Session at(int t) => _s('p', status: 'waiting', waitingFor: 'permission', now: {'text': 'x', 'at': t});
      InboxItem perm(Session s, String id) => InboxItem(
          kind: InboxKind.permission,
          key: 'k',
          server: _home,
          session: s,
          turn: AgentTurn(prose: '', pendingTool: ToolUse(name: 'Bash', inputPreview: '', id: id)));
      expect(inboxSeenSig(perm(at(1), 'u1')), 'permission|u1');
      expect(inboxSeenSig(perm(at(2), 'u1')), inboxSeenSig(perm(at(1), 'u1')), reason: 'a later report, the same ask');
      expect(inboxSeenSig(perm(at(1), 'u2')), isNot(inboxSeenSig(perm(at(1), 'u1'))), reason: 'another call is new');
      expect(inboxSeenSig(perm(at(1), '')), isNull, reason: 'unknown until the call is read');
    });

    test("a question's signature is unknown until it is read, then its tool call; another question is a new ask", () {
      final s = _s('q', status: 'waiting', waitingFor: 'question');
      final bare = InboxItem(kind: InboxKind.question, key: 'k', server: _home, session: s, since: 3);
      final read = InboxItem(
          kind: InboxKind.question, key: 'k', server: _home, session: s, since: 3, question: _ask([_q(['A'])]));
      expect(inboxSeenSig(bare), isNull);
      expect(inboxSeenSig(read), 'question|t1');
      final next = InboxItem(
          kind: InboxKind.question,
          key: 'k',
          server: _home,
          session: s,
          question: PendingQuestion(toolUseId: 't2', questions: [_q(['A'])]));
      expect(inboxSeenSig(next), isNot(inboxSeenSig(read)));
    });

    test("a supervisor item's signature does not move between two fetches with a different clock", () {
      final body = {
        'role': 'authority',
        'now': 1000,
        'cards': [
          {'id': 'k1', 'sessionId': 's2', 'server': 'Home', 'text': 't', 'at': 20},
        ],
        'cases': [
          {'id': 'c1', 'rule': 'R2', 'sessionId': 's2', 'server': 'Home', 'line': 'l', 'openedAt': 1,
            'escalated': {'question': 'q', 'at': 10}},
        ],
        'needsYou': ['s2'],
        'sessions': [
          {'id': 's2', 'server': 'Home', 'wait': {'on': 'you', 'what': 'w', 'at': 3}},
        ],
      };
      final rows = [_s('s2')];
      List<String?> sigs(int receivedAt) {
        final st = SupervisorState.fromJson(body, receivedAt: DateTime.fromMillisecondsSinceEpoch(receivedAt))!;
        final items = supervisorItemsOf(st, _office, rows);
        expect(items, hasLength(3));
        return [for (final i in items) inboxSeenSig(i)];
      }

      final first = sigs(1000);
      final second = sigs(1730); // the poll landed later: the skew-corrected clock moved
      expect(first, second);
      expect(first.every((x) => x != null), isTrue);
    });

    test('mergeSeen keeps what an item not listed now had, and lets the current win', () {
      expect(mergeSeen({'a': '1', 'b': '2'}, {'b': '3', 'c': '4'}), {'a': '1', 'b': '3', 'c': '4'});
      expect(mergeSeen(null, {'c': '4'}), {'c': '4'});
    });
  });
}
