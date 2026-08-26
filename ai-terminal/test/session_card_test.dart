// Widget test for SessionCard across the statuses that drive its tint and
// attention chip (spec §2).
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/agent_catalog.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/dashboard_screen.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/attention_chip.dart';
import 'package:ai_terminal/widgets/session_card.dart';
import 'package:ai_terminal/widgets/status_dot.dart';

ServerConfig _server() =>
    const ServerConfig(name: 'Home', baseUrl: 'http://x', bearerToken: 't');

Session _session({
  required String status,
  String name = 'my-project',
  String id = 'abc12345',
  SessionMetrics? metrics,
  String? agent,
  List<String> backgroundTasks = const <String>[],
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
  metrics: metrics,
  agent: agent,
  backgroundTasks: backgroundTasks,
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

  testWidgets('#38: ctx badge shows metrics.ctx% on the list row', (
    tester,
  ) async {
    final session = _session(
      status: 'working',
      metrics: const SessionMetrics(ctx: 80),
    );
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.text('80%'), findsOneWidget);
  });

  testWidgets('#38: no ctx badge when metrics is null', (tester) async {
    final session = _session(status: 'working'); // metrics == null
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.textContaining('%'), findsNothing);
  });

  testWidgets('#38: no ctx badge when metrics present but ctx is null', (
    tester,
  ) async {
    final session = _session(
      status: 'working',
      metrics: const SessionMetrics(fiveH: 30), // ctx null → no badge
    );
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.textContaining('%'), findsNothing);
  });

  testWidgets('agent chip shows the label the SERVER catalogue supplies', (
    tester,
  ) async {
    // The app keeps no table of agents — the label and tint come from
    // GET /api/agents via AgentCatalog. Seeding it here is what a real launch does.
    AgentCatalog.instance.clear();
    AgentCatalog.instance.adopt(
      const AgentInfo(id: 'codex', label: 'Codex', color: '#10a37f'),
    );
    addTearDown(AgentCatalog.instance.clear);

    final session = _session(status: 'idle', agent: 'codex');
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.text('Codex'), findsOneWidget);
  });

  testWidgets('a server-side rename of an agent needs no app release', (
    tester,
  ) async {
    // Same id, a label this build has never hardcoded — it must still render,
    // proving the catalogue (not the app) is the source of truth.
    AgentCatalog.instance.clear();
    AgentCatalog.instance.adopt(
      const AgentInfo(id: 'codex', label: 'OpenAI Codex CLI', color: '#123456'),
    );
    addTearDown(AgentCatalog.instance.clear);

    final session = _session(status: 'idle', agent: 'codex');
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.text('OpenAI Codex CLI'), findsOneWidget);
  });

  testWidgets('agent chip is hidden for a plain shell (agent == null)', (
    tester,
  ) async {
    final session = _session(status: 'idle'); // agent defaults to null
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.text('Codex'), findsNothing);
    expect(find.text('Claude Code'), findsNothing);
  });

  testWidgets('agent chip falls back to the raw id for an unknown agent', (
    tester,
  ) async {
    // An id the catalogue has never seen (server newer than this app, or a
    // fetch that failed) must still chip the row rather than hide the session.
    AgentCatalog.instance.clear();
    addTearDown(AgentCatalog.instance.clear);

    final session = _session(status: 'idle', agent: 'some-future-agent');
    await tester.pumpWidget(_wrap(SessionCard(session: session)));

    expect(find.text('some-future-agent'), findsOneWidget);
  });

  test('parseAgentColor accepts a valid #rrggbb and rejects garbage', () {
    const fallback = Colors.grey;
    expect(parseAgentColor('#10a37f', fallback), const Color(0xFF10A37F));
    expect(parseAgentColor('not-a-color', fallback), fallback);
    expect(parseAgentColor('#12345', fallback), fallback); // too short
    expect(parseAgentColor(null, fallback), fallback);
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

  // A `run_in_background` command outlives the turn that launched it: the agent's
  // turn ends, Stop fires, the dot goes idle-green — and the build is still
  // running. Reported live on Office ("Launch host unit-test gate"). The card must
  // show the work WITHOUT touching the status the dot reports.
  group('background work badge', () {
    testWidgets('an idle session that is still building says so', (tester) async {
      await tester.pumpWidget(_wrap(SessionCard(
        session: _session(
          status: 'idle',
          backgroundTasks: const ['Launch host unit-test gate'],
        ),
      )));
      // The status label is untouched — the agent really is idle.
      expect(find.text('Idle'), findsOneWidget);
      // ...and the work is visible next to it.
      expect(find.text('Launch host unit-test gate'), findsOneWidget);
      expect(find.byIcon(Icons.sync), findsOneWidget);
    });

    testWidgets('several running commands collapse to a count', (tester) async {
      await tester.pumpWidget(_wrap(SessionCard(
        session: _session(
          status: 'idle',
          backgroundTasks: const ['windows build', 'apk build'],
        ),
      )));
      expect(find.text('2 running'), findsOneWidget);
      // A single name would not fit two, so neither is shown on its own.
      expect(find.text('windows build'), findsNothing);
    });

    testWidgets('no background work renders no badge at all', (tester) async {
      await tester.pumpWidget(
        _wrap(SessionCard(session: _session(status: 'idle'))),
      );
      expect(find.byIcon(Icons.sync), findsNothing);
    });
  });

  // #169 — the whole point of a handle is that it is NOT the card's long-press.
  // The first cut of #169 put the handle inside `InkWell(onLongPress:)`, so the
  // card's long-press still owned the handle's own pixels: pressing the handle
  // and HOLDING (which is what #124's idiom trained, and what anyone does when
  // a drag doesn't seem to take) opened the actions sheet and started no drag.
  //
  // These are card-level and behavioural on purpose — no list, no reorder — so
  // they name the defect at its owner. `dragHandle` is built by
  // [buildReorderDragHandle], the app's only handle, so what is exercised here
  // is the shipped widget rather than a stand-in.
  group('#169 — the drag handle is not the card long-press', () {
    Widget cardWithHandle(void Function() onLongPress) => _wrap(
      Builder(
        builder: (context) => SessionCard(
          session: _session(status: 'idle'),
          onTap: () {},
          onLongPress: onLongPress,
          onMoreTap: () {},
          dragHandle: buildReorderDragHandle(context, 0),
        ),
      ),
    );

    testWidgets('holding the handle does NOT open the actions sheet', (
      tester,
    ) async {
      var longPressed = false;
      await tester.pumpWidget(cardWithHandle(() => longPressed = true));

      final press = await tester.startGesture(
        tester.getCenter(find.byIcon(Icons.drag_handle)),
      );
      await tester.pump(kLongPressTimeout + const Duration(milliseconds: 50));
      await press.up();
      await tester.pumpAndSettle();

      expect(
        longPressed,
        isFalse,
        reason: 'the handle must have no long-press armed on its pixels — '
            'holding it is how a drag begins for anyone taught #124 idiom',
      );
    });

    testWidgets('holding the card BODY still opens the actions sheet', (
      tester,
    ) async {
      var longPressed = false;
      await tester.pumpWidget(cardWithHandle(() => longPressed = true));

      await tester.longPress(find.text('my-project'));
      await tester.pumpAndSettle();

      expect(
        longPressed,
        isTrue,
        reason: 'lifting the handle out of the InkWell must not cost the row '
            'its sheet — that trade is what #169 explicitly rules out',
      );
    });

    testWidgets('the handle stays level with the ⋮ button, and the card '
        'keeps its height', (tester) async {
      await tester.pumpWidget(
        _wrap(SessionCard(session: _session(status: 'idle'), onMoreTap: () {})),
      );
      final plainHeight = tester.getRect(find.byType(SessionCard)).height;

      await tester.pumpWidget(cardWithHandle(() {}));
      final withHandle = tester.getRect(find.byType(SessionCard));

      expect(
        tester.getCenter(find.byIcon(Icons.drag_handle)).dy,
        tester.getCenter(find.byIcon(Icons.more_vert)).dy,
        reason: 'the handle hangs outside the title Row now, so its inset is '
            'what keeps it on the same line — see SessionCard.dragHandleInset',
      );
      expect(
        withHandle.height,
        plainHeight,
        reason: 'a 48dp touch target must not make the row taller',
      );
    });

    testWidgets('the handle target is 48dp tall', (tester) async {
      await tester.pumpWidget(cardWithHandle(() {}));
      final target = tester.getRect(
        find.byType(ReorderableDragStartListener),
      );
      expect(target.height, 48);
    });
  });

  // #169 round 3 — the handle OVERLAYS the card, it does not DISPLACE it.
  //
  // Round 2 lifted the handle out of `InkWell(onLongPress:)` (the group above),
  // and that gesture fix is right. But it paid for the strip by shrinking the
  // InkWell: `Row[ Expanded(body), handle ]`. `SessionCard` is shared, so both
  // costs landed on the MAIN LIST too, not just on a pinned favorite:
  //
  //   * the SECOND row never contained the handle, so it simply lost 22dp —
  //     star/bell/timestamp all slid left and the row newly overflowed;
  //   * the 16dp gutter and the handle column below its 48dp strip became
  //     siblings of the InkWell rather than part of it, so ~10% of every
  //     handled row stopped opening the session at all.
  //
  // Both are geometry, so both are pinned by MEASUREMENT here rather than by a
  // comment. The no-handle card is the reference: it is byte-identical to
  // master, which is the geometry a handle must not disturb.
  group('#169 — a handle overlays the card, it does not displace it', () {
    /// Every trailing affordance wired on, so the subtitle row is at its
    /// widest and a lost 22dp cannot hide.
    Widget card({required bool handle}) => _wrap(
      Builder(
        builder: (context) => SessionCard(
          session: _session(status: 'idle'),
          onTap: () {},
          onLongPress: () {},
          onMoreTap: () {},
          onRecapTap: () {},
          onBellTap: () {},
          onToggleFavorite: () {},
          dragHandle: handle ? buildReorderDragHandle(context, 0) : null,
        ),
      ),
    );

    Map<String, Rect> subtitleRects(WidgetTester tester) => {
      'recap': tester.getRect(find.byIcon(Icons.chat_outlined)),
      'bell': tester.getRect(find.byIcon(Icons.notifications_outlined)),
      'star': tester.getRect(find.byIcon(Icons.star_border)),
      'time': tester.getRect(find.text('just now')),
    };

    testWidgets('the SUBTITLE row keeps the geometry it has with no handle', (
      tester,
    ) async {
      await tester.pumpWidget(card(handle: false));
      final plain = subtitleRects(tester);

      await tester.pumpWidget(card(handle: true));
      expect(
        subtitleRects(tester),
        plain,
        reason: 'the handle sits on the TITLE line; the rows under it never '
            'contained it and must not pay for it (#169 regression 1)',
      );
    });

    testWidgets('the InkWell still covers the whole card', (tester) async {
      Finder bodyInk() => find.ancestor(
        of: find.text('my-project'),
        matching: find.byType(InkWell),
      );

      await tester.pumpWidget(card(handle: false));
      final plain = tester.getRect(bodyInk());

      await tester.pumpWidget(card(handle: true));
      expect(
        tester.getRect(bodyInk()),
        plain,
        reason: 'a handled row must stay as tappable as an unhandled one — '
            'only the handle target itself is inert (#169 regression 2)',
      );
    });

    testWidgets('the right gutter and the handle column below the strip still '
        'open the session', (tester) async {
      var taps = 0;
      await tester.pumpWidget(
        _wrap(
          Builder(
            builder: (context) => SessionCard(
              session: _session(status: 'idle'),
              onTap: () => taps++,
              onLongPress: () {},
              onMoreTap: () {},
              onBellTap: () {},
              onToggleFavorite: () {},
              dragHandle: buildReorderDragHandle(context, 0),
            ),
          ),
        ),
      );
      final cardRect = tester.getRect(find.byType(SessionCard));
      final target = tester.getRect(find.byType(ReorderableDragStartListener));

      await tester.tapAt(Offset(target.right + 8, target.center.dy));
      await tester.pump();
      expect(
        taps,
        1,
        reason: 'the 16dp right gutter is not the handle',
      );

      await tester.tapAt(Offset(target.center.dx, cardRect.bottom - 8));
      await tester.pump();
      expect(
        taps,
        2,
        reason: 'below the 48dp strip the handle column is ordinary card',
      );

      // ...and the handle's own target is still inert, which is the half of
      // this that round 2 got right.
      await tester.tapAt(target.center);
      await tester.pump();
      expect(taps, 2, reason: 'the handle itself must not open the session');
    });

    // RTL is not a supported configuration today (nothing in lib/ registers a
    // localizationsDelegate), so this is hygiene rather than a user-facing fix
    // — but `EdgeInsets.only(left:/right:)` is PHYSICAL, and the round-2 shape
    // used it to move the body's right padding onto the handle. In RTL that
    // dropped the padding on the wrong side: content ran flush to the card's
    // right border while the glyph sat ~5dp off its left edge. Master's
    // `EdgeInsets.symmetric(horizontal:)` was direction-neutral, and the strip
    // is now `PositionedDirectional`, so both sides follow text direction again.
    //
    // Asserted as a SYMMETRY between the two directions, so it needs no
    // knowledge of how the card's inset is built up (margin + border + padding).
    testWidgets('RTL puts the strip on the other side and keeps both paddings', (
      tester,
    ) async {
      Future<({double edgeToHandle, double edgeToDot})> run(
        TextDirection dir,
      ) async {
        // Directionality has to sit INSIDE MaterialApp: WidgetsApp installs one
        // of its own from the locale, and it would win over an outer wrapper.
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            home: Directionality(
              textDirection: dir,
              child: Scaffold(
                body: Builder(
                  builder: (context) => SessionCard(
                    session: _session(status: 'idle'),
                    onTap: () {},
                    onLongPress: () {},
                    onMoreTap: () {},
                    onBellTap: () {},
                    onToggleFavorite: () {},
                    dragHandle: buildReorderDragHandle(context, 0),
                  ),
                ),
              ),
            ),
          ),
        );
        final box = tester.getRect(find.byType(SessionCard));
        final target = tester.getRect(find.byType(ReorderableDragStartListener));
        final dot = tester.getRect(find.byType(StatusDot));
        return dir == TextDirection.ltr
            ? (edgeToHandle: box.right - target.right, edgeToDot: dot.left - box.left)
            : (edgeToHandle: target.left - box.left, edgeToDot: box.right - dot.right);
      }

      final ltr = await run(TextDirection.ltr);
      final rtl = await run(TextDirection.rtl);
      expect(
        rtl.edgeToHandle,
        ltr.edgeToHandle,
        reason: 'the handle strip must hang off the TRAILING edge, whichever '
            'side that is (#169 regression 3)',
      );
      expect(
        rtl.edgeToDot,
        ltr.edgeToDot,
        reason: 'the body keeps its full inset on both sides — a physical '
            'EdgeInsets.only drops it on the wrong one in RTL',
      );
    });

    testWidgets('the reserved strip is exactly as wide as the handle', (
      tester,
    ) async {
      await tester.pumpWidget(card(handle: true));
      expect(
        tester.getRect(find.byType(ReorderableDragStartListener)).width,
        SessionCard.dragHandleWidth,
        reason: 'the title row reserves SessionCard.dragHandleWidth; a handle '
            'built to any other width would overlap the ⋮ or leave a gap',
      );
    });
  });
}
