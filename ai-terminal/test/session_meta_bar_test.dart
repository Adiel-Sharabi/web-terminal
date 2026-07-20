// #74 — the session meta bar.
//
// The bug was that the session title collapsed to "● Lo…" on a phone. The cause
// was structural: `AppBar` lays `actions` out at their intrinsic width FIRST and
// gives the title the leftover, so the title was the only flexible child and
// absorbed every control's shortfall. Raising a pixel floor only rationed the
// shortage; moving the controls OFF the app bar removes it.
//
// So what these tests pin is the new arrangement, not a pixel budget:
//   * the bar renders the session's cwd and usage badges,
//   * it carries the session controls that used to crowd the title,
//   * the FLEXIBLE child is the cwd side — the thing that can shrink harmlessly,
//   * and it renders for a terminal-lens session too, which the old chat-only
//     placement never did.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/session_meta_bar.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Server-C', baseUrl: 'http://x', bearerToken: 't');

Session _session({SessionMetrics? metrics, String cwd = r'C:\dev\am8'}) =>
    Session(
      id: 'sess-1',
      name: 'Alarm zone - sensor',
      cwd: cwd,
      status: 'idle',
      claudeSessionId: null,
      lastActivity: DateTime.now().millisecondsSinceEpoch,
      notifyLevel: 'important',
      server: _server(),
      autoCommand: '',
      metrics: metrics,
    );

Future<void> pumpBar(
  WidgetTester tester, {
  required Session session,
  int? derivedCtx,
  List<Widget> controls = const <Widget>[],
  double width = 360,
}) async {
  tester.view.physicalSize = Size(width, 200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: SessionMetaBar(
          session: session,
          derivedCtx: derivedCtx,
          controls: controls,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('shows the cwd folder name, not the whole path', (tester) async {
    await pumpBar(tester, session: _session());
    expect(find.text('am8'), findsOneWidget);
    expect(find.textContaining(r'C:\dev'), findsNothing);
  });

  testWidgets('shows the live ctx% when the status line is posting',
      (tester) async {
    await pumpBar(
      tester,
      session: _session(metrics: const SessionMetrics(ctx: 25)),
    );
    expect(find.text('ctx 25%'), findsOneWidget);
  });

  testWidgets('falls back to the transcript estimate, marked with a ~',
      (tester) async {
    // The estimate is computed by the CHAT lens and lifted up to this bar. It
    // must stay distinguishable from a real reading.
    await pumpBar(tester, session: _session(), derivedCtx: 41);
    expect(find.text('ctx ~41%'), findsOneWidget);
  });

  testWidgets('a live reading wins over the estimate', (tester) async {
    await pumpBar(
      tester,
      session: _session(metrics: const SessionMetrics(ctx: 25)),
      derivedCtx: 41,
    );
    expect(find.text('ctx 25%'), findsOneWidget);
    expect(find.text('ctx ~41%'), findsNothing);
  });

  testWidgets('carries the session controls that used to crowd the title',
      (tester) async {
    await pumpBar(
      tester,
      session: _session(),
      controls: [
        const Icon(Icons.volume_up),
        const MetaServerBadge(name: 'Server-C'),
      ],
    );
    expect(find.byIcon(Icons.volume_up), findsOneWidget);
    expect(find.text('Server-C'), findsOneWidget);
  });

  testWidgets('the cwd side is the flexible child — controls are not',
      (tester) async {
    // This is the whole fix in one assertion: whatever yields under pressure, it
    // is the cwd/badges side. Nothing in this bar can steal from the title,
    // because the title is no longer in the same row.
    await pumpBar(
      tester,
      width: 1200, // single-row mode, where the Expanded exists
      session: _session(),
      controls: [const MetaServerBadge(name: 'Server-C')],
    );
    final expanded = tester.widget<Expanded>(
      find.descendant(
        of: find.byType(SessionMetaBar),
        matching: find.byType(Expanded),
      ),
    );
    expect(
      find.descendant(
        of: find.byWidget(expanded),
        matching: find.text('am8'),
      ),
      findsOneWidget,
      reason: 'the cwd must sit inside the Expanded, not the controls',
    );
  });

  testWidgets('at phone width EVERY badge is visible, not scrolled out of sight',
      (tester) async {
    // The regression this replaces: chips and controls shared one row, so the
    // horizontal scroll view silently swallowed the trailing badges — 7d
    // vanished and 5h was clipped mid-number, with nothing on screen to say so.
    // Presence in the tree is not enough; assert the painted position is inside
    // the viewport.
    await pumpBar(
      tester,
      width: 360,
      session: _session(
        cwd: r'C:\dev\MobileClient',
        metrics: const SessionMetrics(ctx: 93, fiveH: 34, sevenD: 76),
      ),
      controls: [
        const Icon(Icons.forum_outlined),
        const Icon(Icons.volume_up),
        const MetaServerBadge(name: 'Server-C'),
      ],
    );
    // Every badge exists...
    for (final label in ['MobileClient', 'ctx 93%', '5h 34%', '7d 76%']) {
      expect(find.text(label), findsOneWidget, reason: '$label missing');
    }
    // ...and the controls are on their OWN row, so none of the badges is
    // competing with them for horizontal space.
    //
    // Asserted structurally, not in pixels: Flutter's test font draws every
    // glyph as a full em square, so measured text is far wider here than on a
    // real device (the chips measure ~449px in-test versus ~137dp on an S25).
    // A pixel assertion would encode the test font, not the layout. Whether the
    // numbers are legible in the end is a device check — which is exactly what
    // the issue says a widget test cannot do.
    final chipsY = tester.getCenter(find.text('ctx 93%')).dy;
    final controlsY = tester.getCenter(find.byIcon(Icons.volume_up)).dy;
    expect(controlsY, greaterThan(chipsY),
        reason: 'at phone width the controls must drop to their own row');
  });

  testWidgets('wide screens keep badges and controls on one row',
      (tester) async {
    await pumpBar(
      tester,
      width: 1200,
      session: _session(metrics: const SessionMetrics(ctx: 93, fiveH: 34)),
      controls: [const MetaServerBadge(name: 'Server-C')],
    );
    // One row means the badges and the controls share a vertical centre.
    expect(
      tester.getCenter(find.text('ctx 93%')).dy,
      closeTo(tester.getCenter(find.text('Server-C')).dy, 1.0),
    );
  });

  testWidgets('collapses entirely when there is nothing to show',
      (tester) async {
    await pumpBar(tester, session: _session(cwd: ''));
    expect(find.byType(SizedBox), findsWidgets);
    expect(find.text('am8'), findsNothing);
  });

  testWidgets('renders for a session with no metrics at all', (tester) async {
    // A terminal-lens / plain shell session still gets its cwd — it showed
    // nothing at all while these chips lived inside the chat lens.
    await pumpBar(tester, session: _session());
    expect(find.text('am8'), findsOneWidget);
  });

  group('folderName', () {
    test('takes the last segment of a windows or posix path', () {
      expect(SessionMetaBar.folderName(r'C:\dev\web-terminal'), 'web-terminal');
      expect(SessionMetaBar.folderName('/home/user/proj'), 'proj');
      expect(SessionMetaBar.folderName(r'C:\dev\am8\'), 'am8');
    });

    test('empty and degenerate paths do not throw', () {
      expect(SessionMetaBar.folderName(''), '');
      expect(SessionMetaBar.folderName(r'\\'), r'\\');
    });
  });
}
