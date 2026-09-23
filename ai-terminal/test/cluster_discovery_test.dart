// #97 — the app's server list follows the cluster, instead of being retyped on
// every device.
//
// Two rules carry the whole feature, and both are easy to get subtly wrong:
//   * the cluster owns what it gave us; the user owns what they typed;
//   * an unreachable server REMOVES NOTHING — otherwise one flaky moment wipes
//     the list.
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/cluster_discovery.dart';
import 'package:ai_terminal/services/server_store.dart';

/// A fake client: canned peer lists and minted tokens, no network.
class _FakeClient implements ApiClient {
  _FakeClient(this.server, this.peers, this.mint, this.calls);

  @override
  final ServerConfig server;
  final Map<String, List<ClusterPeer>> peers; // baseUrl -> advertised peers
  final Map<String, String?> mint; // peer url -> token, or null to fail
  final List<String> calls;

  @override
  Future<List<ClusterPeer>> listClusterServers() async {
    calls.add('list:${server.baseUrl}');
    final p = peers[server.baseUrl];
    if (p == null) throw const ApiException(0, 'Server unreachable');
    return p;
  }

  @override
  Future<String> requestClientToken({
    required String url,
    String label = 'companion',
  }) async {
    calls.add('mint:$url via ${server.baseUrl}');
    final t = mint[url];
    if (t == null) throw const ApiException(0, 'nope');
    return t;
  }

  @override
  dynamic noSuchMethod(Invocation i) => super.noSuchMethod(i);
}

Future<ServerStore> _store(List<ServerConfig> servers) async {
  SharedPreferences.setMockInitialValues({
    ServerStore.storageKey: jsonEncode([
      for (final s in servers)
        {
          'name': s.name,
          'baseUrl': s.baseUrl,
          'bearerToken': s.bearerToken,
          'origin': s.origin.name,
        },
    ]),
  });
  final st = ServerStore.forTest();
  await st.init();
  return st;
}

const _home = ServerConfig(
  name: 'Home',
  baseUrl: 'http://home:7681',
  bearerToken: 'home-tok',
  origin: ServerOrigin.manual,
);

