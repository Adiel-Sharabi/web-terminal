// Widget tests for FavoritesGroup: order resolution, silently dropping
// favorites whose session isn't present, and the empty (no favorites) case.
// Deliberately independent of FavoritesService — the widget takes its inputs
// as plain constructor params, so no service singleton is needed here.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/favorites_group.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session(String id, {String name = ''}) => Session(
  id: id,
  name: name.isEmpty ? id : name,
  cwd: '/home/x',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('renders favorites in stored order via cardBuilder', (
    tester,
  ) async {
    final built = <String>[];
    final sessions = [_session('a'), _session('b'), _session('c')];

    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          order: const ['c', 'a'],
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

    expect(built, ['c', 'a']);
    expect(find.text('FAVORITES'), findsOneWidget);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('silently drops favorite ids with no matching session', (
    tester,
  ) async {
    final built = <String>[];
    final sessions = [_session('a')];

    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          order: const ['a', 'gone', 'also-gone'],
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

    expect(built, ['a']);
    expect(find.text('1'), findsOneWidget);
  });

  testWidgets('renders nothing when there are no favorites', (tester) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          order: const [],
          sessions: [_session('a')],
          cardBuilder: (context, s) => Text(s.id),
          collapsed: false,
          onToggleCollapsed: () {},
        ),
      ),
    );

    expect(find.text('FAVORITES'), findsNothing);
  });

  testWidgets('renders nothing when every favorite session is gone', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        FavoritesGroup(
          order: const ['gone'],
          sessions: [_session('a')],
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
          order: const ['a'],
          sessions: [_session('a')],
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
          order: const ['a', 'b'],
          sessions: [_session('a'), _session('b')],
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
