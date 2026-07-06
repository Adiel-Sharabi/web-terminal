import 'dart:convert';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/server_store.dart';
import 'package:ai_terminal/spike_config.dart' as spike;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A minimal [ServerConfig] with a distinct base URL.
ServerConfig cfg(String baseUrl, {String name = 'n', String token = 't'}) =>
    ServerConfig(name: name, baseUrl: baseUrl, bearerToken: token);

/// Builds a fresh, loaded, isolated store. With no [servers] the storage key is
/// absent (first-run seeding path); with an (even empty) list the key is present
/// and is loaded verbatim (no reseed).
Future<ServerStore> loaded([List<ServerConfig>? servers]) async {
  SharedPreferences.setMockInitialValues(
    servers == null
        ? const <String, Object>{}
        : {ServerStore.storageKey: _encode(servers)},
  );
  final store = ServerStore.forTest();
  await store.init();
  return store;
}

String _encode(List<ServerConfig> servers) => jsonEncode([
      for (final s in servers)
        {'name': s.name, 'baseUrl': s.baseUrl, 'bearerToken': s.bearerToken},
    ]);

/// Reads the raw persisted server list straight out of prefs.
Future<List<ServerConfig>> stored() async {
  final prefs = await SharedPreferences.getInstance();
  final raw = prefs.getString(ServerStore.storageKey);
  if (raw == null) return const <ServerConfig>[];
  return (jsonDecode(raw) as List)
      .map((e) => ServerConfig(
            name: (e['name'] ?? '').toString(),
            baseUrl: (e['baseUrl'] ?? '').toString(),
            bearerToken: (e['bearerToken'] ?? '').toString(),
          ))
      .toList();
}

/// The list ServerStore would seed on first run, derived from spike_config the
/// same way the store does (so this test is correct whether or not the
/// gitignored spike constants happen to be populated).
String _norm(String u) {
  var b = u.trim();
  while (b.endsWith('/')) {
    b = b.substring(0, b.length - 1);
  }
  return b;
}

List<ServerConfig> expectedSeed() {
  // Mirror ServerStore._seed: prefer the multi-server seed when present.
  if (spike.kSeedServers.isNotEmpty) {
    final out = <ServerConfig>[];
    for (final s in spike.kSeedServers) {
      final base = _norm(s['baseUrl'] ?? '');
      final tok = s['bearerToken'] ?? '';
      if (base.isEmpty || tok.isEmpty) continue;
      out.add(ServerConfig(
        name: s['name'] ?? 'Server',
        baseUrl: base,
        bearerToken: tok,
      ));
    }
    return out;
  }
  final base = _norm(spike.kServerBase);
  if (base.isEmpty || spike.kBearerToken.isEmpty) return const <ServerConfig>[];
  return [
    ServerConfig(name: 'Shadow', baseUrl: base, bearerToken: spike.kBearerToken),
  ];
}

