import 'package:flutter/material.dart';

/// Shows [text] in the nearest messenger's snackbar, replacing the one on screen, for
/// [duration], with an optional [action] (an Undo). Returns its controller, or null
/// when there is no messenger.
///
/// #322 - `persist` is load-bearing: the SDK defaults a snackbar WITH an action (our
/// Undo) to persist, ignoring `duration`, so the toast never left the screen. It must
/// still persist under TalkBack/VoiceOver, where the user needs time to reach Undo -
/// the protection that default exists for. One place, so a second screen with an Undo
/// cannot bring the bug back.
ScaffoldFeatureController<SnackBar, SnackBarClosedReason>? showTimedSnackBar(
  BuildContext context,
  String text, {
  SnackBarAction? action,
  Duration duration = const Duration(seconds: 5),
  Key? key,
}) {
  final m = ScaffoldMessenger.maybeOf(context);
  if (m == null) return null;
  m.hideCurrentSnackBar();
  return m.showSnackBar(
    SnackBar(
      key: key,
      content: Text(text),
      action: action,
      duration: duration,
      persist: MediaQuery.accessibleNavigationOf(context),
    ),
  );
}
