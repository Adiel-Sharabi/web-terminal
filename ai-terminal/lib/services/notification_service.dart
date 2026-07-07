/// Renders the app's own notifications from content-free FCM wake-ups.
///
/// FCM messages are data-only; this service turns a `{kind, sessionId,
/// serverName}` payload into a visible, channeled notification whose body is
/// built from a locally-cached session name (never from the push itself). It
/// also owns the SharedPreferences session-name cache that
/// [showFromPush] reads and [SessionRepository] writes.
///
/// The critical path is [showFromPush] running in the FCM **background
/// isolate** with the app killed: it must be self-sufficient (its own
/// [init]) and never throw.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' show Color;

import 'package:flutter/foundation.dart' show visibleForTesting;

import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Top-level background handler for notification taps that arrive while the app
/// is killed. Routing is the UI layer's job (via
/// [NotificationService.initialTapSessionId]); this exists only so the plugin
/// has a valid background entry-point.
@pragma('vm:entry-point')
void notificationTapBackground(NotificationResponse response) {
  // Intentionally minimal — the launch payload is read on next app start.
}

/// Creates channels and renders notifications from FCM payloads.
class NotificationService {
  NotificationService._();

  static final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();
  static final StreamController<String> _tapController =
      StreamController<String>.broadcast();
  static bool _initialized = false;

  /// SharedPreferences key holding the JSON session-name cache map.
  static const String nameCachePrefKey = 'wt_session_names';

  /// Approval channel id (importance MAX, long vibration).
  static const String channelApproval = 'wt_approval';

  /// API-error channel id (importance HIGH).
  static const String channelApiError = 'wt_api_error';

  /// Idle/updates channel id (importance LOW, silent).
  static const String channelIdle = 'wt_idle';

  /// Emits the `sessionId` of a tapped notification (foreground taps). Cold-start
  /// taps are read via [initialTapSessionId].
  static Stream<String> get onNotificationTap => _tapController.stream;

