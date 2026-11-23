// #492 - "Open to the inbox at launch". One persisted bool, `launch.openInbox`: absent
// means the platform's default (ON for a phone, OFF for desktop), so nobody is switched
// by an upgrade who never chose, and a phone's default can differ from a desktop's
// without a second setting.

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

  @visibleForTesting
  void reset() => phoneOverride = null;
}
