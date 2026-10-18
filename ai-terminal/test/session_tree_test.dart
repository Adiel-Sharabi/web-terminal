import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/util/session_tree.dart';
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
}
