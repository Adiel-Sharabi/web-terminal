/// Desktop alert path (issue #16): on Windows/macOS/Linux — where there is no
/// FCM push — this watches the merged session list and raises an OS toast when
/// a session needs attention (approval, stuck API error) or, at the `all`
/// notify level, finishes. It mirrors the phone-push trigger levels using the
/// per-session Notify Level, and suppresses an alert for a session the user is
/// already looking at in a focused window.
///
/// The decision is factored into pure functions ([desktopAlertKind],
/// [desktopAlertPasses]) and a stateful-but-testable [DesktopAlertDecider] so
/// the transition/seeding/suppression rules can be unit-tested without the
/// [SessionRepository] singleton or the notification plugin.
library;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import '../api/models.dart';
import 'notification_service.dart';
import 'session_repository.dart';

/// Maps a session's status (+ live api-error flag) to an alert kind:
/// `approval` (waiting), `apierror` (stuck), `idle` (finished) or `none`.
/// api-error wins over everything else.
String desktopAlertKind(String status, bool apiError) {
  if (apiError || status == 'api_error') return 'apierror';
  switch (status) {
    case 'waiting':
      return 'approval';
    case 'idle':
      return 'idle';
    default:
      return 'none'; // working / unknown → not an alert
  }
}

/// Whether an alert [kind] passes the per-session [notifyLevel]:
/// `off` → nothing; `important` → approval + apierror; `all` → everything.
/// An unknown level is treated as `important` (the app default).
bool desktopAlertPasses(String kind, String notifyLevel) {
  switch (notifyLevel) {
    case 'off':
      return false;
    case 'all':
      return kind != 'none';
    case 'important':
    default:
      return kind == 'approval' || kind == 'apierror';
  }
}

/// The minimal per-session facts the decider needs — decoupled from [Session]
/// and the repository so the decision logic is pure and testable.
@immutable
class SessionAlertInput {
  const SessionAlertInput({
    required this.id,
    required this.status,
    required this.apiError,
    required this.notifyLevel,
    required this.name,
    required this.serverName,
  });

  final String id;
  final String status;
  final bool apiError;
  final String notifyLevel;
  final String name;
  final String serverName;
}

/// A resolved alert ready to render.
@immutable
class DesktopAlert {
  const DesktopAlert({
    required this.sessionId,
    required this.serverName,
    required this.kind,
    required this.name,
  });

  final String sessionId;
  final String serverName;
  final String kind;
  final String name;
}

/// Holds the last-seen alert kind per session and decides which sessions have
/// just *transitioned into* an alert-worthy state. The first evaluation only
/// seeds the baseline (so pre-existing states at launch don't all fire), and
/// each later evaluation returns only genuine transitions that pass the level
/// gate and aren't currently focused.
class DesktopAlertDecider {
  final Map<String, String> _lastKind = <String, String>{};
  bool _seeded = false;

  @visibleForTesting
  bool get seeded => _seeded;

  /// Returns the alerts to fire for [inputs]. [visible] is the set of session
  /// ids currently on screen; when [appFocused] is true, a visible session is
  /// suppressed (you're already looking at it).
  List<DesktopAlert> evaluate(
    List<SessionAlertInput> inputs, {
    required bool appFocused,
    required Set<String> visible,
  }) {
    final out = <DesktopAlert>[];
    final live = <String>{};
    for (final s in inputs) {
      live.add(s.id);
      final kind = desktopAlertKind(s.status, s.apiError);
      final prev = _lastKind[s.id];
      _lastKind[s.id] = kind;
      if (!_seeded) continue; // baseline only
      if (kind == 'none' || kind == prev) continue;
      if (!desktopAlertPasses(kind, s.notifyLevel)) continue;
      if (appFocused && visible.contains(s.id)) continue;
      out.add(DesktopAlert(
        sessionId: s.id,
        serverName: s.serverName,
        kind: kind,
        name: s.name,
      ));
    }
    _lastKind.removeWhere((id, _) => !live.contains(id));
    _seeded = true;
    return out;
  }
}

/// Wires [DesktopAlertDecider] to the live [SessionRepository] stream and the
/// [NotificationService] toast renderer. Singleton, desktop-only.
class DesktopAlertService {
  DesktopAlertService._();
  static final DesktopAlertService instance = DesktopAlertService._();

  /// True on desktop platforms (where there is no FCM push).
  static bool get supported =>
      !kIsWeb && (Platform.isWindows || Platform.isMacOS || Platform.isLinux);

  final DesktopAlertDecider _decider = DesktopAlertDecider();
  final Set<String> _visible = <String>{};
  bool _started = false;

  /// Registers/clears a session as on-screen so a focused view of it suppresses
  /// its own alert. Called by `SessionScreen`.
  void markVisible(String sessionId) => _visible.add(sessionId);
  void markHidden(String sessionId) => _visible.remove(sessionId);

  /// Begins watching the session stream. Idempotent; no-op off desktop.
  Future<void> start() async {
    if (_started || !supported) return;
    _started = true;
    // Attach first so no emission is missed; runs for the app's lifetime.
    SessionRepository.instance.sessions.listen(_onSessions);
    // Initialize the notification plugin eagerly so Windows registers this
    // app's AppUserModelId / Start-menu shortcut at launch — otherwise the
    // FIRST toast on an unpackaged app can be silently dropped.
    unawaited(NotificationService.init());
  }

  void _onSessions(List<Session> sessions) {
    final repo = SessionRepository.instance;
    final inputs = <SessionAlertInput>[
      for (final s in sessions)
        SessionAlertInput(
          id: s.id,
          status: s.status,
          apiError: s.status == 'api_error' || repo.apiErrorFor(s.id) != null,
          notifyLevel: s.notifyLevel,
          name: s.name,
          serverName: s.server.name,
        ),
    ];
    final alerts = _decider.evaluate(
      inputs,
      appFocused:
          WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed,
      visible: _visible,
    );
    for (final a in alerts) {
      unawaited(NotificationService.showLocal(
        sessionId: a.sessionId,
        serverName: a.serverName,
        kind: a.kind,
        name: a.name,
      ));
    }
  }
}
