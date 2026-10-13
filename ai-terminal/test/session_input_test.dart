// #337 review - the board's input helper (`services/session_input.dart`), driven for
// real down to the socket. Every board widget test injects a fake runner, so these are
// the only tests that hold the helper's own rules:
//
//  * the socket goes ACTIVE before any input (a background socket's input is dropped
//    by the server);
//  * it never states a size (the PTY's size is the smallest ACTIVE viewer's, #146, so
//    a board press must not shrink a session someone is reading);
//  * one write is one frame;
//  * nothing is written until the server has ATTACHED the socket, which it proves by
//    replaying the scrollback; a socket closed before that (the session ended between
//    the poll and the press) reports false, so the caller keeps the person's words.
import 'dart:async';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/services/session_input.dart';
import 'package:flutter_test/flutter_test.dart';

const _server = ServerConfig(name: 'Home', baseUrl: 'http://h:7681', bearerToken: 'tok');

const _session = Session(
  id: 's1',
  name: 's1',
  cwd: '/w',
  status: 'working',
  claudeSessionId: null,
  lastActivity: null,
  notifyLevel: 'important',
  server: _server,
);

/// A socket that records every frame it is given. With [attach], the server's
/// scrollback replay is waiting on it, as after a successful worker attach; without,
/// the server closes it straight away, as it does when the session has ended.
class _FakeSocket implements TerminalSocket {
  _FakeSocket({required bool attach}) {
    if (attach) {
      _in.add('scrollback replay');
    } else {
      unawaited(_in.close());
    }
  }

  // Single-subscription, so the replay waits until the connection listens.
  final StreamController<dynamic> _in = StreamController<dynamic>();
  final List<String> sent = [];

  @override
  Future<void> get ready => Future<void>.value();

  @override
  Stream<dynamic> get stream => _in.stream;

  @override
  void add(Object data) => sent.add(data as String);

  @override
  Future<void> close() async {
    if (!_in.isClosed) await _in.close();
  }
}

void main() {
  late List<_FakeSocket> sockets;
  late bool attach;

  TerminalSocket factory(Uri uri) {
    final s = _FakeSocket(attach: attach);
    sockets.add(s);
    return s;
  }

  setUp(() {
    sockets = [];
    attach = true;
  });

  List<String> allFrames() => [for (final s in sockets) ...s.sent];

  test('mode ACTIVE goes out before the input, as one frame per write, and no size is ever sent', () async {
    final ok = await runWithSessionInput(
      _session,
      (send) async => send('positions 6 and 8\r'),
      socketFactory: factory,
      linger: Duration.zero,
    );
    expect(ok, isTrue);
    final frames = allFrames();
    final mode = frames.indexWhere((f) => f.startsWith('{"mode":"active"'));
    final input = frames.indexOf('positions 6 and 8\r');
    expect(mode, isNonNegative, reason: 'the server drops input from a background socket');
    expect(input, greaterThan(mode), reason: 'active BEFORE the input');
    expect(frames.where((f) => !f.startsWith('{')).toList(), ['positions 6 and 8\r'], reason: 'one write, one frame');
    expect(frames.where((f) => f.contains('"resize"') || f.contains('"cols"') || f.contains('"rows"')), isEmpty,
        reason: 'a board press must never vote on the PTY size (#146)');
  });

  test('two writes are two frames, in order', () async {
    await runWithSessionInput(
      _session,
      (send) async {
        send('1');
        send('\r');
      },
      socketFactory: factory,
      linger: Duration.zero,
    );
    expect(allFrames().where((f) => !f.startsWith('{')).toList(), ['1', '\r']);
  });

  test('a socket the server closes before attaching reports false and writes NOTHING', () async {
    attach = false;
    var ran = false;
    final ok = await runWithSessionInput(
      _session,
      (send) async {
        ran = true;
        send('lost words\r');
      },
      socketFactory: factory,
      attachTimeout: const Duration(milliseconds: 300),
      linger: Duration.zero,
    );
    expect(ok, isFalse, reason: 'connected is not delivered: the caller must keep the words');
    expect(ran, isFalse);
    expect(allFrames().where((f) => !f.startsWith('{')), isEmpty);
  });
}
