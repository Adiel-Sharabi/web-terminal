import 'package:flutter/widgets.dart';

import 'screens/startup_error_screen.dart';
import 'services/prefs_file_guard.dart';

/// The steps before the first frame, in the order that keeps a damaged
/// settings file from costing the app its window (#486).
///
/// 1. [guard] repairs the prefs file BEFORE anything opens SharedPreferences.
///    Its own failure is not fatal; the store's read in step 2 decides.
/// 2. [initStore] loads the saved servers. If it throws, the result is a
///    [StartupErrorApp]: the Windows runner shows its window only after a
///    frame, so anything that ends main() before runApp is a live process with
///    nothing on screen.
/// 3. Otherwise [app] builds the real root, given the guard's sentence for the
///    person (null when nothing was repaired).
///
/// Pure over its parameters so the ORDER is tested, not just each step.
Future<Widget> bootApp({
  required Future<PrefsGuardResult> Function() guard,
  required Future<void> Function() initStore,
  required Widget Function(String? notice) app,
  String? settingsDir,
}) async {
  var repaired = const PrefsGuardResult(PrefsRecovery.none);
  try {
    repaired = await guard();
  } catch (e, st) {
    debugPrint('prefs guard failed - continuing to the normal read: $e\n$st');
  }
  try {
    await initStore();
  } catch (e, st) {
    debugPrint('startup failed before the first frame: $e\n$st');
    return StartupErrorApp(error: e, settingsDir: settingsDir);
  }
  return app(repaired.message);
}