List<String> urls(Iterable<ServerConfig> s) => s.map((e) => e.baseUrl).toList();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ServerStore seeding', () {
    test('first run (key absent) seeds from spike_config and persists it',
        () async {
      final store = await loaded(); // key absent
      final seed = expectedSeed();
      expect(store.servers, seed);
      // The seed is written back so the choice sticks across launches.
      expect(await stored(), seed);
      await store.dispose();
    });

    test('present-but-empty key is NOT reseeded', () async {
      final store = await loaded(const <ServerConfig>[]); // key present, []
      expect(store.servers, isEmpty);
      await store.dispose();
    });

    test('loads an existing persisted list verbatim', () async {
      final store = await loaded([cfg('http://a'), cfg('http://b')]);
      expect(urls(store.servers), ['http://a', 'http://b']);
      await store.dispose();
    });

    test('servers is unmodifiable', () async {
      final store = await loaded([cfg('http://a')]);
      expect(() => store.servers.add(cfg('http://z')), throwsUnsupportedError);
      await store.dispose();
    });
  });

  group('ServerStore.add', () {
    test('appends a new server and persists', () async {
      final store = await loaded(const <ServerConfig>[]);
      await store.add(cfg('http://a', name: 'A'));
      await store.add(cfg('http://b', name: 'B'));
      expect(urls(store.servers), ['http://a', 'http://b']);
      expect(urls(await stored()), ['http://a', 'http://b']);
      await store.dispose();
    });

    test('add of an existing base URL updates in place (no duplicate)',
        () async {
      final store = await loaded([cfg('http://a', name: 'A', token: 'old')]);
      await store.add(cfg('http://a', name: 'A2', token: 'new'));
      expect(store.servers.length, 1);
      expect(store.servers.single.name, 'A2');
      expect(store.servers.single.bearerToken, 'new');
      await store.dispose();
    });

    test('rejects an empty base URL', () async {
      final store = await loaded(const <ServerConfig>[]);
      expect(() => store.add(cfg('   ')), throwsArgumentError);
      await store.dispose();
    });
  });

  group('ServerStore.update', () {
    test('replaces the entry at the index and persists', () async {
      final store = await loaded([cfg('http://a'), cfg('http://b')]);
      await store.update(1, cfg('http://c', name: 'C'));
      expect(urls(store.servers), ['http://a', 'http://c']);
      expect(store.servers[1].name, 'C');
      expect(urls(await stored()), ['http://a', 'http://c']);
      await store.dispose();
    });

    test('dropping a collision keeps the updated entry', () async {
      final store = await loaded([cfg('http://a'), cfg('http://b')]);
      // Point index 0 at b's URL: the old b entry must be dropped.
      await store.update(0, cfg('http://b', name: 'B-new'));
      expect(store.servers.length, 1);
      expect(store.servers.single.baseUrl, 'http://b');
      expect(store.servers.single.name, 'B-new');
      await store.dispose();
    });

    test('out-of-range index throws', () async {
      final store = await loaded([cfg('http://a')]);
      expect(() => store.update(5, cfg('http://z')), throwsRangeError);
      await store.dispose();
    });
  });

  group('ServerStore.removeAt', () {
    test('removes the entry and persists', () async {
      final store = await loaded([cfg('http://a'), cfg('http://b')]);
      await store.removeAt(0);
      expect(urls(store.servers), ['http://b']);
      expect(urls(await stored()), ['http://b']);
      await store.dispose();
    });

    test('out-of-range index throws', () async {
      final store = await loaded([cfg('http://a')]);
      expect(() => store.removeAt(-1), throwsRangeError);
      await store.dispose();
    });
  });

  group('ServerStore.setAll', () {
    test('replaces the whole list and persists', () async {
      final store = await loaded([cfg('http://a')]);
      await store.setAll([cfg('http://x'), cfg('http://y')]);
      expect(urls(store.servers), ['http://x', 'http://y']);
      expect(urls(await stored()), ['http://x', 'http://y']);
      await store.dispose();
    });

    test('drops duplicate base URLs keeping the first, and empty URLs',
        () async {
      final store = await loaded(const <ServerConfig>[]);
      await store.setAll([
        cfg('http://a', name: 'first'),
        cfg('   '),
        cfg('http://a', name: 'second'),
        cfg('http://b'),
      ]);
      expect(urls(store.servers), ['http://a', 'http://b']);
      expect(store.servers.first.name, 'first');
      await store.dispose();
    });
  });

  group('ServerStore base-URL normalization / dedupe', () {
    test('trailing slashes are stripped on store', () async {
      final store = await loaded(const <ServerConfig>[]);
      await store.add(cfg('http://a:7785/'));
      expect(store.servers.single.baseUrl, 'http://a:7785');
      await store.dispose();
    });

    test('add treats trailing-slash variants as the same server', () async {
      final store = await loaded([cfg('http://a:7785', name: 'A')]);
      await store.add(cfg('http://a:7785/', name: 'A2'));
      expect(store.servers.length, 1);
      expect(store.servers.single.name, 'A2');
      await store.dispose();
    });

    test('a persisted list with slash-dupes collapses on load', () async {
      final store = await loaded([
        cfg('http://a:7785/', name: 'A'),
        cfg('http://a:7785', name: 'A-dup'),
      ]);
      expect(store.servers.length, 1);
      expect(store.servers.single.baseUrl, 'http://a:7785');
      await store.dispose();
    });
  });

  group('ServerStore.updateServerName', () {
    test('renames the matching server (slash-insensitive) and persists',
        () async {
      final store = await loaded([cfg('http://a:7785', name: 'Shadow')]);
      store.updateServerName('http://a:7785/', 'Home');
      expect(store.servers.single.name, 'Home');
      // Persistence happens in the background; let it settle.
      await Future<void>.delayed(Duration.zero);
      expect((await stored()).single.name, 'Home');
      await store.dispose();
    });

    test('empty name or no match is a no-op', () async {
      final store = await loaded([cfg('http://a', name: 'A')]);
      store.updateServerName('http://a', '');
      store.updateServerName('http://nope', 'X');
      expect(store.servers.single.name, 'A');
      await store.dispose();
    });
  });

  group('ServerStore persistence across a fresh instance', () {
    test('a reloaded store reads what the previous one wrote', () async {
      final store = await loaded([cfg('http://a')]);
      await store.add(cfg('http://b'));
      await store.dispose();
      // Fresh instance over the SAME mock prefs (no setMockInitialValues reset).
      final reloaded = ServerStore.forTest();
      await reloaded.init();
      expect(urls(reloaded.servers), ['http://a', 'http://b']);
      await reloaded.dispose();
    });
  });

  group('ServerStore.changes', () {
    test('replays current to a new listener then emits every mutation',
        () async {
      final store = await loaded(const <ServerConfig>[]);
      final seen = <List<String>>[];
      final sub = store.changes.listen((e) => seen.add(urls(e)));
      await store.add(cfg('http://a'));
      await store.add(cfg('http://b'));
      await store.removeAt(0);
      await Future<void>.delayed(Duration.zero);
      expect(seen, [
        <String>[],
        ['http://a'],
        ['http://a', 'http://b'],
        ['http://b'],
      ]);
      await sub.cancel();
      await store.dispose();
    });

    test('a late subscriber gets the current list', () async {
      final store = await loaded([cfg('http://a'), cfg('http://b')]);
      final first = await store.changes.first;
      expect(urls(first), ['http://a', 'http://b']);
      await store.dispose();
    });
  });
}
