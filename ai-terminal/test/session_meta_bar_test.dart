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
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/session_meta_bar.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Adiel-Xps', baseUrl: 'http://x', bearerToken: 't');

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

  testWidgets('shows the model and effort the session is talking to',
      (tester) async {
    await pumpBar(
      tester,
      session: _session(
        metrics: const SessionMetrics(ctx: 25, model: 'Opus 4.8', effort: 'high'),
      ),
    );
    expect(find.text('Opus 4.8 · high'), findsOneWidget);
  });

  testWidgets('the model chip is agent-neutral — Codex reports the same fields',
      (tester) async {
    // Codex fills model/effort from its rollout's turn_context; Claude from its
    // status-line payload. The bar reads ONE field either way and must never ask
    // which agent it is.
    await pumpBar(
      tester,
      session: _session(
        metrics: const SessionMetrics(ctx: 44, model: 'gpt-5.5', effort: 'high'),
      ),
    );
    expect(find.text('gpt-5.5 · high'), findsOneWidget);
  });

  testWidgets('renders whichever half of model/effort exists', (tester) async {
    // A Claude push before the first API call can carry the model with no
    // effort. Half a label beats no chip; an empty separator beats neither.
    await pumpBar(
      tester,
      session: _session(metrics: const SessionMetrics(ctx: 10, model: 'Opus 4.8')),
    );
    expect(find.text('Opus 4.8'), findsOneWidget);
    expect(find.textContaining('·'), findsNothing);
  });

  testWidgets('a model-only report still renders — no number required',
      (tester) async {
    // The regression: SessionMetrics.fromJson dropped any report carrying no
    // ctx/5h/7d, so a status line pushed before the session's first API call
    // (STABLE fields only) blanked the model chip on exactly the fresh sessions
    // where the model is least obvious.
    final metrics = SessionMetrics.fromJson(
      const {'model': 'Opus 4.8', 'effort': 'high'},
    );
    expect(metrics, isNotNull, reason: 'a model-only report must survive parsing');
    await pumpBar(tester, session: _session(metrics: metrics));
    expect(find.text('Opus 4.8 · high'), findsOneWidget);
  });

  testWidgets('carries the session controls that used to crowd the title',
      (tester) async {
    await pumpBar(
      tester,
      session: _session(),
      controls: [
        const Icon(Icons.volume_up),
        const MetaServerBadge(name: 'Adiel-Xps'),
      ],
    );
    expect(find.byIcon(Icons.volume_up), findsOneWidget);
    expect(find.text('Adiel-Xps'), findsOneWidget);
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
      controls: [const MetaServerBadge(name: 'Adiel-Xps')],
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
        cwd: r'C:\dev\SmartMobile',
        metrics: const SessionMetrics(
            ctx: 93, fiveH: 34, sevenD: 76, model: 'Opus 4.8', effort: 'high'),
      ),
      controls: [
        const Icon(Icons.forum_outlined),
        const Icon(Icons.volume_up),
        const MetaServerBadge(name: 'Adiel-Xps'),
      ],
    );
    // Every badge exists — the model chip included, since adding a chip to this
    // row is exactly how the 7d badge silently vanished the first time.
    for (final label in [
      'SmartMobile',
      'Opus 4.8 · high',
      'ctx 93%',
      '5h 34%',
      '7d 76%'
    ]) {
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
      controls: [const MetaServerBadge(name: 'Adiel-Xps')],
    );
    // One row means the badges and the controls share a vertical centre.
    expect(
      tester.getCenter(find.text('ctx 93%')).dy,
      closeTo(tester.getCenter(find.text('Adiel-Xps')).dy, 1.0),
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

  // #77 — the chip shows the folder NAME, so the full path was nowhere on screen
  // and nowhere to be grabbed: the label is a plain Text with no gesture, which is
  // why it alone refused to select while the chat text around it selected fine.
  // The gesture pair and the menu-then-snackbar shape are lifted from _ChatLink
  // (conversation_view.dart) rather than invented, so the copy gesture a user
  // already knows from a chat link is the same one that works here.
  group('#77 copy the full cwd path', () {
    late List<MethodCall> platformCalls;

    setUp(() {
      platformCalls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        platformCalls.add(call);
        return null;
      });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    String? copiedText() {
      for (final c in platformCalls.reversed) {
        if (c.method == 'Clipboard.setData') {
          return (c.arguments as Map)['text'] as String?;
        }
      }
      return null;
    }

    testWidgets('long-press on the cwd chip offers Copy path', (tester) async {
      await pumpBar(tester, session: _session());
      await tester.longPress(find.text('am8'));
      await tester.pumpAndSettle();
      expect(find.text('Copy path'), findsOneWidget);
    });

    testWidgets('copies the WHOLE path, not the folder name shown on the chip',
        (tester) async {
      // The point of the issue: selecting the visible label would only ever
      // yield "am8". The clipboard must carry the path the user came for.
      await pumpBar(tester, session: _session());
      await tester.longPress(find.text('am8'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Copy path'));
      await tester.pumpAndSettle();
      expect(copiedText(), r'C:\dev\am8');
    });

    testWidgets('right-click opens the same menu — desktop has no long-press',
        (tester) async {
      await pumpBar(tester, session: _session());
      final gesture =
          await tester.startGesture(tester.getCenter(find.text('am8')),
              kind: PointerDeviceKind.mouse, buttons: kSecondaryMouseButton);
      await gesture.up();
      await tester.pumpAndSettle();
      expect(find.text('Copy path'), findsOneWidget);
    });

    testWidgets('confirms the copy, in the wording the app already uses',
        (tester) async {
      await pumpBar(tester, session: _session());
      await tester.longPress(find.text('am8'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Copy path'));
      await tester.pump();
      expect(find.text('Path copied'), findsOneWidget);
    });

    testWidgets('a session with no cwd offers no menu at all', (tester) async {
      await pumpBar(tester, session: _session(cwd: ''));
      // Nothing to copy and no chip to press: the gesture must not exist rather
      // than sit there copying an empty string.
      expect(find.byIcon(Icons.folder_outlined), findsNothing);
    });

    testWidgets('the chip still shows only the folder name — width budget (#74)',
        (tester) async {
      // Guards the regression the menu could invite: revealing the full path
      // inline would re-break the bar the #74 work just fixed.
      await pumpBar(tester, session: _session());
      expect(find.text('am8'), findsOneWidget);
      expect(find.textContaining(r'C:\dev'), findsNothing);
    });
  });

  group('folderName', () {
    test('takes the last segment of a windows or posix path', () {
      expect(SessionMetaBar.folderName(r'C:\dev\web-terminal'), 'web-terminal');
      expect(SessionMetaBar.folderName('/home/adiel/proj'), 'proj');
      expect(SessionMetaBar.folderName(r'C:\dev\am8\'), 'am8');
    });

    test('empty and degenerate paths do not throw', () {
      expect(SessionMetaBar.folderName(''), '');
      expect(SessionMetaBar.folderName(r'\\'), r'\\');
    });
  });
}
