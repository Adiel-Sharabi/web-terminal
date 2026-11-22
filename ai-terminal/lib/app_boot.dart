import 'package:flutter/widgets.dart';

import 'screens/startup_error_screen.dart';
import 'services/prefs_file_guard.dart';
import 'services/server_store.dart';

/// The steps before the first frame, in the order that keeps a damaged
/// settings file from costing the app its window (#486).
///
/// 1. [guard] repairs the prefs file BEFORE anything opens SharedPreferences.
///    Its own failure is not fatal; the store's read in step 2 decides.
/// 2. [store] is CALLED only now, and its servers loaded. It is a factory, not
///    a store, on purpose: the production store starts reading prefs the
///    moment it is constructed, and a load that fails is cached for good, so
///    `ServerStore.instance` evaluated as an argument (before this function
///    even runs) read the damaged file ahead of the guard - the type now
///    refuses both that and the `.init` tear-off.
/// 3. If loading throws, the result is a [StartupErrorApp]: the Windows runner
///    shows its window only after a frame, so anything that ends main() before
///    runApp is a live process with nothing on screen. [settingsDir] is looked
///    up only then, and its own failure only drops the folder from the text.
/// 4. Otherwise [app] builds the real root, given the guard's sentence for the
///    person (null when nothing was repaired).
Future<Widget> bootApp({
  required Future<PrefsGuardResult> Function() guard,
  required ServerStore Function() store,
  required Widget Function(String? notice) app,
  Future<String?> Function()? settingsDir,
}) async {
  var repaired = const PrefsGuardResult(PrefsRecovery.none);
  try {
    repaired = await guard();
  } catch (e, st) {
    debugPrint('prefs guard failed - continuing to the normal read: $e\n$st');
  }
  try {
    await store().init();
  } catch (e, st) {
    debugPrint('startup failed before the first frame: $e\n$st');
    String? dir;
    try {
      dir = await settingsDir?.call();
    } catch (_) {
      // The folder is a hint in the error text, never a reason to show nothing.
    }
    return StartupErrorApp(error: e, settingsDir: dir);
  }
  return app(repaired.message);
}
