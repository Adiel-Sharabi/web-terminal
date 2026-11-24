// #475 - the ONE way to open the Supervisor: the session list's Supervisor entry, and any
// other screen that offers it (Mission Control can call this too). A wide split shows it in
// the detail pane; a phone pushes it over the current screen.

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../screens/session_screen.dart' show openSessionOnStack;
import '../screens/supervisor_screen.dart';
import '../services/session_selection.dart';

/// Opens the Supervisor over [nav]. [showInPane] is how the caller shows it in a split's
/// detail pane; null falls back to [SessionSelection] when a split is mounted. With
/// neither, it is pushed as a route, and a session the person opens from it (the
/// dispatcher, or a case's session) pops it first; [openSession] opens that session, null
/// opens it on the app's one session stack.
void openSupervisor(
  NavigatorState nav, {
  VoidCallback? showInPane,
  void Function(Session session)? openSession,
}) {
  if (showInPane != null) {
    showInPane();
    return;
  }
  if (SessionSelection.instance.splitMounted) {
    SessionSelection.instance.showSupervisor();
    return;
  }
  nav.push(
    MaterialPageRoute<void>(
      builder: (ctx) => SupervisorScreen(
        onOpenSession: (s) {
          Navigator.of(ctx).pop();
          if (openSession != null) {
            openSession(s);
          } else {
            openSessionOnStack(nav, s.id, initialSession: s);
          }
        },
      ),
    ),
  );
}
