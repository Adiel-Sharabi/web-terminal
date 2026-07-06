// Widget tests for SessionCard's API-error overlay: an active ApiErrorInfo
// overrides the card's dot/border/tint, shows the error text as a subtitle,
// and suppresses the redundant status-derived "API error" attention chip.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/attention_chip.dart';
import 'package:ai_terminal/widgets/session_card.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({String status = 'working'}) => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: '/home/x',
  status: status,
  claudeSessionId: null,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
);

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('inactive apiError renders the card normally', (tester) async {
    final session = _session();
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          apiError: const ApiErrorInfo(active: false),
        ),
      ),
    );

    expect(find.text('Working'), findsOneWidget);
  });

  testWidgets('active apiError shows the error text as a subtitle', (
    tester,
  ) async {
    final session = _session(status: 'api_error');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          attentionKind: 'apierror',
          apiError: const ApiErrorInfo(
            active: true,
            text: 'Rate limited — retrying',
            transient: true,
          ),
        ),
      ),
    );

    expect(find.textContaining('Rate limited — retrying'), findsOneWidget);
    // The override supersedes the redundant status-derived chip.
    expect(find.byType(AttentionChip), findsNothing);
  });

  testWidgets('autoContinue > 0 appends an auto-recovering note', (
    tester,
  ) async {
    final session = _session(status: 'api_error');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          apiError: const ApiErrorInfo(
            active: true,
            text: 'Stuck on a 529',
            autoContinue: 2,
            action: 'continue',
          ),
        ),
      ),
    );

    expect(find.textContaining('auto-recovering'), findsOneWidget);
  });

  testWidgets('autoContinue == 0 does not show the auto-recovering note', (
    tester,
  ) async {
    final session = _session(status: 'api_error');
    await tester.pumpWidget(
      _wrap(
        SessionCard(
          session: session,
          apiError: const ApiErrorInfo(active: true, text: 'First failure'),
        ),
      ),
    );

    expect(find.text('First failure'), findsOneWidget);
    expect(find.textContaining('auto-recovering'), findsNothing);
  });
}
