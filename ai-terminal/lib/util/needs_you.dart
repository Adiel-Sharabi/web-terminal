// What a session owes the person, read from the server's own fields (#337). The sessions
// board's Needs-you column and the questions inbox (#383) both sort by these rules, so
// they live here, once, and the board re-exports them.

import '../api/models.dart';

/// Owes the person something: a live prompt, or the agent said it is their move.
/// A panel over the composer (#316) owes the person an Esc as much as a prompt owes an
/// answer, so it is "needs you" too.
bool boardNeedsYou(Session s) =>
    s.status == 'waiting' || s.reason?.kind == 'you' || s.reason?.kind == 'menu';

/// Hidden from the board (#314).
bool boardIsHidden(Session s) => s.brief?.hidden == true;

/// What a Needs-you card is waiting for, which decides its inline control.
enum NeedKind { question, permission, menu, reported, other }

/// The kind of need, from the server's own fields: `waitingFor` (#79) first, because
/// a live prompt is what actually blocks the agent, then the reason (#313/#316).
NeedKind needKindOf(Session s) {
  if (s.status == 'waiting') {
    if (s.waitingFor == 'question') return NeedKind.question;
    if (s.waitingFor == 'permission') return NeedKind.permission;
  }
  if (s.reason?.kind == 'menu') return NeedKind.menu;
  if (s.reason?.kind == 'you') return NeedKind.reported;
  return NeedKind.other;
}
