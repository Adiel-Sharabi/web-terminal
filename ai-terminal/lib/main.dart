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
import 'services/session_repository.dart';
import 'services/favorites_service.dart';
import 'theme/app_theme.dart';

/// Lets the notification-tap listener navigate without a `BuildContext`.
final navigatorKey = GlobalKey<NavigatorState>();

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
  // Pre-warm the favorites and server stores so the dashboard's pinned group
  // and server list are already loaded on the first frame.
  await FavoritesService.instance.init();
  await ServerStore.instance.init();
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
    navigatorKey.currentState?.push(
      MaterialPageRoute(builder: (_) => SessionScreen(sessionId: sessionId)),
    );
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
