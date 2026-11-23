// #507 - one build runs both homes: the current sessions home ([AdaptiveHome]) and
// Mission Control ([MissionControlHome]), side by side.
//
// * Which one opens on launch is the person's setting ([LaunchSettings.restoreHome]),
//   default the sessions home, so nobody's start changes until they choose.
// * Switching keeps state: each home is built the first time it is shown and then kept
//   (an IndexedStack), so its scroll, filters and folds survive a switch either way.
// * "Open to the inbox at launch" (#492) belongs to the sessions home: it runs only when
//   that is the home the app opened on. Mission Control's Now is its own needs-you view.
// * The split's detail pane is the sessions home's: something from OUTSIDE that asks it
//   to show a session or the inbox (a notification tap on a wide window) while Mission
//   Control is on screen brings the sessions home forward, so the answer is seen.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../services/launch_settings.dart';
import '../services/session_selection.dart';
import '../theme/app_theme.dart';
import 'adaptive_home.dart';
import 'mission_control/mc_home.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, this.launchHome, this.sessionsHomeBuilder, this.missionControlBuilder});

  /// Test seam: the home to open on. Defaults to [LaunchSettings.restoreHome].
  @visibleForTesting
  final Future<AppHome> Function()? launchHome;

  /// Test seam: builds the sessions home, given whether it runs the launch inbox and how
  /// it switches to Mission Control.
  @visibleForTesting
  final Widget Function({required bool launchInbox, required VoidCallback onOpenMissionControl})? sessionsHomeBuilder;

  /// Test seam: builds Mission Control, given how it switches back and whether it is on screen.
  @visibleForTesting
  final Widget Function({required VoidCallback onShowSessionsHome, required ValueListenable<bool> active})?
      missionControlBuilder;

  @override
  State<HomeShell> createState() => HomeShellState();
}

class HomeShellState extends State<HomeShell> {
  AppHome? _launch;
  AppHome? _shown;
  final Set<AppHome> _built = {};
  final ValueNotifier<bool> _mcActive = ValueNotifier<bool>(false);
  final SessionSelection _selection = SessionSelection.instance;

  /// The home on screen, or null until the launch choice is read.
  AppHome? get shown => _shown;

  @override
  void initState() {
    super.initState();
    _selection.pane.addListener(_onPane);
    (widget.launchHome ?? LaunchSettings.instance.restoreHome)().then((home) {
      if (!mounted) return;
      setState(() => _launch = home);
      show(home);
    });
  }

  @override
  void dispose() {
    _selection.pane.removeListener(_onPane);
    _mcActive.dispose();
    super.dispose();
  }

  /// Puts [home] on screen, building it the first time.
  void show(AppHome home) {
    if (!mounted) return;
    setState(() {
      _shown = home;
      _built.add(home);
    });
    _mcActive.value = home == AppHome.missionControl;
  }

  void _onPane() {
    if (_shown != AppHome.missionControl) return;
    if (_selection.pane.value.isBoard) return;
    show(AppHome.sessions);
  }

  @override
  Widget build(BuildContext context) {
    final shown = _shown;
    // A frame or two while the setting is read: the app's background, nothing else, so
    // neither home starts (and runs its launch steps) before it is known which opens.
    if (shown == null) return const ColoredBox(color: AppColors.background, child: SizedBox.expand());
    final launchInbox = _launch == AppHome.sessions;
    void toMc() => show(AppHome.missionControl);
    void toSessions() => show(AppHome.sessions);
    // The hidden home keeps its state but takes no keys and runs no animations.
    Widget slot(AppHome home, Widget Function() build) => ExcludeFocus(
          excluding: shown != home,
          child: TickerMode(
            enabled: shown == home,
            child: _built.contains(home) ? build() : const SizedBox.shrink(),
          ),
        );
    return IndexedStack(
      index: shown.index,
      sizing: StackFit.expand,
      children: [
        slot(
          AppHome.sessions,
          () => KeyedSubtree(
            key: const ValueKey('home-sessions'),
            child: (widget.sessionsHomeBuilder ??
                ({required bool launchInbox, required VoidCallback onOpenMissionControl}) =>
                    AdaptiveHome(launchInbox: launchInbox, onOpenMissionControl: onOpenMissionControl))(
                launchInbox: launchInbox, onOpenMissionControl: toMc),
          ),
        ),
        slot(
          AppHome.missionControl,
          () => KeyedSubtree(
            key: const ValueKey('home-mission-control'),
            child: (widget.missionControlBuilder ??
                ({required VoidCallback onShowSessionsHome, required ValueListenable<bool> active}) =>
                    MissionControlHome(onShowSessionsHome: onShowSessionsHome, active: active))(
                onShowSessionsHome: toSessions, active: _mcActive),
          ),
        ),
      ],
    );
  }
}