  /// Initializes the plugin and creates the notification channels. Idempotent
  /// and safe to call from the background isolate.
  static Future<void> init() async {
    if (_initialized) return;
    _initialized = true;
    const androidInit =
        AndroidInitializationSettings('@mipmap/ic_launcher');
    // Desktop (issue #16): the same plugin renders OS toasts on Windows/Linux/
    // macOS. Windows needs a stable AppUserModelId + GUID to own its toasts.
    const windowsInit = WindowsInitializationSettings(
      appName: 'AiTerminal',
      appUserModelId: 'net.hilashnet.aiTerminal',
      guid: '2f6c9a1e-3b7d-4e5a-9c2f-8a1b4d6e7f30',
    );
    const linuxInit =
        LinuxInitializationSettings(defaultActionName: 'Open');
    const darwinInit = DarwinInitializationSettings();
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: androidInit,
        windows: windowsInit,
        linux: linuxInit,
        macOS: darwinInit,
      ),
      onDidReceiveNotificationResponse: _onForegroundTap,
      onDidReceiveBackgroundNotificationResponse: notificationTapBackground,
    );
    await _createChannels();
  }

  /// Renders a local OS notification directly (no FCM), used by the desktop
  /// alert path (issue #16). [kind] is `approval` / `apierror` / `idle`; the
  /// body is built from [name] exactly like the phone push. Never throws.
  static Future<void> showLocal({
    required String sessionId,
    required String serverName,
    required String kind,
    required String name,
  }) async {
    try {
      await init();
      final spec = _specFor(kind);
      if (spec == null) return;
      final body = buildBody(kind, name);
      final title = serverName.isEmpty ? 'AiTerminal' : serverName;
      await _plugin.show(
        id: _stableId(sessionId),
        title: title,
        body: body,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            spec.channelId,
            spec.channelName,
            importance: spec.importance,
            priority: spec.priority,
            tag: 'wt-$sessionId',
            autoCancel: true,
            styleInformation: BigTextStyleInformation(body),
          ),
          windows: const WindowsNotificationDetails(),
          linux: const LinuxNotificationDetails(),
          macOS: const DarwinNotificationDetails(),
        ),
        payload: jsonEncode({'sessionId': sessionId, 'serverName': serverName}),
      );
    } catch (_) {
      // Best-effort — a desktop toast failure must never break the app.
    }
  }

  /// Builds a notification from a content-free FCM [data] payload
  /// (`{kind, sessionId, serverName, ...}`).
  ///
  /// `kind == 'clear'` cancels the session's notification instead of posting.
  /// The body is derived from the local name cache; a cache miss yields
  /// `A session …`. Never throws.
  static Future<void> showFromPush(Map<String, String> data) async {
    try {
      final kind = data['kind'] ?? '';
      final sessionId = data['sessionId'] ?? '';
      final serverName = data['serverName'] ?? '';
      if (sessionId.isEmpty) return;

      final tag = 'wt-$sessionId';
      final id = _stableId(sessionId);

      if (kind == 'clear') {
        await _plugin.cancel(id: id, tag: tag);
        return;
      }

      final spec = _specFor(kind);
      if (spec == null) return; // unknown kind — nothing to render

      final name = await _lookupName(sessionId);
      final body = buildBody(kind, name);
      final title = serverName.isEmpty ? 'Web Terminal' : serverName;

      await _plugin.show(
        id: id,
        title: title,
        body: body,
        notificationDetails: NotificationDetails(
          android: AndroidNotificationDetails(
            spec.channelId,
            spec.channelName,
            importance: spec.importance,
            priority: spec.priority,
            tag: tag,
            groupKey: 'wt_group_$serverName',
            autoCancel: true,
            styleInformation: BigTextStyleInformation(body),
          ),
        ),
        payload: jsonEncode({'sessionId': sessionId, 'serverName': serverName}),
      );
    } catch (_) {
      // A malformed/partial push must never crash the background isolate.
    }
  }

  /// Pure body builder (unit-tested): maps a [kind] + optional [name] to the
  /// notification body. A null/empty [name] falls back to `A session`.
  static String buildBody(String kind, String? name) {
    final n = (name == null || name.isEmpty) ? 'A session' : name;
    switch (kind) {
      case 'approval':
        return '$n needs your approval';
      case 'apierror':
        return '$n stopped — API error';
      case 'idle':
        return '$n finished';
      default:
        return n;
    }
  }

  /// The SharedPreferences cache key for a session.
  ///
  /// Keyed by [sessionId] alone (a globally-unique UUID): FCM payloads carry
  /// `serverName` but no base URL, so a server-scoped key could not be
  /// reconstructed at push time. This deviates from the UI spec's
  /// `baseUrl|sessionId` key by design.
  static String nameCacheKey(String sessionId) => sessionId;

  /// Merges [entries] (`nameCacheKey → name`) into the persisted name cache.
  /// Best-effort — swallows storage errors.
  static Future<void> updateNameCache(Map<String, String> entries) async {
    if (entries.isEmpty) return;
    try {
      final prefs = await SharedPreferences.getInstance();
      final map = _readCache(prefs)..addAll(entries);
      await prefs.setString(nameCachePrefKey, jsonEncode(map));
    } catch (_) {/* best-effort */}
  }

  /// Returns the `sessionId` of the notification that cold-started the app, or
  /// `null` if the app was launched normally.
  static Future<String?> initialTapSessionId() async {
    try {
      // Ensure the plugin is initialized first. On Windows the launch-details
      // read throws a StateError until `initialize()` has run, and on a cold
      // toast launch nobody may have called init() yet (issue #20). init() is
      // idempotent, so this is cheap on the mobile path where it already ran.
      await init();
      final details = await _plugin.getNotificationAppLaunchDetails();
      if (details?.didNotificationLaunchApp ?? false) {
        return _sessionIdFromPayload(details!.notificationResponse?.payload);
      }
    } catch (_) {/* ignore */}
    return null;
  }

  // --- internals ----------------------------------------------------------

  static void _onForegroundTap(NotificationResponse response) {
    final sessionId = _sessionIdFromPayload(response.payload);
    if (sessionId != null && !_tapController.isClosed) {
      _tapController.add(sessionId);
    }
  }

  /// Extracts the `sessionId` from a notification payload (the `{sessionId,
  /// serverName}` JSON set on every toast/push). Returns null for a
  /// null/empty/malformed payload or one without a sessionId. Exposed for tests
  /// because it is the routing key for every notification tap (issue #20).
  @visibleForTesting
  static String? sessionIdFromPayload(String? payload) =>
      _sessionIdFromPayload(payload);

  static String? _sessionIdFromPayload(String? payload) {
    if (payload == null || payload.isEmpty) return null;
    try {
      final j = jsonDecode(payload);
      if (j is Map && j['sessionId'] != null) return j['sessionId'].toString();
    } catch (_) {/* ignore */}
    return null;
  }

  static Future<String?> _lookupName(String sessionId) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = _readCache(prefs)[nameCacheKey(sessionId)];
      if (v != null && v.isNotEmpty) return v;
    } catch (_) {/* cache miss on error */}
    return null;
  }

  static Map<String, String> _readCache(SharedPreferences prefs) {
    final raw = prefs.getString(nameCachePrefKey);
    final map = <String, String>{};
    if (raw != null) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          decoded.forEach((k, v) => map[k.toString()] = v.toString());
        }
      } catch (_) {/* corrupt cache → empty */}
    }
    return map;
  }

  static Future<void> _createChannels() async {
    final android = _plugin.resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin>();
    if (android == null) return;
    await android.createNotificationChannel(AndroidNotificationChannel(
      channelApproval,
      'Needs Approval',
      description: 'A session is waiting for your approval',
      importance: Importance.max,
      enableVibration: true,
      vibrationPattern: Int64List.fromList(<int>[0, 300, 200, 300]),
      enableLights: true,
      ledColor: const Color(0xFFE94560),
    ));
    await android.createNotificationChannel(AndroidNotificationChannel(
      channelApiError,
      'API Error',
      description: 'A session stopped on an API error',
      importance: Importance.high,
      enableVibration: true,
      vibrationPattern: Int64List.fromList(<int>[0, 200, 100, 200]),
      enableLights: true,
      ledColor: const Color(0xFFFF2D4B),
    ));
    await android.createNotificationChannel(const AndroidNotificationChannel(
      channelIdle,
      'Session Updates',
      description: 'A session finished or went idle',
      importance: Importance.low,
      playSound: false,
      enableVibration: false,
    ));
  }

  static _KindSpec? _specFor(String kind) {
    switch (kind) {
      case 'approval':
        return const _KindSpec(
            channelApproval, 'Needs Approval', Importance.max, Priority.max);
      case 'apierror':
        return const _KindSpec(
            channelApiError, 'API Error', Importance.high, Priority.high);
      case 'idle':
        return const _KindSpec(
            channelIdle, 'Session Updates', Importance.low, Priority.low);
      default:
        return null;
    }
  }

  /// Deterministic 32-bit FNV-1a hash → positive int. Used as the notification
  /// id so that `show` (background isolate) and `cancel` (main isolate) agree —
  /// Dart's `String.hashCode` is per-isolate seeded and would not.
  static int _stableId(String s) {
    var hash = 0x811c9dc5;
    for (final c in s.codeUnits) {
      hash ^= c;
      hash = (hash * 0x01000193) & 0xffffffff;
    }
    return hash & 0x7fffffff;
  }
}

class _KindSpec {
  const _KindSpec(
      this.channelId, this.channelName, this.importance, this.priority);
  final String channelId;
  final String channelName;
  final Importance importance;
  final Priority priority;
}
