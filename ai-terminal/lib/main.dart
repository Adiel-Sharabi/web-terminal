// App entry point. Firebase + push bring-up mirrors where the Phase 1 spike
// (former `SpikeApp`) did it, but delegates the actual work to
// `PushService` — see `lib/services/push_service.dart`.
import 'dart:async';
import 'dart:io' show Platform;

import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'screens/adaptive_home.dart';
import 'screens/session_screen.dart';
import 'services/desktop_alert_service.dart';
import 'services/detach_window_service.dart';
import 'services/notification_service.dart';
import 'services/push_service.dart';
import 'services/server_store.dart';
import 'services/cluster_discovery.dart';
import 'services/session_repository.dart';
import 'services/session_selection.dart';
import 'theme/app_theme.dart';

/// Lets the notification-tap listener navigate without a `BuildContext`.
final navigatorKey = GlobalKey<NavigatorState>();

/// The route name a notification-opened [SessionScreen] is pushed under, so a
/// later tap can find an already-open copy and collapse the stack onto it
/// (issue #45).
String sessionRouteName(String sessionId) => 'session/$sessionId';

/// Models what a notification tap does to the navigation stack (issue #45):
/// opening a session from a notification must leave exactly one screen above
/// the list, so a single Back press returns to the list every time.
///
/// [stack] is the current route names, bottom→top (index 0 is the session
/// list). Returns the resulting stack: session screens stacked above the list
/// are collapsed — popped down to the list, or to an already-open copy of the
/// [target] (whose live state we keep rather than rebuild) — and [target] ends
/// up as the single screen on top. Re-tapping the same or another notification
/// never piles up duplicate screens (Back had to be pressed 3×). Pure mirror of
/// the `Navigator.popUntil` + dedup in [_AiTerminalAppState._openSession].
List<String> resolveNotificationStack(List<String> stack, String target) {
  if (stack.isEmpty) return [target];
  final result = List<String>.from(stack);
  // popUntil stops at the first route (from the top) that is the list or an
  // existing copy of the target.
  while (result.length > 1 && result.last != target) {
    result.removeLast();
  }
  if (result.last != target) result.add(target);
  return result;
}

/// What a notification tap should DO with the navigation stack (issue #76).
///
/// On a wide window the app's normal shape is a master-detail split, where a
/// session is opened by SELECTING it — so pushing a route covers the very
/// layout the user is in and forces a Back press to get the list back. On a
/// narrow window there is no split to select into and the push is correct,
/// which is exactly what #45 specified and verified.
///
/// Pure so the rule can be tested without a navigator: the *decision* is the
/// part that was wrong, and it was wrong because nothing ever consulted the
/// breakpoint. Mirrors [_AiTerminalAppState._openSession].
enum NotificationOpen {
  /// Set the shared selection and reveal the split (no route is pushed).
  selectInSplit,

  /// Push one screen above the list, per #45.
  pushRoute,
}

NotificationOpen planNotificationOpen({required bool splitCanSelect}) =>
    splitCanSelect ? NotificationOpen.selectInSplit : NotificationOpen.pushRoute;

/// FCM push + local notifications are mobile-only (firebase_messaging has no
/// desktop support). On Windows/macOS/Linux the app is a full terminal client
/// minus background push — everything else works.
bool get pushSupported => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  // A `--session <baseUrl> <id>` launch is a detached single-session window
  // (issue #14); a normal launch shows the dashboard.
  final detached = DetachWindow.parseArgs(args);
  if (pushSupported) {
    await Firebase.initializeApp();
    await PushService.init();
  }
  // Pre-warm the server store so the dashboard's server list is already
  // loaded on the first frame. The pinned Favorites group needs no local
  // pre-warm (#60): favorite/favoriteRank ride on Session itself, straight
  // from the server — DashboardScreen's own migrateOnce handles the old
  // per-device list, if any.
  await ServerStore.instance.init();
  // #97: adopt any peer the cluster advertises that this device does not have
  // yet. Deliberately NOT awaited — it makes network calls, and a slow or
  // unreachable server must never delay the first frame. The store emits when
  // the list changes, so the dashboard picks up new servers as they arrive.
  // Safe to fire and forget: a round that reaches nothing changes nothing.
  unawaited(ClusterDiscovery(store: ServerStore.instance).refresh());
  runApp(AiTerminalApp(detached: detached));
}

