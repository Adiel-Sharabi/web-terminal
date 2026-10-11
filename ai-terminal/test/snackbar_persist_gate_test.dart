import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// #322 - Flutter defaults a SnackBar WITH an action to `persist: true` and then ignores
// its `duration`, so a toast with an Undo button never leaves the screen. Every file
// that builds a SnackBarAction must decide `persist` explicitly. A source check, because
// a stuck toast only shows on a real screen and no behavioural test of another screen
// would notice a new one.
void main() {
  test('every SnackBarAction in lib/ sits in a file that sets persist explicitly', () {
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final src = f.readAsStringSync();
      if (src.contains('SnackBarAction(') && !src.contains('persist:')) offenders.add(f.path);
    }
    expect(offenders, isEmpty, reason: 'a SnackBar with an action persists forever unless persist is set');
  });
}
