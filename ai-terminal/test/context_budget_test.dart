// #393 — the ctx colour is judged against the server's context BUDGET (where
// the agent actually compacts), not the 1M model window, and the compaction
// count is shown beside it. An older server that publishes no budget keeps
// the old % rule exactly.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/format_utils.dart';
import 'package:ai_terminal/widgets/session_card.dart';

/// What the server publishes for a 1M session under a 400k auto-compact window.
const Map<String, dynamic> _budgetJson = {
  'warnAt': 250000,
  'handoffAt': 300000,
  'compactAt': 367000,
  'source': 'autoCompactWindow',
};

Session _session(SessionMetrics metrics) => Session(
      id: 'abc12345',
      name: 'my-project',
      cwd: '/home/x',
      status: 'idle',
      claudeSessionId: null,
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      server: const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't'),
      autoCommand: '',
      metrics: metrics,
    );

Widget _wrap(Widget child) => MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(body: child),
    );

void main() {
  final theme = AppTheme.dark;
  final green = theme.colorScheme.primary;
  final red = theme.colorScheme.error;

  group('ctxColor against the budget', () {
    Color at(int tokens) => ctxColor(theme, (tokens / 10000).round(),
        tokens: tokens, warnAt: 250000, handoffAt: 300000);

    test('green below warn, amber from warn, red from the hand-off point', () {
      expect(at(249999), green);
      expect(at(250000), kWarnAmber);
      expect(at(299999), kWarnAmber);
      expect(at(300000), red);
      expect(at(366000), red);
    });

    test('a session the old % rule called green is amber or red now', () {
      // 31% of 1M: the % rule says green; 310k is past the 300k hand-off.
      expect(ctxColor(theme, 31), green);
      expect(ctxColor(theme, 31, tokens: 310000, warnAt: 250000, handoffAt: 300000), red);
      expect(ctxColor(theme, 26, tokens: 260000, warnAt: 250000, handoffAt: 300000), kWarnAmber);
    });

    test('no budget (an older server) keeps the % rule exactly', () {
      expect(ctxColor(theme, 49), green);
      expect(ctxColor(theme, 50), kWarnAmber);
      expect(ctxColor(theme, 70), red);
      // Half a budget is no budget.
      expect(ctxColor(theme, 31, tokens: 310000, warnAt: 250000), green);
      expect(ctxColor(theme, 31, warnAt: 250000, handoffAt: 300000), green);
    });

    test('compactionsLabel shows only a real count', () {
      expect(compactionsLabel(3), '↻3');
      expect(compactionsLabel(0), isNull);
      expect(compactionsLabel(null), isNull);
      expect(compactionsTooltip(1), 'Compacted once');
      expect(compactionsTooltip(4), 'Compacted 4 times');
    });
  });

  group('SessionMetrics.fromJson', () {
    test('parses the budget, the occupancy and the compaction count', () {
      final m = SessionMetrics.fromJson({
        'ctx': 31,
        'ctxWindow': 1000000,
        'ctxUsed': 310000,
        'budget': _budgetJson,
        'compactions': 4,
      })!;
      expect(m.ctxUsed, 310000);
      expect(m.budget!.warnAt, 250000);
      expect(m.budget!.handoffAt, 300000);
      expect(m.budget!.compactAt, 367000);
      expect(m.compactions, 4);
      expect(m.tokensAt(31), 310000);
    });

    test('an older server: no fields, no budget', () {
      final m = SessionMetrics.fromJson({'ctx': 31, 'ctxWindow': 1000000})!;
      expect(m.budget, isNull);
      expect(m.ctxUsed, isNull);
      expect(m.compactions, isNull);
    });

    test('a budget that is not ordered or complete is no budget', () {
      expect(ContextBudget.fromJson({'warnAt': 300000, 'handoffAt': 250000, 'compactAt': 367000}), isNull);
      expect(ContextBudget.fromJson({'warnAt': 250000, 'handoffAt': 300000}), isNull);
      expect(ContextBudget.fromJson(null), isNull);
    });
  });

  group('the session card (#393)', () {
    Color? colorOf(WidgetTester tester, String text) =>
        tester.widget<Text>(find.text(text)).style?.color;

    testWidgets('the ctx% is coloured against the budget, with the count', (tester) async {
      final m = SessionMetrics.fromJson({
        'ctx': 31, 'ctxWindow': 1000000, 'ctxUsed': 310000, 'budget': _budgetJson, 'compactions': 3,
      })!;
      await tester.pumpWidget(_wrap(SessionCard(session: _session(m))));
      expect(colorOf(tester, '31%'), red);
      expect(find.text('↻3'), findsOneWidget);
    });

    testWidgets('an older server: the % rule and no count', (tester) async {
      final m = SessionMetrics.fromJson({'ctx': 31, 'ctxWindow': 1000000})!;
      await tester.pumpWidget(_wrap(SessionCard(session: _session(m))));
      expect(colorOf(tester, '31%'), green);
      expect(find.textContaining('↻'), findsNothing);
    });

    testWidgets('a session that never compacted shows no count', (tester) async {
      final m = SessionMetrics.fromJson({
        'ctx': 10, 'ctxWindow': 1000000, 'ctxUsed': 100000, 'budget': _budgetJson, 'compactions': 0,
      })!;
      await tester.pumpWidget(_wrap(SessionCard(session: _session(m))));
      expect(colorOf(tester, '10%'), green);
      expect(find.textContaining('↻'), findsNothing);
    });
  });
}