class AiTerminalApp extends StatefulWidget {
  const AiTerminalApp({super.key, this.detached});

  /// Non-null when this instance was launched as a detached window for one
  /// session (issue #14) — the app opens straight into that [SessionScreen]
  /// instead of the dashboard.
  final DetachedTarget? detached;

  @override
  State<AiTerminalApp> createState() => _AiTerminalAppState();
}

class _AiTerminalAppState extends State<AiTerminalApp>
    with WidgetsBindingObserver {
  StreamSubscription<String>? _tapSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    SessionRepository.instance.startForeground();
    if (pushSupported) {
      _tapSub = NotificationService.onNotificationTap.listen(_openSession);
      // Foreground/background taps arrive on the stream above; a tap that
      // cold-started the app (process was killed) is only recoverable via this
      // one-shot launch-details check.
      NotificationService.initialTapSessionId().then((id) {
        if (id != null) _openSession(id);
      });
    } else if (DesktopAlertService.supported && widget.detached == null) {
      // Desktop has no FCM (issue #16): raise OS toasts locally from the live
      // session stream, and route a toast tap to open that session. A detached
      // single-session window (issue #14) skips this — only the main window
      // owns alerting, so events aren't toasted once per open window.
      unawaited(DesktopAlertService.instance.start());
      _tapSub = NotificationService.onNotificationTap.listen(_openSession);
      // Issue #20: a toast clicked while the app was CLOSED cold-launches it.
      // The foreground stream above only covers taps while running; the
      // cold-launch payload is recoverable only via this one-shot launch-details
      // check — the desktop branch was missing it, so a closed-app toast click
      // opened the app but routed nowhere.
      NotificationService.initialTapSessionId().then((id) {
        if (id != null) _openSession(id);
      });
    }
  }

  void _openSession(String sessionId) {
    final nav = navigatorKey.currentState;
    if (nav == null) return;

    // #76: on a wide window, open the session the way the app normally does —
    // by selecting it in the split — instead of pushing a full-screen route
    // over the layout. Both paths now agree on one answer to "which session is
    // showing" (SessionSelection), rather than each having its own.
    if (planNotificationOpen(splitCanSelect: SessionSelection.instance.splitMounted) ==
        NotificationOpen.selectInSplit) {
      // Reveal the split: a route pushed while the window was narrow, or by
      // Fork / the list, would otherwise still be covering it.
      nav.popUntil((route) => route.isFirst);
      SessionSelection.instance.selectedId.value = sessionId;
      return;
    }

    final name = sessionRouteName(sessionId);
    // Collapse any stacked session screens so a notification tap lands exactly
    // one screen above the list (issue #45: Back had to be pressed 3×). popUntil
    // stops at the list (first route) or an already-open copy of this session,
    // so repeat taps — and the cold-start + foreground double-fire for one
    // notification — can never push a duplicate. See resolveNotificationStack.
    var alreadyOpen = false;
    nav.popUntil((route) {
      if (route.settings.name == name) alreadyOpen = true;
      return route.isFirst || route.settings.name == name;
    });
    if (!alreadyOpen) {
      nav.push(MaterialPageRoute(
        settings: RouteSettings(name: name),
        builder: (_) => SessionScreen(sessionId: sessionId),
      ));
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        SessionRepository.instance.startForeground();
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        SessionRepository.instance.stopForeground();
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        break;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tapSub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AiTerminal',
      debugShowCheckedModeBanner: false,
      navigatorKey: navigatorKey,
      theme: AppTheme.dark,
      darkTheme: AppTheme.dark,
      themeMode: ThemeMode.dark,
      home: widget.detached == null
          ? const AdaptiveHome()
          : SessionScreen(
              sessionId: widget.detached!.sessionId,
              standalone: true,
            ),
    );
  }
}
