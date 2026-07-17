// Unit tests for DashboardScreen's server-group ordering (owner: "the server
// order always changes, it's confusing"). Exercises the pure
// groupSessionsByServer function directly — no widget tree, no
// SessionRepository/network — so group order can be asserted independent of
// session recency.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';

ServerConfig _server(String name, String baseUrl) =>
    ServerConfig(name: name, baseUrl: baseUrl, bearerToken: 't');

Session _session({
  required String id,
  required ServerConfig server,
  int? lastActivity,
}) => Session(
  id: id,
  name: 'proj-$id',
  cwd: '/home/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: lastActivity,
  notifyLevel: 'important',
  server: server,
  autoCommand: '',
);

void main() {
  final home = _server('Home', 'http://home:7681');
  final xps = _server('XPS', 'http://xps:7681');
  final office = _server('Office', 'http://office:7681');

  test('groups are ordered by the configured server order, not by session '
      'first appearance', () {
    // Sessions appear XPS-first, Office-second, Home-last — the opposite of
    // the configured order — to prove the group order doesn't follow them.
    final sessions = [
      _session(id: 'x1', server: xps),
      _session(id: 'o1', server: office),
      _session(id: 'h1', server: home),
    ];

    final groups = groupSessionsByServer(sessions, [home, xps, office]);

    expect(groups.map((g) => g.server.name).toList(), ['Home', 'XPS', 'Office']);
  });

  test('order stays stable across "refreshes" with different session order', () {
    final configured = [home, xps, office];
    final refresh1 = [
      _session(id: 'a', server: office),
      _session(id: 'b', server: home),
    ];
    final refresh2 = [
      _session(id: 'b', server: home),
      _session(id: 'a', server: office),
    ];

    final groups1 = groupSessionsByServer(refresh1, configured);
    final groups2 = groupSessionsByServer(refresh2, configured);

    expect(groups1.map((g) => g.server.name).toList(), ['Home', 'Office']);
    expect(groups2.map((g) => g.server.name).toList(), ['Home', 'Office']);
  });

  test('a server with no sessions contributes no group', () {
    final sessions = [_session(id: 'h1', server: home)];

    final groups = groupSessionsByServer(sessions, [home, xps, office]);

    expect(groups.map((g) => g.server.name).toList(), ['Home']);
  });

  test('within a group, sessions keep their incoming (attention-sorted) order', () {
    final sessions = [
      _session(id: 'h2', server: home),
      _session(id: 'h1', server: home),
    ];

    final groups = groupSessionsByServer(sessions, [home]);

    expect(groups.single.sessions.map((s) => s.id).toList(), ['h2', 'h1']);
  });

  test('a session whose server was removed from Settings still gets a group, '
      'appended after the configured ones', () {
    final orphanServer = _server('Old', 'http://old:7681');
    final sessions = [
      _session(id: 'x1', server: xps),
      _session(id: 'o1', server: orphanServer),
      _session(id: 'h1', server: home),
    ];

    // 'Old' is no longer in the configured list (removed via Settings).
    final groups = groupSessionsByServer(sessions, [home, xps]);

    expect(groups.map((g) => g.server.name).toList(), ['Home', 'XPS', 'Old']);
  });

  group('visibleFavoriteSessions (#66)', () {
    Session favSession(String id, ServerConfig server) => Session(
          id: id,
          name: 'proj-$id',
          cwd: '/home/x',
          status: 'idle',
          claudeSessionId: null,
          lastActivity: 1,
          notifyLevel: 'important',
          server: server,
          autoCommand: '',
          favorite: true,
          favoriteRank: 0,
        );

    test('drops a favorite whose owning server is offline', () {
      final sessions = [favSession('h1', home), favSession('x1', xps)];

      final visible = visibleFavoriteSessions(sessions, {
        home.baseUrl: true,
        xps.baseUrl: false, // XPS is down
      });

      expect(visible.map((s) => s.id).toList(), ['h1']);
    });

    test('keeps a favorite whose server has no online entry yet '
        '(not-yet-refreshed defaults to reachable)', () {
      final sessions = [favSession('h1', home)];

      final visible = visibleFavoriteSessions(sessions, const {});

      expect(visible.map((s) => s.id).toList(), ['h1']);
    });

    test('keeps every favorite when all owning servers are online', () {
      final sessions = [favSession('h1', home), favSession('x1', xps)];

      final visible = visibleFavoriteSessions(sessions, {
        home.baseUrl: true,
        xps.baseUrl: true,
      });

      expect(visible.map((s) => s.id).toSet(), {'h1', 'x1'});
    });
  });

  group('favoriteToggleAllowed (#60 + #66)', () {
    test('allowed when the server supports favorites-sync and is online', () {
      expect(
        favoriteToggleAllowed(supportsFavorites: true, serverOnline: true),
        isTrue,
      );
    });

    test('hidden when the owning server is offline, even if it supports '
        'favorites-sync', () {
      expect(
        favoriteToggleAllowed(supportsFavorites: true, serverOnline: false),
        isFalse,
        reason: '#66: an offline-owned favorite must not offer a star wired '
            'to an always-failing PATCH',
      );
    });

    test('hidden when the server does not support favorites-sync, even if '
        'online', () {
      expect(
        favoriteToggleAllowed(supportsFavorites: false, serverOnline: true),
        isFalse,
      );
    });

    test('allowed when online-ness is unknown yet (no online entry = not '
        'confirmed offline)', () {
      expect(
        favoriteToggleAllowed(supportsFavorites: true, serverOnline: null),
        isTrue,
      );
    });
  });
}
