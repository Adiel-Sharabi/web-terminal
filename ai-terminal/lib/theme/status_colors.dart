/// Status color tokens and the session/server status enums, mirroring
/// `../docs/COMPANION-APP-UI-SPEC.md` §0.2 (`StatusColor`) and §0.5 (`StatusDot`).
library;

import 'package:flutter/material.dart';

import 'pulse_clock.dart';

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
/// ease-in-out, repeating forever. Used by [SessionStatus.waiting],
/// [SessionStatus.working] and [SessionStatus.apiError] dots (spec §0.2, §0.5),
/// and by the chat lens's working / compacting / subagent indicators.
///
/// **Driven by [PulseClock], never by a ticker of its own.** A ticker asks for a
/// frame every vsync, and a Flutter frame is whole-window work — so three 6px
/// dots measured 13.5% GPU + 7.7% DWM on a 2576x1048 window. The shared clock
/// advances at 10fps and moves every pulse in the app on the same tick, so the
/// frame count does not grow with the number of dots. See [PulseClock].
///
/// Two properties this widget must keep (pinned by
/// `test/status_dot_pulse_test.dart`): the animated part sits behind a
/// [RepaintBoundary] so a frame repaints the ~10px dot rather than the card or
/// chat list around it, and opacity is applied by [FadeTransition] compositing
/// that cached layer — never by an [Opacity] widget, which forces a saveLayer
/// every frame.
class Pulse extends StatefulWidget {
  const Pulse({
    super.key,
    required this.child,
    this.enabled = true,
    this.phase = 0,
  });

  final Widget child;
  final bool enabled;

  /// Offset into the 0..1 breath, so a group of dots pulses out of step
  /// (0, 1/3, 2/3) while still sharing the one clock.
  final double phase;

  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
  /// Held only as the value [FadeTransition] reads. It is never started, so it
  /// never schedules a frame — [PulseClock] advances it.
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: PulseClock.cycle,
  );

  late final Animation<double> _opacity = Tween<double>(
    begin: 1,
    end: 0.35,
  ).chain(CurveTween(curve: Curves.easeInOut)).animate(_controller);

  bool _subscribed = false;

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(covariant Pulse oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.enabled != widget.enabled) _sync();
  }

  /// Subscribe to the shared clock only while enabled; the clock itself owns
  /// the visibility gate, so an unsubscribed or hidden pulse parks at full
  /// opacity and a static dot still reads as solid.
  void _sync() {
    if (widget.enabled == _subscribed) return;
    final clock = PulseClock.instance;
    if (widget.enabled) {
      clock.addListener(_onClock);
      clock.acquire();
      _subscribed = true;
      _onClock();
    } else {
      clock.removeListener(_onClock);
      clock.release();
      _subscribed = false;
      _controller.value = 0; // Tween.begin → opacity 1.0
    }
  }

  /// Map the shared phase onto this dot. The controller is a plain 0..1 value
  /// here, so the out-and-back triangle is explicit — it used to fall out of
  /// `repeat(reverse: true)`.
  void _onClock() {
    final clock = PulseClock.instance;
    if (!clock.running) {
      _controller.value = 0; // parked → opacity 1.0
      return;
    }
    final t = (clock.phase + widget.phase) % 1.0;
    _controller.value = 1 - (2 * t - 1).abs();
  }

  @override
  void dispose() {
    if (_subscribed) {
      PulseClock.instance.removeListener(_onClock);
      PulseClock.instance.release();
    }
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.enabled) return widget.child;
    // RepaintBoundary confines the repaint to the ~10px dot instead of
    // invalidating the whole session card; FadeTransition composites that cached
    // layer with alpha, avoiding the saveLayer the old Opacity widget forced.
    // These make each frame cheap; PulseClock is what makes the frames rare.
    return RepaintBoundary(
      child: FadeTransition(opacity: _opacity, child: widget.child),
    );
  }
}
