// Issue #137 — the 5-hour wait chip on a session card.
//
// The chip renders the SERVER's derived `usageLimit` and computes nothing itself.
// These tests pin that, and pin the distinction that makes the chip worth having:
// "resumes 14:32" promises something will happen and "on hold" says nothing will,
// so showing the first for a session whose resume was switched off would be the
// badge disagreeing with the timer — the whole thing #137 exists to prevent.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/session_card.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({UsageLimit? limit, String status = 'idle'}) => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: '/home/x',
  status: status,
  claudeSessionId: null,
  lastActivity: DateTime.now().millisecondsSinceEpoch,
  notifyLevel: 'important',
  server: _server(),
  autoCommand: '',
  usageLimit: limit,
);

/// A fixed local wall-clock time, so the expected label is derived the same way
/// the widget derives it rather than hardcoded to one machine's timezone.
int _at(int hour, int minute) {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day, hour, minute).millisecondsSinceEpoch;
}

Widget _wrap(Widget child) =>
    MaterialApp(theme: AppTheme.dark, home: Scaffold(body: child));

void main() {
  testWidgets('a capped, armed session shows the resume clock time', (tester) async {
    await tester.pumpWidget(_wrap(SessionCard(
      session: _session(
        limit: UsageLimit(waiting: true, armed: true, resumeAt: _at(14, 32)),
      ),
    )));

    expect(find.text('resumes 14:32'), findsOneWidget);
  });

  testWidgets('a capped session with auto-resume OFF says "on hold", never "resumes"',
      (tester) async {
    await tester.pumpWidget(_wrap(SessionCard(
      session: _session(
        limit: UsageLimit(
          waiting: true, armed: false, enabled: false, resumeAt: _at(14, 32),
        ),
      ),
    )));

    expect(find.text('on hold'), findsOneWidget);
    // Nothing is scheduled for this session, so the card must not imply one is.
    expect(find.textContaining('resumes'), findsNothing);
  });

  testWidgets('capped with NO known reset time says "on hold", never "resumes"',
      (tester) async {
    // Reachable: the worker can SEE the cap prompt before any resets_at has been
    // read. The row must still show the session is held — but it must NOT promise a
    // resume, because without a reset time no timer can be armed for it.
    await tester.pumpWidget(_wrap(SessionCard(
      session: _session(limit: const UsageLimit(waiting: true, armed: false)),
    )));

    expect(find.text('on hold'), findsOneWidget);
    expect(find.textContaining('resumes'), findsNothing);
  });

  testWidgets('an uncapped session renders no chip at all', (tester) async {
    await tester.pumpWidget(_wrap(SessionCard(
      session: _session(limit: const UsageLimit(waiting: false)),
    )));

    expect(find.textContaining('resumes'), findsNothing);
    expect(find.text('on hold'), findsNothing);
  });

  testWidgets('a server too old to send usageLimit renders no chip', (tester) async {
    // Session.usageLimit is null in that case — absence must render nothing rather
    // than defaulting to a state.
    await tester.pumpWidget(_wrap(SessionCard(session: _session())));

    expect(find.textContaining('resumes'), findsNothing);
    expect(find.text('on hold'), findsNothing);
  });

  testWidgets('tapping the chip fires the auto-resume callback', (tester) async {
    var taps = 0;
    await tester.pumpWidget(_wrap(SessionCard(
      session: _session(
        limit: UsageLimit(waiting: true, armed: true, resumeAt: _at(9, 5)),
      ),
      onAutoResumeTap: () => taps++,
    )));

    await tester.tap(find.text('resumes 09:05'));
    await tester.pump();
    expect(taps, 1);
  });
}
