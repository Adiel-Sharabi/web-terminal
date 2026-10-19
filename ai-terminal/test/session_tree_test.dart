import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart' show reorderedGroupIds;
import 'package:ai_terminal/theme/status_colors.dart';
import 'package:ai_terminal/util/session_tree.dart';
import 'package:ai_terminal/widgets/session_card.dart' show sessionDotStatus;
import 'package:flutter_test/flutter_test.dart';

const _home = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 't');
const _office = ServerConfig(name: 'Office', baseUrl: 'http://o:7681', bearerToken: 't');

Session _s(String id, {String? parent, ServerConfig server = _home, List<String> replaces = const []}) => Session(
      id: id,
      name: id,
      cwd: '',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: null,
      notifyLevel: 'important',
      server: server,
      parentId: parent,
      replaces: replaces,
    );

List<String> _rows(List<SessionTreeRow> rows) => [for (final r in rows) '${'  ' * r.depth}${r.session.id}'];

void main() {
  group('SessionTree.flatten (#374)', () {
    test('children follow their parent, indented, in list order; roots keep their order', () {
      final list = [_s('b-child', parent: 'a'), _s('z'), _s('a'), _s('a2', parent: 'a'), _s('gc', parent: 'b-child')];
      expect(_rows(SessionTree(list).flatten(list)), ['z', 'a', '  b-child', '    gc', '  a2']);
    });

    test('a parent on ANOTHER list (another server group, another column) leaves the child at top level here', () {
      final parent = _s('p', server: _office);
      final child = _s('c', parent: 'p');
      final tree = SessionTree([parent, child]);
      expect(_rows(tree.flatten([child])), ['c']);
      expect(tree.parentOf(child), same(parent), reason: 'it still knows its parent, for a caption');
      expect(tree.childrenOf(parent), [child]);
    });

    test('a parent that is gone, or never named, is no parent', () {
      final list = [_s('c', parent: 'gone'), _s('d')];
      final tree = SessionTree(list);
      expect(_rows(tree.flatten(list)), ['c', 'd']);
      expect(tree.parentOf(list[0]), isNull);
    });

    test('a session naming itself, or a loop, is drawn flat - every session exactly once', () {
      final list = [_s('self', parent: 'self'), _s('x', parent: 'y'), _s('y', parent: 'x'), _s('k')];
      final rows = SessionTree(list).flatten(list);
      expect(rows.map((r) => r.session.id).toSet(), {'self', 'x', 'y', 'k'});
      expect(rows, hasLength(4));
      expect(rows.firstWhere((r) => r.session.id == 'self').depth, 0);
    });

    test('a parent handed off keeps its helpers: they name the OLD id, which its successor replaces', () {
      final successor = _s('p2', server: _office, replaces: ['p1', 'p0']);
      final kid = _s('k', parent: 'p1');
      final older = _s('k0', parent: 'p0');
      final list = [kid, successor, older];
      final tree = SessionTree(list);
      expect(tree.parentOf(kid), same(successor));
      expect(tree.parentOf(older), same(successor), reason: 'the whole chain, not just the last hop');
      expect(_rows(tree.flatten(list)), ['p2', '  k', '  k0']);
    });

    test('a replaced id that a LIVE session still has is that session, not its successor', () {
      final old = _s('p1');
      final successor = _s('p2', replaces: ['p1']);
      final kid = _s('k', parent: 'p1');
      expect(SessionTree([old, successor, kid]).parentOf(kid), same(old));
    });

    test('two server entries for the same box: both rows are kept, each exactly once', () {
      final a = _s('x');
      final b = _s('x', server: _office);
      final rows = SessionTree([a, b]).flatten([a, b]);
      expect(rows.map((r) => r.session), [same(a), same(b)]);
    });

    test('in a loop the first listed becomes the root and the rest hang under it', () {
      final list = [_s('x', parent: 'y'), _s('y', parent: 'x')];
      expect(_rows(SessionTree(list).flatten(list)), ['x', '  y']);
    });

    test('the session list indents only as far as the row can afford (#374 review)', () {
      final deep = SessionTreeRow(_s('a'), 3);
      expect(deep.indentWithin(800), 60, reason: 'room to spare: the full indent');
      expect(deep.indentWithin(412), 12, reason: 'a big phone: what is left above the card minimum');
      expect(deep.indentWithin(384), 0);
      expect(deep.indentWithin(360), 0, reason: 'a small phone: no indent, the arrow marks the row');
    });

    test('indentation stops growing past the cap, so a deep chain keeps room for its title', () {
      final list = [_s('a'), _s('b', parent: 'a'), _s('c', parent: 'b'), _s('d', parent: 'c'), _s('e', parent: 'd')];
      final rows = SessionTree(list).flatten(list);
      expect(rows.map((r) => r.depth), [0, 1, 2, 3, 4]);
      expect(rows.last.indent, SessionTreeRow.step * SessionTreeRow.maxIndentLevels);
    });
  });

  group('folding a session\'s children (#377)', () {
    final list = [_s('a'), _s('k1', parent: 'a'), _s('g', parent: 'k1'), _s('k2', parent: 'a'), _s('z')];

    test('expanded, a parent row counts everything under it, at any depth', () {
      final rows = SessionTree(list).flatten(list);
      expect(_rows(rows), ['a', '  k1', '    g', '  k2', 'z']);
      expect([for (final r in rows) r.descendants], [3, 1, 0, 0, 0]);
      expect(rows.every((r) => !r.isFolded), isTrue);
    });

    test('a folded session hides its whole subtree and carries it, in display order', () {
      final rows = SessionTree(list).flatten(list, folded: {'a'});
      expect(_rows(rows), ['a', 'z']);
      expect(rows.first.isFolded, isTrue);
      expect(rows.first.descendants, 3);
      expect([for (final s in rows.first.folded) s.id], ['k1', 'g', 'k2']);
    });

    test('folding a child folds only its own subtree', () {
      final rows = SessionTree(list).flatten(list, folded: {'k1'});
      expect(_rows(rows), ['a', '  k1', '  k2', 'z']);
      expect(rows[0].descendants, 3, reason: 'folding below a changes nothing about what hangs under a');
      expect(rows[1].descendants, 1);
      expect([for (final s in rows[1].folded) s.id], ['g']);
    });

    test('a fold survives a hand-off: the successor is folded under the id it replaces', () {
      final successor = _s('a2', replaces: ['a']);
      final l = [successor, _s('k', parent: 'a')];
      final rows = SessionTree(l).flatten(l, folded: {'a'});
      expect(_rows(rows), ['a2']);
      expect(rows.first.isFolded, isTrue);
      expect(SessionTree.foldIds(successor), ['a2', 'a'],
          reason: 'unfolding must clear the replaced id too, or the fold could never be undone');
    });

    test('folding a session with no children changes nothing', () {
      final rows = SessionTree(list).flatten(list, folded: {'z', 'g'});
      expect(_rows(rows), ['a', '  k1', '    g', '  k2', 'z']);
      expect(rows.any((r) => r.isFolded), isFalse);
    });

    test('a loop is still drawn once when folded', () {
      final l = [_s('x', parent: 'y'), _s('y', parent: 'x')];
      final rows = SessionTree(l).flatten(l, folded: {'x'});
      expect(_rows(rows), ['x']);
      expect([for (final s in rows.first.folded) s.id], ['y']);
    });

    test('reordering a group writes a folded row\'s hidden sessions straight after it', () {
      final rows = SessionTree(list).flatten(list, folded: {'a'}); // shown: a, z
      expect(reorderedGroupIds(rows, 1, 0), ['z', 'a', 'k1', 'g', 'k2']);
      expect(reorderedGroupIds(rows, 0, 1), ['z', 'a', 'k1', 'g', 'k2']);
      final open = SessionTree(list).flatten(list);
      expect(reorderedGroupIds(open, 4, 0), ['z', 'a', 'k1', 'g', 'k2']);
    });
  });

  test('a folded helper\'s dot is the card\'s dot: a live API error wins over its status (#377)', () {
    final s = _s('h');
    expect(sessionDotStatus(s, null), SessionStatus.idle);
    expect(sessionDotStatus(s, const ApiErrorInfo(active: true)), SessionStatus.apiError);
    expect(sessionDotStatus(s, const ApiErrorInfo(active: false)), SessionStatus.idle);
  });
}
