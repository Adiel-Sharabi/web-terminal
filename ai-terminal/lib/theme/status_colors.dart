/// Status color tokens and the session/server status enums, mirroring
/// `../docs/COMPANION-APP-UI-SPEC.md` §0.2 (`StatusColor`) and §0.5 (`StatusDot`).
library;

import 'package:flutter/material.dart';

/// A session's live status, parsed from the raw string the server sends
/// (`Session.status`: `working`, `idle`, `waiting`, `api_error`, `active`, …).
enum SessionStatus { idle, active, working, waiting, apiError }

/// Parses a raw `Session.status` string into a [SessionStatus], defaulting to
/// [SessionStatus.idle] for anything unrecognized so a new server-side status
/// never crashes the UI.
SessionStatus sessionStatusFromString(String? raw) {
  switch (raw) {
    case 'active':
      return SessionStatus.active;
    case 'working':
      return SessionStatus.working;
    case 'waiting':
      return SessionStatus.waiting;
    case 'api_error':
      return SessionStatus.apiError;
    case 'idle':
    default:
      return SessionStatus.idle;
  }
}

/// A cluster server's reachability, as tracked by `SessionRepository.serverOnline`.
enum ServerStatus { online, offline, needsAuth }

/// Status color tokens — spec §0.2.
///
/// ```kotlin
/// object StatusColor {
///     val Idle       = Color(0xFF44AA44)
///     val Active     = Color(0xFF44AA44)
///     val Working    = Color(0xFFFF9900)
///     val Waiting    = Color(0xFFE94560)
///     val ApiError   = Color(0xFFFF2D4B)
///     val ServerOnline     = Color(0xFF44AA44)
///     val ServerOffline    = Color(0xFFAA4444)
///     val ServerNeedsAuth  = Color(0xFFDDAA44)
/// }
/// ```
abstract final class StatusColor {
  static const idle = Color(0xFF44AA44);
  static const active = Color(0xFF44AA44);
  static const working = Color(0xFFFF9900);
  static const waiting = Color(0xFFE94560);
  static const apiError = Color(0xFFFF2D4B);

  static const serverOnline = Color(0xFF44AA44);
  static const serverOffline = Color(0xFFAA4444);
  static const serverNeedsAuth = Color(0xFFDDAA44);

  /// The color for a given [SessionStatus].
  static Color forStatus(SessionStatus status) => switch (status) {
    SessionStatus.idle => idle,
    SessionStatus.active => active,
    SessionStatus.working => working,
    SessionStatus.waiting => waiting,
    SessionStatus.apiError => apiError,
  };

  /// The color for a given [ServerStatus].
  static Color forServerStatus(ServerStatus status) => switch (status) {
    ServerStatus.online => serverOnline,
    ServerStatus.offline => serverOffline,
    ServerStatus.needsAuth => serverNeedsAuth,
  };
}

/// Status label text, mirroring the web sidebar's `statusLabels` map:
/// `{ active: '', working: 'Working', idle: 'Idle', waiting: 'Waiting' }`.
/// `active` (a session too fresh to have transitioned yet) intentionally
/// renders no label — just its dot. `apiError` also renders no separate
/// label: that state is already communicated by the "API error" attention
/// chip (or, for a live `ApiErrorInfo` override, the dedicated overlay) —
/// a third "API error" label here would just be a duplicate.
String statusLabel(SessionStatus status) => switch (status) {
  SessionStatus.active => '',
  SessionStatus.working => 'Working',
  SessionStatus.idle => 'Idle',
  SessionStatus.waiting => 'Waiting',
  SessionStatus.apiError => '',
};

/// Wraps [child] in the spec's pulse animation: alpha 1.0↔0.35 over 1500ms,
/// ease-in-out, repeating forever. Used by [SessionStatus.waiting] and
/// [SessionStatus.apiError] dots (spec §0.2, §0.5).
class Pulse extends StatefulWidget {
  const Pulse({super.key, required this.child, this.enabled = true});

  final Widget child;
  final bool enabled;

  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  );

  late final Animation<double> _opacity = Tween<double>(
    begin: 1,
    end: 0.35,
  ).chain(CurveTween(curve: Curves.easeInOut)).animate(_controller);

  @override
  void initState() {
    super.initState();
    // Observe app visibility so the pulse costs nothing when the window is
    // unfocused/minimized — a repeating 60fps animation otherwise keeps the GPU
    // busy even when no one is looking at it.
    WidgetsBinding.instance.addObserver(this);
    _sync();
  }

  @override
  void didUpdateWidget(covariant Pulse oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.enabled != widget.enabled) _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _sync();

  /// Run the repeating pulse only while enabled AND the window is visible;
  /// otherwise stop and park at full opacity so a static dot reads as solid.
  void _sync() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final visible = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    if (widget.enabled && visible) {
      if (!_controller.isAnimating) _controller.repeat(reverse: true);
    } else if (_controller.isAnimating) {
      _controller.stop();
      _controller.value = 0; // Tween.begin → opacity 1.0
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled) return widget.child;
    // RepaintBoundary confines the per-frame repaint to the ~10px dot instead of
    // invalidating the whole session card; FadeTransition composites that cached
    // layer with alpha, avoiding the per-frame saveLayer the old Opacity widget
    // forced. Together these drop the pulse from ~1 core / 20% GPU to negligible.
    return RepaintBoundary(
      child: FadeTransition(opacity: _opacity, child: widget.child),
    );
  }
}
