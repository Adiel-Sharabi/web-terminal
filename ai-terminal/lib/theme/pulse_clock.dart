import 'dart:async';

import 'package:flutter/widgets.dart';

/// The single clock every [Pulse] in the app shares.
///
/// **Why this exists, and why it is not an [AnimationController].** A running
/// ticker asks the engine for a frame on every vsync, and a Flutter frame is
/// whole-window work: build, layout, paint, rasterise, present — then DWM
/// composites the result. So the cost of a pulsing dot has almost nothing to do
/// with the dot. Measured on a 2576x1048 window (Intel UHD 770), three 6px dots
/// in a "Claude is working" bubble cost **13.5% GPU + 7.7% DWM**; the same app
/// with no bubble on screen sat at 6.2% + 4.1%. Bounding the repaint with a
/// RepaintBoundary (which [Pulse] does) makes each frame cheap, but it cannot
/// make the frames stop.
///
/// A 1500ms breath does not need 60fps. This drives every pulse from one
/// [Timer] at [tick], so:
///
/// * frames drop from ~60/s to ~10/s while anything is pulsing, and
/// * **N dots cost the same as one** — they all advance on the same tick, so
///   they redraw in a single frame instead of each dot dirtying its own.
///
/// The second point is the reason this is a shared singleton rather than a
/// per-widget timer: eight independent 10fps timers land on eight different
/// milliseconds and would put us right back at ~60 frames a second.
///
/// It also owns the visibility gate — one [WidgetsBindingObserver] for the whole
/// app instead of one per dot. While the window is not visible the clock stops
/// and every listener parks at full opacity, so a static dot still reads solid.
class PulseClock extends ChangeNotifier with WidgetsBindingObserver {
  PulseClock._();

  static final PulseClock instance = PulseClock._();

  /// One full breath. Matches the spec's 1500ms (status_colors §0.2).
  static const Duration cycle = Duration(milliseconds: 1500);

  /// How often the phase advances — 10fps. Fifteen steps per breath is smooth
  /// for a fade; it is six times fewer frames than a vsync-driven ticker.
  static const Duration tick = Duration(milliseconds: 100);

  Timer? _timer;
  int _listenerCount = 0;
  bool _visible = true;
  double _phase = 0;

  /// Position in the current breath, 0..1. Only meaningful while [running].
  double get phase => _phase;

  /// True while the clock is advancing. False means every pulse should park.
  bool get running => _timer != null;

  /// Called by a [Pulse] that has started pulsing. Balanced by [release].
  void acquire() {
    if (_listenerCount++ == 0) {
      WidgetsBinding.instance.addObserver(this);
      final lifecycle = WidgetsBinding.instance.lifecycleState;
      _visible = lifecycle == null || lifecycle == AppLifecycleState.resumed;
      _syncTimer();
    }
  }

  /// Called by a [Pulse] that has stopped pulsing or been disposed.
  void release() {
    if (--_listenerCount <= 0) {
      _listenerCount = 0;
      WidgetsBinding.instance.removeObserver(this);
      _stop();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _visible = state == AppLifecycleState.resumed;
    _syncTimer();
  }

  void _syncTimer() {
    if (_listenerCount > 0 && _visible) {
      _timer ??= Timer.periodic(tick, (_) {
        _phase = (_phase + tick.inMilliseconds / cycle.inMilliseconds) % 1.0;
        notifyListeners();
      });
    } else {
      _stop();
    }
  }

  void _stop() {
    if (_timer == null) return;
    _timer!.cancel();
    _timer = null;
    _phase = 0;
    notifyListeners(); // listeners park at full opacity
  }

  /// How many [Pulse]es are currently subscribed. They all ride the one timer,
  /// so this can grow without the frame rate growing with it.
  @visibleForTesting
  int get subscriberCount => _listenerCount;

  /// Tests only — drop all state so one spec cannot leak into the next.
  @visibleForTesting
  void resetForTest() {
    _timer?.cancel();
    _timer = null;
    _phase = 0;
    _listenerCount = 0;
    _visible = true;
  }
}
