// #475 - the ONE rule for which sessions a list shows: every one but the dispatcher the
// Supervisor entry stands for. The dispatcher is the fleet's supervisor, not one of its
// sessions; it is never hidden, because the Supervisor entry on the session list opens it
// with its state, its cases and its decisions.
//
// A row is hidden only while that entry EXISTS for it, so the dispatcher is never in no list
// and behind no entry. The entry exists when the authority answered `found` with a dispatcher
// ([supervisorEntryId]); then exactly the row with that id is the Supervisor (a hand-off's
// successor too, before its server tags it). When the supervisor is off, the authority moved,
// or nobody answered, the row is an ordinary session the owner can open and close. Before the
// FIRST answer ([find] null) the server's own word, `role: "supervisor"`, decides, so the row
// does not flash in the list at launch.
//
// Every screen that LISTS sessions (the session list, the sessions board) reads its rows
// through [listedSessions]; nothing re-derives the test.

import 'package:flutter/widgets.dart';

import '../api/models.dart';
import '../services/supervisor_lookup.dart' show SupervisorFeed;
import 'supervisor_authority.dart';

/// The id of the dispatcher the Supervisor entry stands for in [find], or null when there is
/// no entry (no answer, supervisor off, nobody answered, or no dispatcher yet).
String? supervisorEntryId(SupervisorFind? find) => find != null && find.found ? find.state?.dispatcher?.id : null;

/// [sessions] without the dispatcher the Supervisor entry stands for, in the same order.
/// [find] is the supervisor feed's last answer, null before the first.
List<Session> listedSessions(Iterable<Session> sessions, {required SupervisorFind? find}) {
  if (find == null) return [for (final s in sessions) if (!s.isSupervisor) s];
  final id = supervisorEntryId(find);
  return [for (final s in sessions) if (id == null || s.id != id) s];
}

/// What decides which row [listedSessions] hides: null before the first answer, else the id of
/// the dispatcher the entry stands for ('' for none). A change of it changes a list.
String? supervisorListKey(SupervisorFind? find) => find == null ? null : (supervisorEntryId(find) ?? '');

/// For a State whose build reads [listedSessions] with [SupervisorFeed]'s answer: rebuilds when
/// that answer changes WHICH row is the Supervisor (not on every poll that says the same).
mixin SupervisorListWatch<T extends StatefulWidget> on State<T> {
  String? _listKey;

  @override
  void initState() {
    super.initState();
    _listKey = supervisorListKey(SupervisorFeed.instance.find);
    SupervisorFeed.instance.addListener(_onSupervisorFeed);
  }

  @override
  void dispose() {
    SupervisorFeed.instance.removeListener(_onSupervisorFeed);
    super.dispose();
  }

  void _onSupervisorFeed() {
    final key = supervisorListKey(SupervisorFeed.instance.find);
    if (key == _listKey) return;
    _listKey = key;
    if (mounted) setState(() {});
  }
}

/// The dispatcher's row among [sessions] with id [id] (the supervisor's `dispatcher.id`),
/// or, with no id, the first row that says it is the dispatcher. Null when none is listed.
Session? supervisorSessionOf(Iterable<Session> sessions, {String? id}) {
  for (final s in sessions) {
    if (id != null ? s.id == id : s.isSupervisor) return s;
  }
  return null;
}
