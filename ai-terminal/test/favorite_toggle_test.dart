import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/favorite_toggle.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/services/session_repository.dart';

const _refused =
    ServerConfig(name: 'A', baseUrl: 'http://a:7785', bearerToken: 't');

/// #180 — the pin rules, once a session could be starred from TWO places (the
/// list row and the session's own meta bar).
///
/// These are pure by design, following the same convention as
/// `session_screen_fork_menu_test.dart`: pumping the whole SessionScreen needs a
/// live ApiClient / SessionRepository / notification stack, so the rules are
/// pulled out and pinned here instead.
///
/// `favoriteToggleAllowed`'s own matrix stays in `dashboard_screen_test.dart`,
/// which reaches it through the re-export — that test passing is also what proves
/// the re-export still resolves for existing importers.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('favoriteStarIcon / favoriteStarTooltip (#180)', () {
    // The glyph and the wording used to be written inline in session_card.dart,
    // and #180 would have written them a second time in the meta bar. #169 is
    // what a drifted pair of favourite affordances costs, so they are shared —
    // and these assertions are what make a drift a failing test rather than a
    // thing someone notices on a phone.
    test('a pinned session offers to REMOVE, with a filled star', () {
      expect(favoriteStarIcon(true), Icons.star);
      expect(favoriteStarTooltip(true), 'Remove from favorites');
    });

    test('an unpinned session offers to ADD, with an outlined star', () {
      expect(favoriteStarIcon(false), Icons.star_border);
      expect(favoriteStarTooltip(false), 'Add to favorites');
    });

    test('the tooltip names the ACTION, never the state', () {
      // "Favorited" would describe the star; "Remove from favorites" describes
      // what pressing it does, which is the rule the rest of this app's controls
      // follow (Fork session / Kill session / Read the last answer aloud).
      for (final on in [true, false]) {
        final t = favoriteStarTooltip(on);
        expect(t.startsWith('Remove') || t.startsWith('Add'), isTrue,
            reason: 'tooltip should start with a verb, got "$t"');
      }
    });

    test('the two states never render the same glyph or the same words', () {
      expect(favoriteStarIcon(true), isNot(favoriteStarIcon(false)));
      expect(favoriteStarTooltip(true), isNot(favoriteStarTooltip(false)));
    });
  });

  group('favoriteToggleAllowed — the gate both call sites share (#60/#66/#180)', () {
    // Re-asserted from THIS module (rather than only through dashboard_screen's
    // re-export) because the meta bar star is now a second caller: if the gate
    // ever moved again, this is the test that says where it is supposed to live.
    test('offered when the server syncs favourites and is reachable', () {
      expect(
        favoriteToggleAllowed(supportsFavorites: true, serverUsable: true),
        isTrue,
      );
    });

    test('withheld when the owning server is known to be unusable', () {
      // It would only ever fail the PATCH, so the control is hidden rather than
      // wired to a guaranteed failure (#66).
      expect(
        favoriteToggleAllowed(supportsFavorites: true, serverUsable: false),
        isFalse,
      );
    });

    test('UNUSABLE covers a 401, not just an unreachable server', () async {
      // The parameter is `serverUsable`, not `serverOnline`, and the rename is
      // the point: a server that answered 401 is perfectly REACHABLE and its
      // PATCH is guaranteed to fail just the same. While this gate read raw
      // reachability, a refused server kept a live-looking star.
      //
      // Driven through a real 401 rather than a literal `false`: an earlier
      // version of this spec passed `serverUsable: false` by hand, which only
      // restated the test above it and would have stayed green with the 401
      // half of `SessionRepository.serverUsable` deleted.
      SharedPreferences.setMockInitialValues({
        ServerStore.storageKey: jsonEncode([
          {'name': 'A', 'baseUrl': _refused.baseUrl, 'bearerToken': 't'},
        ]),
      });
      final store = ServerStore.forTest();
      await store.init();
      final repo = SessionRepository.forTest(
        store: store,
        clientFactory: (s) => ApiClient(
          s,
          httpClient: MockClient((req) async => req.url.path == '/api/version'
              ? http.Response(
                  jsonEncode({
                    'serverName': 'A',
                    'version': '1',
                    'capabilities': ['favorites-sync'],
                  }),
                  200)
              : http.Response('', 401)),
        ),
      );
      await repo.refresh();

      final supports = repo.supportsFavorites(_refused.baseUrl);
      expect(supports, isTrue,
          reason: 'otherwise the gate is closed for the wrong reason');
      expect(repo.serverOnline[_refused.baseUrl], isFalse);
      expect(repo.serverOfflineConfirmed[_refused.baseUrl], isFalse,
          reason: 'a 401 is not an outage, so hysteresis alone says usable');
      expect(
        favoriteToggleAllowed(
          supportsFavorites: supports,
          serverUsable: repo.serverUsable[_refused.baseUrl],
        ),
        isFalse,
      );
    });

    test('withheld when the server is too old to have the route', () {
      expect(
        favoriteToggleAllowed(supportsFavorites: false, serverUsable: true),
        isFalse,
      );
    });

    test('an UNKNOWN state still offers it — null is not "down"', () {
      // A server we have not heard from yet is not the same as one we know is
      // down; hiding the star on first paint would make it flicker in. This is
      // also why `serverUsable` omits a server nobody has failed to reach.
      expect(
        favoriteToggleAllowed(supportsFavorites: true, serverUsable: null),
        isTrue,
      );
    });
  });
}
