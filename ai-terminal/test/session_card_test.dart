// Widget test for SessionCard across the statuses that drive its tint and
// attention chip (spec §2).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/attention_chip.dart';
import 'package:ai_terminal/widgets/session_card.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({
  required String status,
  String name = 'my-project',
  String id = 'abc12345',
}) => Session(
  id: id,
  name: name,
  cwd: '/home/x',
  status: status,
  claudeSessionId: null,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

Widget _wrap(Widget child) => MaterialApp(
  theme: AppTheme.dark,
  home: Scaffold(body: child),
);

void main() {
  testWidgets('working session renders its name with no attention chip', (
    tester,
  ) async {
    final session = _session(status: 'working');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          attentionKind: attentionKindForStatus(session.status),
        ),
      ),
    );

    expect(find.text('my-project'), findsOneWidget);
    expect(find.byType(AttentionChip), findsNothing);
  });

  testWidgets('selected card draws a primary-colored outline', (tester) async {
    final session = _session(status: 'idle');
    await tester.pumpWidget(_wrap(SessionCard(session: session, selected: true)));

    final primary = AppTheme.dark.colorScheme.primary;
    // The outer decorated Container carries the selected border.
    final decorated = tester
        .widgetList<Container>(find.byType(Container))
        .firstWhere((c) => c.decoration is BoxDecoration &&
            (c.decoration as BoxDecoration).border is Border);
    final border = (decorated.decoration as BoxDecoration).border as Border;
    expect(border.top.color, primary);
    expect(border.top.width, 2);
  });

  testWidgets('unselected card does NOT use the primary outline',
      (tester) async {
    final session = _session(status: 'idle');
    await tester.pumpWidget(_wrap(SessionCard(session: session)));
    final primary = AppTheme.dark.colorScheme.primary;
    final decorated = tester
        .widgetList<Container>(find.byType(Container))
        .firstWhere((c) => c.decoration is BoxDecoration &&
            (c.decoration as BoxDecoration).border is Border);
    final border = (decorated.decoration as BoxDecoration).border as Border;
    expect(border.top.color == primary && border.top.width == 2, isFalse);
  });

  testWidgets('idle session shows NO chip (plain idle is not attention)',
      (tester) async {
    final session = _session(status: 'idle');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          attentionKind: attentionKindForStatus(session.status),
        ),
      ),
    );

    expect(find.byType(AttentionChip), findsNothing);
    expect(find.text('Done'), findsNothing);
  });

  testWidgets('waiting session shows the Needs approval chip', (tester) async {
    final session = _session(status: 'waiting');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          attentionKind: attentionKindForStatus(session.status),
        ),
      ),
    );

    expect(find.byType(AttentionChip), findsOneWidget);
    expect(find.text('Needs approval'), findsOneWidget);
  });

  testWidgets('api_error session shows the API error chip', (tester) async {
    final session = _session(status: 'api_error');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          attentionKind: attentionKindForStatus(session.status),
        ),
      ),
    );

    expect(find.byType(AttentionChip), findsOneWidget);
    expect(find.text('API error'), findsOneWidget);
  });

  testWidgets('empty name falls back to Session {shortId}', (tester) async {
    final session = _session(status: 'idle', name: '', id: 'abcdefgh1234');
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.text('Session abcdefgh'), findsOneWidget);
  });

  testWidgets('tap and long-press callbacks fire', (tester) async {
    var tapped = false;
    var longPressed = false;
    final session = _session(status: 'idle');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          onTap: () => tapped = true,
          onLongPress: () => longPressed = true,
        ),
      ),
    );

    await tester.tap(find.byType(SessionCard));
    expect(tapped, isTrue);

    await tester.longPress(find.byType(SessionCard));
    expect(longPressed, isTrue);
  });

  testWidgets('favorite star renders outline when not favorited, tap toggles', (
    tester,
  ) async {
    var toggled = false;
    final session = _session(status: 'idle');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          onToggleFavorite: () => toggled = true,
        ),
      ),
    );

    expect(find.byIcon(Icons.star_border), findsOneWidget);
    expect(find.byIcon(Icons.star), findsNothing);

    await tester.tap(find.byIcon(Icons.star_border));
    expect(toggled, isTrue);
  });

  testWidgets('favorite star renders filled when isFavorite is true', (
    tester,
  ) async {
    final session = _session(status: 'idle');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          isFavorite: true,
          onToggleFavorite: () {},
        ),
      ),
    );

    expect(find.byIcon(Icons.star), findsOneWidget);
    expect(find.byIcon(Icons.star_border), findsNothing);
  });

  testWidgets('star is hidden when onToggleFavorite is not provided', (
    tester,
  ) async {
    final session = _session(status: 'idle');
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.byIcon(Icons.star), findsNothing);
    expect(find.byIcon(Icons.star_border), findsNothing);
  });

  testWidgets('more-actions tap fires onMoreTap and is hidden without it', (
    tester,
  ) async {
    var moreTapped = false;
    final session = _session(status: 'idle');
    await tester.pumpWidget(
      _wrap(SessionCard(session: session, onMoreTap: () => moreTapped = true)),
    );

    expect(find.byIcon(Icons.more_vert), findsOneWidget);
    await tester.tap(find.byIcon(Icons.more_vert));
    expect(moreTapped, isTrue);

    await tester.pumpWidget(_wrap(SessionCard(session: session)));
    expect(find.byIcon(Icons.more_vert), findsNothing);
  });

  testWidgets('bell tap fires onBellTap and is hidden without it', (
    tester,
  ) async {
    var bellTapped = false;
    final session = _session(status: 'idle');
    await tester.pumpWidget(
      _wrap(SessionCard(session: session, onBellTap: () => bellTapped = true)),
    );

    expect(find.byIcon(Icons.notifications_outlined), findsOneWidget);
    await tester.tap(find.byIcon(Icons.notifications_outlined));
    expect(bellTapped, isTrue);

    await tester.pumpWidget(_wrap(SessionCard(session: session)));
    expect(find.byIcon(Icons.notifications_outlined), findsNothing);
  });

  testWidgets('status label shows for working/idle/waiting, hidden for active', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(SessionCard(session: _session(status: 'working'))),
    );
    expect(find.text('Working'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(SessionCard(session: _session(status: 'idle'))),
    );
    expect(find.text('Idle'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(SessionCard(session: _session(status: 'waiting'))),
    );
    expect(find.text('Waiting'), findsOneWidget);

    await tester.pumpWidget(
      _wrap(SessionCard(session: _session(status: 'active'))),
    );
    expect(find.text('Active'), findsNothing);
  });
}
