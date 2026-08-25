// A session that leaves the list must be announced ONCE and then left behind.
//
// Regression: the "Session no longer active." branch announced itself and called
// `Navigator.maybePop()` unconditionally. On the desktop split the screen is a
// CHILD of AdaptiveHome, not a pushed route, so `maybePop` on the root route is
// a silent no-op — nothing left, `_session` stayed set, and the very next
// sessions emission (the 30s poll, or ANY /ws/notify frame) ran the same branch
// again. Reported from the office Windows app as a status line that kept
// jumping.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';
import 'package:ai_terminal/services/session_repository.dart';
import 'package:ai_terminal/services/session_selection.dart';

// A NUMERIC-IP, dead-port server: the screen attaches on mount, and a
// hostname would leave dart:io's staggered DNS-lookup timer pending in the
// fake-async zone (the test then fails on the pending-timer invariant, not on
// anything this spec is about). A literal IP does no lookup.
const _server = ServerConfig(
  name: 'Office',
  baseUrl: 'http://127.0.0.1:1',
  bearerToken: 't',
);

Session _session() => Session(
  id: 'sess-1',
  name: 'my-project',
  cwd: r'C:\dev\my-project',
  status: 'idle',
  claudeSessionId: null,
  lastActivity: 0,
  notifyLevel: 'important',
  server: _server,
  autoCommand: '',
);

Widget _screen({bool embedded = false, bool standalone = false}) => MaterialApp(
  home: SessionScreen(
    sessionId: 'sess-1',
    initialSession: _session(),
    embedded: embedded,
    standalone: standalone,
  ),
);

const _gone = 'Session no longer active.';

ScaffoldMessengerState _messenger(WidgetTester tester) =>
    tester.state<ScaffoldMessengerState>(find.byType(ScaffoldMessenger));

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    SessionSelection.instance.reset();
  });
  tearDown(() => SessionSelection.instance.reset());

  group('sessionExitFor', () {
    test('a pushed route pops itself', () {
      expect(
        sessionExitFor(embedded: false, standalone: false),
        SessionExit.popRoute,
      );
    });

    test('the split pane clears the selection — it has no route to pop', () {
      expect(
        sessionExitFor(embedded: true, standalone: false),
        SessionExit.clearSelection,
      );
    });

    test('a detached window stays — it IS the root', () {
      expect(
        sessionExitFor(embedded: false, standalone: true),
        SessionExit.stay,
      );
    });
  });

  testWidgets('the split pane announces it ONCE and clears the selection', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    SessionSelection.instance.selectedId.value = 'sess-1';

    await tester.pumpWidget(_screen(embedded: true));
    await tester.pump();

    // No servers configured, so refresh() emits an empty merged list — i.e.
    // "this session is not in the list any more".
    await SessionRepository.instance.refresh();
    await tester.pump();
    expect(find.text(_gone), findsOneWidget);
    expect(
      SessionSelection.instance.selectedId.value,
      isNull,
      reason: 'the pane it lives in is told to close',
    );
    expect(find.text('That session is no longer active.'), findsOneWidget);

    // Dismiss it by hand and look behind it: a snackbar queue is invisible
    // (only one shows at a time), so "did it announce twice" cannot be read off
    // the screen — what is QUEUED is what tells you.
    _messenger(tester).removeCurrentSnackBar();
    await tester.pump();
    expect(find.text(_gone), findsNothing, reason: 'nothing queued behind it');

    // THE BUG: every later emission re-announced it, forever — a 30s poll and
    // every /ws/notify frame, over a pane that never left.
    await SessionRepository.instance.refresh();
    await tester.pump();
    expect(find.text(_gone), findsNothing);
    await SessionRepository.instance.refresh();
    await tester.pump();
    expect(find.text(_gone), findsNothing);

    await tester.pumpWidget(const SizedBox()); // dispose → cancel timers
    await tester.pump();
  });

  testWidgets('a detached window reports it without a dead Back button', (
    tester,
  ) async {
    await tester.pumpWidget(_screen(standalone: true));
    await tester.pump();

    await SessionRepository.instance.refresh();
    await tester.pump();
    expect(find.text(_gone), findsOneWidget);
    expect(find.text('That session is no longer active.'), findsOneWidget);
    expect(
      find.text('Back to sessions'),
      findsNothing,
      reason: 'there is nowhere to go back to in a single-session window',
    );

    await tester.pump(const Duration(seconds: 10)); // outlive the snackbar
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });

  // The two guards below are about WHICH thing leaves. Both were wrong in ways
  // the one-shot fix above cannot see: it makes the branch run once, not run on
  // the right target.

  testWidgets('a dead pane does not clear a selection the user has moved on', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    // The rail sets selectedId synchronously; this pane is disposed, and its
    // subscription cancelled, only on the NEXT build. So an emission delivered
    // in that gap reaches a still-mounted pane whose session is gone — while
    // the selection already belongs to the row the user just clicked. This
    // session vanishing is exactly the moment they click another row.
    SessionSelection.instance.selectedId.value = 'sess-2';

    await tester.pumpWidget(_screen(embedded: true));
    await tester.pump();

    await SessionRepository.instance.refresh();
    await tester.pump();

    expect(
      SessionSelection.instance.selectedId.value,
      'sess-2',
      reason: 'clearing a selection that is not ours drops the user on the empty state',
    );

    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });

  testWidgets('a pushed screen under a fork pops nothing', (tester) async {
    final nav = GlobalKey<NavigatorState>();
    final popped = <Route<dynamic>>[];
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        navigatorObservers: [_PopSpy(popped)],
        home: const Scaffold(body: Text('list')),
      ),
    );

    nav.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) =>
            SessionScreen(sessionId: 'sess-1', initialSession: _session()),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // Forking pushes a CHILD SessionScreen over this one, and killing the
    // parent is a common reason to have forked. The parent stays mounted
    // underneath with its subscription live, so it still runs the gone branch.
    nav.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('fork')),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    popped.clear();

    await SessionRepository.instance.refresh();
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));

    expect(
      popped,
      isEmpty,
      reason: 'an unguarded maybePop() pops the NEWEST route - the fork',
    );
    expect(find.text('fork'), findsOneWidget);
    // The branch really did run - otherwise the pop assertion above proves
    // nothing at all. The toast is deliberately NOT gated on visibility: see
    // _onSessionGone, where gating it left a dead session silently selected
    // whenever any dialog happened to be open.
    expect(find.text(_gone), findsOneWidget, reason: 'the gone branch ran');

    // And the screen behind is already in its gone state when they return.
    nav.currentState!.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('That session is no longer active.'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });

}

class _PopSpy extends NavigatorObserver {
  _PopSpy(this.popped);
  final List<Route<dynamic>> popped;
  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      popped.add(route);
}
