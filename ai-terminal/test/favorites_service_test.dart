import 'dart:convert';

import 'package:ai_terminal/services/favorites_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Builds a fresh, loaded, isolated service over the given initial prefs.
Future<FavoritesService> _loaded([Map<String, Object> initial = const {}]) async {
  SharedPreferences.setMockInitialValues(initial);
  final svc = FavoritesService.forTest();
  await svc.init();
  return svc;
}

List<String> _stored(SharedPreferences prefs) {
  final raw = prefs.getString(FavoritesService.storageKey);
  return raw == null
      ? const <String>[]
      : (jsonDecode(raw) as List).map((e) => e.toString()).toList();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('FavoritesService', () {
    test('loads an existing ordered list from prefs', () async {
      final svc = await _loaded({
        FavoritesService.storageKey: jsonEncode(['b', 'a', 'c'])
      });
      expect(svc.current, ['b', 'a', 'c']);
      expect(svc.isFavorite('a'), isTrue);
      expect(svc.isFavorite('z'), isFalse);
      await svc.dispose();
    });

    test('empty / missing key → empty list', () async {
      final svc = await _loaded();
      expect(svc.current, isEmpty);
      await svc.dispose();
    });

    test('toggle appends when absent and persists', () async {
      final svc = await _loaded();
      await svc.toggle('a');
      await svc.toggle('b');
      expect(svc.current, ['a', 'b']);
      expect(_stored(await SharedPreferences.getInstance()), ['a', 'b']);
      await svc.dispose();
    });

    test('toggle removes when present, keeping the rest in order', () async {
      final svc = await _loaded({
        FavoritesService.storageKey: jsonEncode(['a', 'b', 'c'])
      });
      await svc.toggle('b');
      expect(svc.current, ['a', 'c']);
      expect(_stored(await SharedPreferences.getInstance()), ['a', 'c']);
      await svc.dispose();
    });

    test('toggle re-adds a removed id to the END', () async {
      final svc = await _loaded({
        FavoritesService.storageKey: jsonEncode(['a', 'b', 'c'])
      });
      await svc.toggle('a'); // remove
      await svc.toggle('a'); // re-add
      expect(svc.current, ['b', 'c', 'a']);
      await svc.dispose();
    });

    test('setOrder replaces the order and persists', () async {
      final svc = await _loaded({
        FavoritesService.storageKey: jsonEncode(['a', 'b', 'c'])
      });
      await svc.setOrder(['c', 'a', 'b']);
      expect(svc.current, ['c', 'a', 'b']);
      expect(_stored(await SharedPreferences.getInstance()), ['c', 'a', 'b']);
      await svc.dispose();
    });

    test('setOrder drops duplicates keeping first occurrence', () async {
      final svc = await _loaded();
      await svc.setOrder(['a', 'b', 'a', 'c', 'b']);
      expect(svc.current, ['a', 'b', 'c']);
      await svc.dispose();
    });

    test('emits the new list on every change', () async {
      final svc = await _loaded();
      final seen = <List<String>>[];
      // Copy each emission to a plain list so the deep-equality matcher below
      // doesn't trip over UnmodifiableListView's identity-based `==`.
      final sub = svc.favorites.listen((e) => seen.add(e.toList()));
      await svc.toggle('a');
      await svc.toggle('b');
      await svc.setOrder(['b', 'a']);
      await Future<void>.delayed(Duration.zero);
      // onListen replays the initial [], then one emission per change.
      expect(seen, [
        <String>[],
        ['a'],
        ['a', 'b'],
        ['b', 'a'],
      ]);
      await sub.cancel();
      await svc.dispose();
    });

    test('replays the current value to a late subscriber', () async {
      final svc = await _loaded({
        FavoritesService.storageKey: jsonEncode(['x', 'y'])
      });
      final first = await svc.favorites.first;
      expect(first, ['x', 'y']);
      await svc.dispose();
    });

    test('current is unmodifiable', () async {
      final svc = await _loaded({
        FavoritesService.storageKey: jsonEncode(['a'])
      });
      expect(() => svc.current.add('b'), throwsUnsupportedError);
      await svc.dispose();
    });
  });
}
