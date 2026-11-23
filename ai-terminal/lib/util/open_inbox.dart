// #492 - the ONE way to open the questions inbox: the dashboard's button, the journal's
// "N need you" row, an owner-wait notification tap and the phone's launch all come here.
// A wide split shows it in the detail pane; a phone pushes it over the current screen.

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../screens/questions_inbox_screen.dart';
import '../screens/session_screen.dart' show openSessionOnStack;
import '../services/session_selection.dart';

/// Opens the inbox over [nav], with [focusSessionId]'s item focused when it has one.
///
/// [showInPane] is how the caller shows it in a split's detail pane; null falls back to
/// [SessionSelection] when a split is mounted. With neither, the inbox is pushed as a
/// route. [openSession] opens a session the person picks in a PUSHED inbox (the inbox
/// route is popped first); null opens it on the app's one session stack.
void openInbox(
  NavigatorState nav, {
  String? focusSessionId,
  VoidCallback? showInPane,
  void Function(Session session)? openSession,
}) {
  final selection = SessionSelection.instance;
  if (showInPane != null && focusSessionId == null) {
    showInPane();
    return;
  }
  if (showInPane != null || selection.splitMounted) {
    selection.showInbox(focusSessionId: focusSessionId);
    return;
  }
  nav.push(
    MaterialPageRoute<void>(
      builder: (ctx) => QuestionsInboxScreen(
        focusSessionId: focusSessionId,
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
