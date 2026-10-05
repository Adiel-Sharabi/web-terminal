/// The one way the companion opens a modal bottom sheet (#285).
///
/// Flutter's modal sheet runs its surface to the bottom edge of the screen and
/// deliberately leaves the bottom system inset (nav bar, gesture pill, tablet
/// taskbar) for the sheet's CONTENT to honour — even `useSafeArea: true` is
/// `SafeArea(bottom: false)`. A sheet whose body forgets that draws its last
/// row under the bar, which is how the New-session sheet's Cancel/Create ended
/// up behind the Android taskbar. Doing it here, once, means no sheet body has
/// to remember.
library;

import 'package:flutter/material.dart';

/// Shows a modal bottom sheet whose content always sits above the system bars.
///
/// * `useSafeArea: true` keeps the sheet clear of the status bar and of a
///   side nav bar in landscape.
/// * The builder's content is wrapped in a bottom-only [SafeArea] INSIDE the
///   sheet's Material, so the surface still extends behind the nav bar while
///   the content is lifted above it.
///
/// No double padding with the keyboard: `MediaQuery.padding.bottom` is the
/// part of the system inset the keyboard does NOT already cover, so a body
/// that pads by `viewInsets.bottom` (the forms do) gets 0 from here while the
/// keyboard is up, and only the nav-bar inset while it is down.
Future<T?> showAppBottomSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = false,
  bool showDragHandle = true,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: isScrollControlled,
    showDragHandle: showDragHandle,
    useSafeArea: true,
    builder: (sheetContext) => SafeArea(
      top: false,
      child: Builder(builder: builder),
    ),
  );
}
