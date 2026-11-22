import 'dart:convert';
import 'dart:io';

import 'package:path_provider_windows/path_provider_windows.dart';

/// Issue #486 — a crash must never cost the app its window.
///
/// On Windows, shared_preferences stores everything in ONE JSON file, which
/// its plugin (shared_preferences_windows 2.4.1) rewrites IN PLACE
/// (`writeAsStringSync`, no temp file + rename) and reads back with an
/// unguarded `json.decode`. A hard crash mid-write left that file the right
/// size but entirely NUL bytes; on the next launch `SharedPreferences
/// .getInstance()` threw, `main()` ended before `runApp`, and the runner (which
/// shows its window only after the first frame) stayed alive with nothing on
/// screen — no window, no error, one more invisible process per click.
///
/// We do not own the plugin, so this guard runs BEFORE anything opens
/// SharedPreferences:
///  * a good file is copied to [lastGoodSuffix] at every launch (temp file +
///    rename, so a crash can never zero the copy as well);
///  * an unusable file is moved aside to `.corrupt-<time>` — never deleted, it
///    is the person's data — and the last good copy is restored, or the app
///    starts fresh when there is none. The caller tells the person which.
///
/// "Usable" is stricter than "does not throw": an empty file or a non-object
/// makes the plugin silently start from nothing, which is the same loss of
/// settings, so both are recovered too.

/// The file name the plugin uses (`_defaultFileName` + `.json`).
const String prefsFileName = 'shared_preferences.json';

/// Suffix of the last-good copy kept beside the live file.
const String lastGoodSuffix = '.lastgood';

/// What [guardPrefsFile] did.
enum PrefsRecovery {
  /// The file was usable, or absent (first run). Nothing to tell anyone.
  none,

  /// The file was unusable; the last good copy was put back.
  restoredFromBackup,

  /// The file was unusable and no usable backup existed; the app starts with
  /// default settings.
  startedFresh,
}

class PrefsGuardResult {
  const PrefsGuardResult(this.recovery, {this.corruptCopy, this.backupTime});

  final PrefsRecovery recovery;

  /// Where the unusable file was moved (kept for the person, never deleted).
  final String? corruptCopy;

  /// When the restored copy was saved (its modification time).
  final DateTime? backupTime;

  bool get recovered => recovery != PrefsRecovery.none;

  /// One sentence for the person, or null when nothing happened.
  String? get message {
    switch (recovery) {
      case PrefsRecovery.none:
        return null;
      case PrefsRecovery.restoredFromBackup:
        return 'The settings file was damaged, probably by a crash or power '
            'loss. AiTerminal restored the copy saved ${_when(backupTime)}; '
            'changes made after that are lost. The damaged file was kept as '
            '$corruptCopy.';
      case PrefsRecovery.startedFresh:
        return 'The settings file was damaged, probably by a crash or power '
            'loss, and no saved copy existed, so AiTerminal started with '
            'default settings. Add your servers again. The damaged file was '
            'kept as $corruptCopy.';
    }
  }
}

String _when(DateTime? t) {
  if (t == null) return 'earlier';
  String two(int n) => n.toString().padLeft(2, '0');
  return 'on ${t.year}-${two(t.month)}-${two(t.day)} at ${two(t.hour)}:${two(t.minute)}';
}

/// The file's text when it is what the plugin needs (UTF-8 that decodes to a
/// JSON object), else null. One read: the caller writes THESE bytes, so a
/// writer in another window cannot slip a half-written file in between the
/// check and the copy.
String? readUsablePrefs(File file) {
  try {
    final text = file.readAsStringSync();
    return json.decode(text) is Map ? text : null;
  } catch (_) {
    return null;
  }
}

/// Writes [text] to [path] via a temp file + rename, so [path] is never left
/// half-written.
void _writeAtomically(String path, String text) {
  final tmp = File('$path.tmp');
  tmp.writeAsStringSync(text, flush: true);
  tmp.renameSync(path);
}

/// Checks the prefs file in [dir] and repairs it (see the library comment).
///
/// A detached session window (#14) is a second process on the same file, so
/// an unusable read may be the main window mid-write: the file is judged
/// damaged only after [attempts] reads [retryDelay] apart all fail (a write
/// takes milliseconds; a zero-filled file never heals). [now] names the
/// `.corrupt-<time>` copy; tests pass a fixed one.
Future<PrefsGuardResult> guardPrefsFile(
  Directory dir, {
  DateTime? now,
  int attempts = 3,
  Duration retryDelay = const Duration(milliseconds: 250),
}) async {
  final live = File('${dir.path}${Platform.pathSeparator}$prefsFileName');
  final lastGood = File('${live.path}$lastGoodSuffix');

  for (var i = 0; i < attempts; i++) {
    if (!live.existsSync()) return const PrefsGuardResult(PrefsRecovery.none);
    final text = readUsablePrefs(live);
    if (text != null) {
      _writeAtomically(lastGood.path, text);
      return const PrefsGuardResult(PrefsRecovery.none);
    }
    if (i < attempts - 1) await Future<void>.delayed(retryDelay);
  }

  final t = now ?? DateTime.now();
  String two(int n) => n.toString().padLeft(2, '0');
  final stamp = '${t.year}${two(t.month)}${two(t.day)}-'
      '${two(t.hour)}${two(t.minute)}${two(t.second)}';
  final corrupt = live.renameSync('${live.path}.corrupt-$stamp');

  final saved = lastGood.existsSync() ? readUsablePrefs(lastGood) : null;
  if (saved != null) {
    final savedAt = lastGood.lastModifiedSync();
    _writeAtomically(live.path, saved);
    return PrefsGuardResult(PrefsRecovery.restoredFromBackup,
        corruptCopy: corrupt.path, backupTime: savedAt);
  }
  return PrefsGuardResult(PrefsRecovery.startedFresh, corruptCopy: corrupt.path);
}

/// The production entry point: on Windows, guards the file in the directory
/// the plugin itself uses (the same `getApplicationSupportPath` call, so the
/// two can never disagree on where the file is). Elsewhere a no-op: Android
/// and iOS store preferences natively, not in this file.
Future<PrefsGuardResult> guardPrefsFileForPlatform() async {
  if (!Platform.isWindows) return const PrefsGuardResult(PrefsRecovery.none);
  final path = await PathProviderWindows().getApplicationSupportPath();
  if (path == null) return const PrefsGuardResult(PrefsRecovery.none);
  return guardPrefsFile(Directory(path));
}
