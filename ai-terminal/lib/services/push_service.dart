/// Firebase Cloud Messaging wiring: permission, token registration and the
/// data-only background handler that renders notifications with the app killed.
///
/// Push messages are content-free wake-ups. In the **foreground** an incoming
/// message just triggers an in-app refresh (no notification). In the
/// **background/killed** state, [firebaseMessagingBackgroundHandler] runs in a
/// separate isolate and must self-initialize Firebase + notifications and post
/// a visible notification — this is the app's critical delivery path.
library;

import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import '../api/api_client.dart';
import 'app_config.dart';
import 'notification_service.dart';
import 'session_repository.dart';

/// Top-level FCM background handler. Runs in its own isolate when a data
/// message arrives while the app is backgrounded or killed; self-initializes
/// Firebase + [NotificationService] and renders the notification.
///
/// Register it from `main()` before `runApp` via
/// `FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler)`,
/// or rely on [PushService.init] which registers it defensively.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();
  await NotificationService.init();
  await NotificationService.showFromPush(_stringData(message.data));
}

/// Owns FCM setup and device registration for the running app.
class PushService {
  PushService._();

  static bool _initialized = false;

  /// Requests notification permission, registers the FCM token with every
  /// configured server, and wires token-refresh + foreground handlers.
  /// Idempotent.
  ///
  /// Assumes `Firebase.initializeApp()` has already run in `main()`.
  static Future<void> init() async {
    if (_initialized) return;
    _initialized = true;

    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    await NotificationService.init();

    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission();

    final token = await messaging.getToken();
    if (token != null) await registerOnAllServers(token);

    messaging.onTokenRefresh.listen((t) {
      unawaited(registerOnAllServers(t));
    });

    // Foreground messages: refresh the in-app list; the OS notification is
    // rendered only from the background handler (avoid double-notifying).
    FirebaseMessaging.onMessage.listen((_) {
      unawaited(SessionRepository.instance.refresh());
    });
  }

  /// Registers [token] with `POST /api/push/devices` on every configured
  /// server, tolerating (and skipping) any server that is unreachable.
  static Future<void> registerOnAllServers(String token) async {
    await Future.wait(AppConfig.servers.map((server) async {
      final client = ApiClient(server);
      try {
        await client.registerDevice(token, deviceName: 'S25');
      } catch (_) {
        // A server may be offline at registration time; a later call covers it.
      } finally {
        client.close();
      }
    }));
  }
}

/// Coerces an FCM `data` map (values arrive as strings on the wire, but the
/// type is `Map<String, dynamic>`) to `Map<String, String>`.
Map<String, String> _stringData(Map<String, dynamic> data) =>
    data.map((k, v) => MapEntry(k, v?.toString() ?? ''));
