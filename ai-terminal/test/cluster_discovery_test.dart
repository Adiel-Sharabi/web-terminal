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
}
