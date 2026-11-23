// #492 - "Open to the inbox at launch". One persisted bool, `launch.openInbox`: absent
// means the platform's default (ON for a phone, OFF for desktop), so nobody is switched
// by an upgrade who never chose, and a phone's default can differ from a desktop's
// without a second setting.
//
// #507 - "Home on launch": which home the app opens on, the current sessions home or
// Mission Control. One persisted string, `launch.home`; absent (or a value this build
// does not know) means the sessions home, so nobody's start changes until they choose.

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class LaunchSettings {
  LaunchSettings._();

  static final LaunchSettings instance = LaunchSettings._();

  /// The SharedPreferences key.
  static const String prefsKey = 'launch.openInbox';

  /// Test seam: whether the platform counts as a phone. Null: ask the platform.
  @visibleForTesting
  bool? phoneOverride;

  /// ON by default on a phone, OFF on desktop.
  bool get platformDefault => phoneOverride ?? (!kIsWeb && (Platform.isAndroid || Platform.isIOS));

  /// The stored choice, or [platformDefault] when none was made (or storage fails).
  Future<bool> restore() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getBool(prefsKey) ?? platformDefault;
    } catch (_) {
      return platformDefault;
    }
  }

  Future<void> setEnabled(bool value) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(prefsKey, value);
    } catch (_) {
      // Unsaved is not a reason to refuse the switch; it holds for this run only.
    }
  }

  /// The SharedPreferences key of the launch home (#507).
  static const String homePrefsKey = 'launch.home';

  /// The stored launch home, or [AppHome.sessions] when none (or storage fails).
  Future<AppHome> restoreHome() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return AppHome.fromWire(prefs.getString(homePrefsKey));
    } catch (_) {
      return AppHome.sessions;
    }
  }

  Future<void> setHome(AppHome home) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(homePrefsKey, home.wire);
    } catch (_) {
      // As [setEnabled]: it holds for this run only.
    }
  }

  @visibleForTesting
  void reset() => phoneOverride = null;
}

/// The two homes one build runs side by side (#507).
enum AppHome {
  /// The current home: the session list, the board, the inbox.
  sessions('sessions'),

  /// Mission Control: Now, Projects, Sessions/Ask, Machines.
  missionControl('mission-control');

  const AppHome(this.wire);

  /// How it is stored.
  final String wire;

  /// The stored value read back; anything unknown is the default, [sessions].
  static AppHome fromWire(String? v) => v == missionControl.wire ? missionControl : sessions;
}
