// Keys into a session's PTY from a surface that has no terminal open on it: the
// sessions board (#337), which answers a question, sends a reply or presses Esc for a
// session the user is not looking at.
//
// There is no REST route for input; the ONE input path is the session's WebSocket
// (`/ws/:id`), the same one the session screen writes through. So this opens a short-
// lived [TerminalConnection] on it, and two things about that socket are deliberate:
//
//  * It is set ACTIVE before anything is written. The server drops input from a
//    background socket (`server.js` handleMessage), and the connection replays the
//    mode ahead of any buffered input on connect, so the order is guaranteed.
//  * It never states a size. The PTY's size is negotiated across every ACTIVE viewer,
//    smallest wins (#146, `lib/terminal-size.js`); a socket that never sends `resize`
//    has no opinion and cannot shrink a session someone is reading elsewhere.
//  * Nothing is written until the server has ATTACHED it to the session, which it
//    proves by replaying the scrollback. A socket can connect and then be closed 4000
//    because the session ended between the poll and the press; input queued on it is
//    dropped server-side with no answer, so connected is not delivered (#337 review).
//    A session with an empty scrollback never proves it and is refused - the safe
//    direction: the words stay with the person.
//  * With `exclusiveViewer: true` in the server's config, going active here would KICK
//    the person's real viewer of that session (`sessionTaken`). The default is false.
//
// WHAT is written is never decided here: the caller passes bytes built by the owners
// (`buildAnswerFrames`, `buildComposeSubmission`, a lone Esc), and the server and worker
// apply every rule they apply to the session screen's writes (#55 submit gap, #213
// bracketing, #147 readiness, #179 verification), because it is the same socket.
library;

import 'dart:async';

import '../api/api_client.dart';
import '../api/models.dart';

/// Runs [body] with a `send` that writes keys into [session]'s PTY. Completes with
/// false when the session could not be reached and attached in time (nothing was
/// written), true once [body] has written to an attached session.
typedef SessionInputRunner = Future<bool> Function(
  Session session,
  Future<void> Function(void Function(String keys) send) body,
);

/// The production [SessionInputRunner]: a short-lived, size-less, active socket.
///
/// [socketFactory] is the test seam (the same one [TerminalConnection] has). [linger]
/// keeps the socket open briefly after [body], so the last write is on the wire
/// before the close.
Future<bool> runWithSessionInput(
  Session session,
  Future<void> Function(void Function(String keys) send) body, {
  TerminalSocketFactory? socketFactory,
  Duration attachTimeout = const Duration(seconds: 8),
  Duration linger = const Duration(milliseconds: 600),
}) async {
  // No cols/rows: this socket never votes on the PTY's size (#146).
  final conn = TerminalConnection(session.server, session.id, socketFactory: socketFactory);
  try {
    // Subscribe before anything can arrive: the first connect is asynchronous. The
    // first output IS the scrollback replay, sent only after the worker attach.
    final attached = conn.output.first.then((_) => true).timeout(attachTimeout, onTimeout: () => false);
    // Before any write: the server drops input from a background socket.
    conn.setMode('active');
    if (!await attached) return false;
    await body(conn.sendInput);
    await Future<void>.delayed(linger);
    return true;
  } catch (_) {
    return false;
  } finally {
    conn.close();
  }
}
