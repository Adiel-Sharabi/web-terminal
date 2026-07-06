import 'dart:async';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

/// A controllable fake transport standing in for the real WebSocket.
class _FakeSocket implements TerminalSocket {
  _FakeSocket({this.failReady = false});

  final bool failReady;
  final StreamController<dynamic> _incoming = StreamController<dynamic>();

  /// Frames the client sent to us (keystrokes + JSON control frames).
  final List<Object> sent = <Object>[];

  // Lazily produced so the error is created only when awaited by _connect,
  // never left dangling as an unhandled async error.
  @override
  Future<void> get ready => failReady
      ? Future<void>.error(Exception('connect failed'))
      : Future<void>.value();

  @override
  Stream<dynamic> get stream => _incoming.stream;

  @override
  void add(Object data) => sent.add(data);

  @override
  Future<void> close() async {
    if (!_incoming.isClosed) await _incoming.close();
  }

  List<String> get sentStrings => sent.whereType<String>().toList();

  void serverSend(dynamic data) {
    if (!_incoming.isClosed) _incoming.add(data);
  }

  void serverDrop() {
    if (!_incoming.isClosed) _incoming.close(); // → onDone in the connection
  }
}

Future<void> pump([int ms = 8]) => Future<void>.delayed(Duration(milliseconds: ms));

const _fastBackoff = [Duration(milliseconds: 5)];
// Slow enough that a short pump lands in the offline window before reconnect.
const _slowBackoff = [Duration(milliseconds: 80)];

void main() {
  group('TerminalConnection heartbeat', () {
    test('sends {"heartbeat":true} while connected', () async {
      final sock = _FakeSocket();
      final conn = TerminalConnection(
        _server,
        's',
        socketFactory: (_) => sock,
        heartbeatInterval: const Duration(milliseconds: 8),
      );
      await pump(45);
      expect(sock.sentStrings.where((s) => s.startsWith('{"heartbeat"')),
          isNotEmpty);
      conn.close();
    });
  });

  group('TerminalConnection connected semantics', () {
    test('first connect emits true, no reconnected event', () async {
      final sock = _FakeSocket();
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => sock, reconnectBackoff: _fastBackoff);
      final connected = <bool>[];
      final reconnects = <void>[];
      conn.connected.listen(connected.add);
      conn.reconnected.listen((_) => reconnects.add(null));
      await pump();
      expect(connected, [true]);
      expect(reconnects, isEmpty);
      conn.close();
    });

    test('quick reconnect after a drop: no false, reconnected fires once',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _fastBackoff);
      final connected = <bool>[];
      final reconnects = <void>[];
      conn.connected.listen(connected.add);
      conn.reconnected.listen((_) => reconnects.add(null));

      await pump();
      expect(connected, [true]);
      s1.serverDrop();
      await pump(40);

      expect(connected, [true], reason: 'a blip must not emit false');
      expect(reconnects.length, 1);
      conn.close();
    });

    test('failed reconnect emits false, later success emits true+reconnected',
        () async {
      final seq = [_FakeSocket(), _FakeSocket(failReady: true), _FakeSocket()];
      var i = 0;
      final conn = TerminalConnection(_server, 's', socketFactory: (_) {
        final idx = i < seq.length ? i : seq.length - 1;
        i++;
        return seq[idx];
      }, reconnectBackoff: _fastBackoff);
      final connected = <bool>[];
      final reconnects = <void>[];
      conn.connected.listen(connected.add);
      conn.reconnected.listen((_) => reconnects.add(null));

      await pump();
      expect(connected, [true]);
      seq[0].serverDrop(); // → reconnect to the failing socket → false → retry
      await pump(60);

      expect(connected, [true, false, true]);
      expect(reconnects.length, 1);
      conn.close();
    });
  });

  group('TerminalConnection input buffering + state replay', () {
    test('buffers offline input and replays mode/resize on reconnect',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);

      await pump();
      conn.setMode('active');
      conn.resize(100, 40);
      s1.serverDrop();
      await pump(15); // offline window (before the 80ms reconnect)
      conn.sendInput('typed-while-offline');
      await pump(120);

      final out = s2.sentStrings;
      expect(out, contains('typed-while-offline'),
          reason: 'buffered input flushed on reconnect');
      expect(out.any((s) => s.contains('"mode":"active"')), isTrue,
          reason: 'mode replayed on reconnect');
      expect(out.any((s) => s.contains('"resize"')), isTrue,
          reason: 'resize replayed on reconnect');
      conn.close();
    });

    test('caps the offline input buffer at 8KB', () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      await pump();
      s1.serverDrop();
      await pump(15); // offline window (before the 80ms reconnect)
      conn.sendInput('a' * 10000); // exceeds the 8KB cap
      await pump(120);

      final flushed =
          s2.sentStrings.firstWhere((s) => s.startsWith('a'), orElse: () => '');
      expect(flushed.length, 8192);
      conn.close();
    });
  });

  group('TerminalConnection control frames', () {
    test('filters heartbeat/requestResize; forwards real output', () async {
      final s1 = _FakeSocket();
      final conn =
          TerminalConnection(_server, 's', socketFactory: (_) => s1);
      final out = <String>[];
      conn.output.listen(out.add);
      await pump();
      conn.resize(80, 24);
      s1.serverSend('{"heartbeat":1}');
      s1.serverSend('{"requestResize":true}');
      s1.serverSend('hello world');
      await pump();

      expect(out, ['hello world']);
      expect(s1.sentStrings.where((s) => s.contains('"resize"')), isNotEmpty,
          reason: 'requestResize triggers a resize reply');
      conn.close();
    });

    test('sessionTaken stops reconnect, emits false, is not forwarded',
        () async {
      final s1 = _FakeSocket();
      var calls = 0;
      final conn = TerminalConnection(_server, 's', socketFactory: (_) {
        calls++;
        return s1;
      }, reconnectBackoff: _fastBackoff);
      final out = <String>[];
      final connected = <bool>[];
      conn.output.listen(out.add);
      conn.connected.listen(connected.add);

      await pump();
      expect(calls, 1);
      expect(conn.sessionTaken, isFalse);
      s1.serverSend('{"sessionTaken":"Home"}');
      await pump(40);

      expect(out, isEmpty);
      expect(connected, [true, false]);
      expect(conn.sessionTaken, isTrue);
      expect(calls, 1, reason: 'must not reconnect to a taken session');
      conn.close();
    });
  });

  group('TerminalConnection backoff', () {
    test('keeps retrying a failing connect', () async {
      var calls = 0;
      final conn = TerminalConnection(_server, 's', socketFactory: (_) {
        calls++;
        return _FakeSocket(failReady: true);
      }, reconnectBackoff: const [Duration(milliseconds: 3)]);
      final connected = <bool>[];
      conn.connected.listen(connected.add);

      await pump(45);
      expect(calls, greaterThan(1));
      expect(connected, contains(false));
      conn.close();
    });
  });
}