void main() {
  group('ServerStore.syncDiscovered', () {
    test('adds a newly discovered peer', () async {
      final st = await _store([_home]);
      final changed = await st.syncDiscovered([
        const ServerConfig(
            name: 'Office-Tests',
            baseUrl: 'http://ot:7681',
            bearerToken: 't',
            origin: ServerOrigin.cluster),
      ]);
      expect(changed, isTrue);
      expect(st.servers.map((s) => s.baseUrl),
          containsAll(['http://home:7681', 'http://ot:7681']));
      expect(
          st.servers.firstWhere((s) => s.baseUrl == 'http://ot:7681').origin,
          ServerOrigin.cluster);
    });

    test('a peer that LEFT the cluster is removed', () async {
      final st = await _store([
        _home,
        const ServerConfig(
            name: 'Gone',
            baseUrl: 'http://gone:7681',
            bearerToken: 't',
            origin: ServerOrigin.cluster),
      ]);
      await st.syncDiscovered(const []);
      expect(st.servers.map((s) => s.baseUrl), ['http://home:7681']);
    });

    test('a MANUAL server is never removed, even if the cluster omits it',
        () async {
      // The whole point of keeping the offline list: a box that is deliberately
      // not in the cluster must keep working.
      final st = await _store([_home]);
      await st.syncDiscovered(const []);
      expect(st.servers.single.baseUrl, 'http://home:7681');
      expect(st.servers.single.origin, ServerOrigin.manual);
    });

    test('a MANUAL server is not converted even if the cluster advertises it',
        () async {
      final st = await _store([_home]);
      await st.syncDiscovered([
        const ServerConfig(
            name: 'Renamed By Cluster',
            baseUrl: 'http://home:7681',
            bearerToken: 'other',
            origin: ServerOrigin.cluster),
      ]);
      final s = st.servers.single;
      expect(s.origin, ServerOrigin.manual);
      expect(s.name, 'Home', reason: 'the user owns their own entry');
      expect(s.bearerToken, 'home-tok');
    });

    test('a discovered entry with an empty token is ignored, not stored broken',
        () async {
      final st = await _store([_home]);
      await st.syncDiscovered([
        const ServerConfig(
            name: 'NoTok',
            baseUrl: 'http://notok:7681',
            bearerToken: '',
            origin: ServerOrigin.cluster),
      ]);
      expect(st.servers.map((s) => s.baseUrl), ['http://home:7681']);
    });

    test('no change reports false so callers can skip a pointless emit',
        () async {
      final st = await _store([_home]);
      expect(await st.syncDiscovered(const []), isFalse);
    });
  });

  group('ClusterDiscovery.refresh', () {
    test('discovers a peer and mints a token for it', () async {
      final st = await _store([_home]);
      final calls = <String>[];
      final disco = ClusterDiscovery(
        store: st,
        clientBuilder: (s) => _FakeClient(
          s,
          {
            'http://home:7681': const [
              ClusterPeer(
                  name: 'Office-Tests',
                  url: 'http://ot:7681',
                  hasToken: true),
            ],
          },
          {'http://ot:7681': 'minted-tok'},
          calls,
        ),
      );

      expect(await disco.refresh(), isTrue);
      final added = st.servers.firstWhere((s) => s.baseUrl == 'http://ot:7681');
      expect(added.bearerToken, 'minted-tok');
      expect(added.name, 'Office-Tests');
      expect(added.origin, ServerOrigin.cluster);
      expect(calls, contains('mint:http://ot:7681 via http://home:7681'));
    });

    test('a peer the advertiser cannot vouch for (hasToken:false) is skipped',
        () async {
      final st = await _store([_home]);
      final calls = <String>[];
      final disco = ClusterDiscovery(
        store: st,
        clientBuilder: (s) => _FakeClient(
          s,
          {
            'http://home:7681': const [
              ClusterPeer(name: 'Half', url: 'http://half:7681', hasToken: false),
            ],
          },
          {'http://half:7681': 'should-not-be-used'},
          calls,
        ),
      );
      expect(await disco.refresh(), isFalse);
      expect(st.servers.length, 1);
      expect(calls.any((c) => c.startsWith('mint:')), isFalse,
          reason: 'no point asking for a token the advertiser cannot get');
    });

    test('THE safety rule: everything unreachable removes NOTHING', () async {
      // A flaky network must never be read as "the cluster is empty".
      final st = await _store([
        _home,
        const ServerConfig(
            name: 'Discovered',
            baseUrl: 'http://disc:7681',
            bearerToken: 't',
            origin: ServerOrigin.cluster),
      ]);
      final disco = ClusterDiscovery(
        store: st,
        // No entry in `peers` -> every listClusterServers throws.
        clientBuilder: (s) => _FakeClient(s, const {}, const {}, <String>[]),
      );
      expect(await disco.refresh(), isFalse);
      expect(st.servers.length, 2, reason: 'nothing may be dropped');
    });

    test('a server that cannot mint is retried via another that can', () async {
      final st = await _store([
        _home,
        const ServerConfig(
            name: 'Office',
            baseUrl: 'http://office:7681',
            bearerToken: 'o',
            origin: ServerOrigin.manual),
      ]);
      final calls = <String>[];
      final disco = ClusterDiscovery(
        store: st,
        clientBuilder: (s) => _FakeClient(
          s,
          {
            // Home is unreachable; Office advertises the peer.
            'http://office:7681': const [
              ClusterPeer(name: 'OT', url: 'http://ot:7681', hasToken: true),
            ],
          },
          {'http://ot:7681': 'from-office'},
          calls,
        ),
      );
      expect(await disco.refresh(), isTrue);
      expect(
          st.servers.firstWhere((s) => s.baseUrl == 'http://ot:7681').bearerToken,
          'from-office');
    });

    test('an empty list of known servers does nothing at all', () async {
      final st = await _store(const []);
      final disco = ClusterDiscovery(
        store: st,
        clientBuilder: (s) => _FakeClient(s, const {}, const {}, <String>[]),
      );
      expect(await disco.refresh(), isFalse);
    });
  });

  // A held token dies on a TIMER, not on anything this device does: app tokens
  // carry a 90-day expiry and are pruned server-side once past it. Discovery
  // used to call a token "usable" because the STRING was non-empty — a fact
  // about our storage, not about the server — so it sat on a dead credential
  // while this very re-mint path was available and unused.
  //
  // Measured 2026-09-21: office's companion token expired and was pruned at
  // 00:17; the phone reported "Office is unreachable" while office was healthy,
  // 37ms away, and serving every other caller.
  group('ClusterDiscovery re-mints a REFUSED token (#272)', () {
    const staleOffice = ServerConfig(
      name: 'Office',
      baseUrl: 'http://office:7681',
      bearerToken: 'expired-tok',
      origin: ServerOrigin.cluster,
    );

    ClusterDiscovery build(
      ServerStore st,
      List<String> calls, {
      required bool refused,
      String? mintResult = 'fresh-tok',
      String peerName = 'Office',
      bool hasToken = true,
    }) =>
        ClusterDiscovery(
          store: st,
          staleToken: (baseUrl) => refused && baseUrl == 'http://office:7681',
          clientBuilder: (s) => _FakeClient(
            s,
            {
              'http://home:7681': [
                ClusterPeer(
                    name: peerName,
                    url: 'http://office:7681',
                    hasToken: hasToken),
              ],
            },
            {'http://office:7681': mintResult},
            calls,
          ),
        );

    test('a refused token is replaced with a freshly minted one', () async {
      final st = await _store([_home, staleOffice]);
      final calls = <String>[];
      expect(await build(st, calls, refused: true).refresh(), isTrue);
      expect(
        st.servers.firstWhere((s) => s.baseUrl == 'http://office:7681').bearerToken,
        'fresh-tok',
      );
      expect(calls, contains('mint:http://office:7681 via http://home:7681'));
    });

    test('a token that was NOT refused is never re-minted', () async {
      // The load-bearing negative. Without the probe gating it, every refresh
      // would mint a new token for every server forever — which is both the
      // token-store flood this repo already has and a silent rotation of
      // credentials nobody asked to rotate.
      final st = await _store([_home, staleOffice]);
      final calls = <String>[];
      expect(await build(st, calls, refused: false).refresh(), isFalse);
      expect(
        st.servers.firstWhere((s) => s.baseUrl == 'http://office:7681').bearerToken,
        'expired-tok',
      );
      expect(calls.any((c) => c.startsWith('mint:')), isFalse);
    });

    test('a refused server whose re-mint FAILS is kept, not deleted', () async {
      // `syncDiscovered` reads an absent entry as "left the cluster" and drops
      // it, so returning nothing for a failed re-mint would turn a recoverable
      // auth failure into a server that vanished from the user's list.
      final st = await _store([_home, staleOffice]);
      final calls = <String>[];
      await build(st, calls, refused: true, mintResult: null).refresh();
      final kept =
          st.servers.where((s) => s.baseUrl == 'http://office:7681').toList();
      expect(kept, hasLength(1));
      expect(kept.single.bearerToken, 'expired-tok');
      expect(kept.single.name, 'Office');
    });

    test('a refused server the advertiser cannot vouch for is KEPT, not deleted',
        () async {
      // The sibling of the test above, and the one that was missing.
      //
      // `hasToken` is ONE ADVERTISER's view of its own gitignored, per-machine
      // cluster-tokens.json - it is not a statement that the server left the
      // cluster. And `advertised.putIfAbsent` keeps the FIRST advertiser's
      // answer, so a single peer missing a token for Office decides this even
      // when three others have one.
      //
      // Why it was unguarded: until a REFUSED entry could fall past the
      // keep-branch, `existing` was always null at that exit, so the bare
      // `continue` was harmless. The refused path made it reachable for a
      // server the user already had, and a `continue` there means the entry is
      // absent from `discovered`, which `syncDiscovered` reads as "left the
      // cluster -> drop it" - deleting the server AND its token, silently.
      final st = await _store([_home, staleOffice]);
      final calls = <String>[];
      await build(st, calls, refused: true, hasToken: false).refresh();
      final kept =
          st.servers.where((s) => s.baseUrl == 'http://office:7681').toList();
      expect(kept, hasLength(1),
          reason: 'the refused server was deleted outright, token and all');
      expect(kept.single.bearerToken, 'expired-tok');
      expect(kept.single.name, 'Office');
      // Nothing to mint THROUGH, so nothing should have been attempted.
      expect(calls.any((c) => c.startsWith('mint:')), isFalse);
    });

    test('a re-mint never renames the server to its own URL', () async {
      // The add path names a brand-new peer after its URL when the advertiser
      // offers no name; on a RE-mint that would rewrite "Office" to
      // "http://office:7681" in the user's list.
      final st = await _store([_home, staleOffice]);
      final calls = <String>[];
      await build(st, calls, refused: true, peerName: '').refresh();
      expect(
        st.servers.firstWhere((s) => s.baseUrl == 'http://office:7681').name,
        'Office',
      );
    });

    test('a refused MANUAL entry is left alone (known, deliberate gap)',
        () async {
      // Pins the documented limitation so removing it is a decision rather
      // than an accident: overwriting a credential the user typed by hand is
      // not a repair, and `syncDiscovered` refuses to touch a manual entry
      // anyway. Deleting it and letting discovery re-add it heals it for good.
      final st = await _store([
        _home,
        staleOffice.copyWith(origin: ServerOrigin.manual),
      ]);
      final calls = <String>[];
      await build(st, calls, refused: true).refresh();
      expect(
        st.servers.firstWhere((s) => s.baseUrl == 'http://office:7681').bearerToken,
        'expired-tok',
      );
      expect(calls.any((c) => c.startsWith('mint:')), isFalse);
    });
  });
}
