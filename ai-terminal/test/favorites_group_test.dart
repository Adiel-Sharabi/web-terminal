// Widget tests for FavoritesGroup: derives membership + order straight off
// each Session's own favorite/favoriteRank fields (#60 — no separate `order`
// list), silently dropping nothing (there IS nothing to drop: a session not
// in the incoming list simply isn't rendered), and the empty (no favorites)
// case. Deliberately independent of any service singleton — the widget takes
// its inputs as plain constructor params.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/favorites_group.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session(
  String id, {
  String name = '',
  bool favorite = false,
  int? favoriteRank,
}) => Session(
  id: id,
  name: name.isEmpty ? id : name,
  cwd: '/home/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
  favorite: favorite,
  favoriteRank: favoriteRank,
);

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('renders favorites sorted by favoriteRank via cardBuilder', (
    tester,
  ) async {
    final built = <String>[];
    final sessions = [
      _session('a', favorite: true, favoriteRank: 1),
      _session('b', favorite: false),
      _session('c', favorite: true, favoriteRank: 0),
    ];

    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: sessions,
          cardBuilder: (context, s) {
            built.add(s.id);
            return Text(s.id);
          },
          collapsed: false,
          onToggleCollapsed: () {},
        ),
      ),
    );

    // 'c' (rank 0) before 'a' (rank 1); 'b' isn't favorited, so it's dropped.
    expect(built, ['c', 'a']);
    expect(find.text('FAVORITES'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('a session with no favoriteRank sorts as rank 0', (
    tester,
  ) async {
    final built = <String>[];
    final sessions = [
      _session('a', favorite: true, favoriteRank: 2),
      _session('b', favorite: true), // no rank -> treated as 0
    ];

    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: sessions,
          cardBuilder: (context, s) {
            built.add(s.id);
            return Text(s.id);
          },
          collapsed: false,
          onToggleCollapsed: () {},
        ),
      ),
    );

    expect(built, ['b', 'a']);
  });

  testWidgets('renders nothing when there are no favorites', (tester) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: [_session('a')],
          cardBuilder: (context, s) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsNothing);
  });

  testWidgets('renders nothing given an empty session list', (tester) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: const [],
          cardBuilder: (context, s) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsNothing);
  });

  testWidgets('tapping the header calls onToggleCollapsed', (tester) async {
    var toggled = false;
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: [_session('a', favorite: true, favoriteRank: 0)],
          cardBuilder: (context, s) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () => toggled = true,
        ),
      ),
    );

    await tester.tap(find.text('FAVORITES'));
    expect(toggled, isTrue);
  });

  testWidgets('collapsed hides the cards but keeps the header and count', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          sessions: [
            _session('a', favorite: true, favoriteRank: 0),
            _session('b', favorite: true, favoriteRank: 1),
          ],
          cardBuilder: (context, s) => Text(s.id),
          collapsed: true,
          onToggleCollapsed: () {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
    expect(find.text('a'), findsNothing);
    expect(find.text('b'), findsNothing);
    expect(find.byIcon(Icons.chevron_right), findsOneWidget);
    expect(find.byIcon(Icons.expand_more), findsNothing);
  });
}
