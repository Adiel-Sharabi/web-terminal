import 'dart:async';

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:flutter_test/flutter_test.dart';

const _server =
    ServerConfig(name: 'Home', baseUrl: 'http://x:7785', bearerToken: 'tok');

/// A controllable fake transport standing in for the real WebSocket.
class _FakeSocket implements TerminalSocket {
  _FakeSocket({this.failReady = false, this.failAdd = false});

  final bool failReady;

  /// Writes throw — a socket that connected but died before the flush reached it.
  final bool failAdd;
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
  void add(Object data) {
    if (failAdd) throw StateError('socket is closing');
    sent.add(data);
  }

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

    // #63 — a long compose submit made in the reconnect window must arrive WHOLE. The old
    // offline buffer truncated it to fit an 8KB cap (`substring(0, room)`), so the agent got
    // a half-prompt with the tail silently missing — the exact reported symptom. A single
    // submit is now flushed intact however long it is; the cap only bounds ACCUMULATION.
    test('a single long offline submit is flushed WHOLE, never truncated (#63)',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      await pump();
      s1.serverDrop();
      await pump(15); // offline window (before the 80ms reconnect)
      final long = 'x' * 10000; // well past the 8KB cap
      conn.sendInput(long);
      await pump(120);

      final flushed =
          s2.sentStrings.firstWhere((s) => s.startsWith('x'), orElse: () => '');
      expect(flushed, long,
          reason: 'the whole prompt must arrive — no tail dropped to fit the cap');
      conn.close();
    });

    // The cap still does its job: it bounds ACCUMULATED offline input so a sustained outage
    // can't grow the buffer without limit. It evicts whole OLDEST writes (never cutting a
    // write), and always keeps the newest submit — the thing the user just did.
    test('bounds accumulation by evicting whole oldest writes, keeping the newest',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      await pump();
      s1.serverDrop();
      await pump(15); // offline window
      conn.sendInput('A' * 5000); // oldest — evicted to stay bounded
      conn.sendInput('B' * 5000); // newest — survives whole (5000+5000 > 8192)
      await pump(120);

      final flushed =
          s2.sentStrings.firstWhere((s) => s.contains('B'), orElse: () => '');
      expect(flushed, 'B' * 5000,
          reason: 'oldest whole write evicted; newest submit kept intact, never split');
      expect(flushed.contains('A'), isFalse);
      conn.close();
    });

    // #193 — the old guard was `_inputWrites.length > 1`: it evicted whole writes
    // from the front until exactly one remained, with no regard for WHICH one that
    // left behind. A paste queued while offline is a single whole write already over
    // the cap on its own; any later write — even one character typed next — pushed
    // the total back over budget and evicted the paste (the oldest entry) whole to
    // make room for it. Reported as "a 20KB paste followed by any later write is
    // dropped entirely." The cap must keep bounding ordinary accumulation (many small
    // writes), but a write that already exceeds the cap alone is never the one to
    // evict — it survives, and the buffer is allowed to sit over cap rather than
    // silently lose it.
    test('a big paste survives a later, smaller write queued behind it (#193)',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      await pump();
      s1.serverDrop();
      await pump(15); // offline window
      final paste = 'P' * 20000; // a single write already over the 8KB cap alone
      conn.sendInput(paste);
      conn.sendInput('x'); // a later, smaller write queued in the same outage
      await pump(120);

      final flushed =
          s2.sentStrings.firstWhere((s) => s.contains('P'), orElse: () => '');
      expect(flushed, paste,
          reason: 'a write already over the cap on its own must never be evicted '
              'just because something small queued up behind it');
      conn.close();
    });

    // #193 review — exempting an oversized write from the ORDINARY cap must not mean
    // NO bound at all. Fifteen 20KB pastes queued in one outage (300,000 bytes, every
    // one over the 8KB per-write cap, and over the 256KB hard ceiling too) would sit in
    // memory forever under a rule that simply never evicts an oversized write. The HARD
    // ceiling bounds the buffer even when nothing in it fits under the ordinary cap:
    // past it, eviction is plain oldest-first with no exemption, and each write lost
    // that way is reported on [inputDropped] — the same channel the server's 64KB WS
    // cap uses — so this loss is visible too, never silent.
    test('a hard ceiling bounds MANY large pastes in one outage; oldest lost, and reported (#193)',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      final dropped = <int>[];
      conn.inputDropped.listen(dropped.add);
      await pump();
      s1.serverDrop();
      await pump(15); // offline window

      // 15 distinct 20KB pastes — 300,000 bytes total, comfortably past the 256KB hard
      // ceiling. Distinct letters so "which ones survived" is checkable.
      final pastes = List.generate(15, (n) => String.fromCharCode(65 + n) * 20000);
      for (final p in pastes) {
        conn.sendInput(p);
      }
      await pump(120);

      final flushed = s2.sentStrings.join();
      expect(flushed.length, lessThan(pastes.join().length),
          reason: 'the buffer must not grow to hold all fifteen — some must be evicted');
      expect(flushed, contains(pastes.last),
          reason: 'the newest write always survives');
      expect(flushed.contains(pastes.first), isFalse,
          reason: 'oldest-first: the earliest pastes are the ones sacrificed');
      expect(dropped, isNotEmpty,
          reason: 'a write lost to the hard ceiling must be reported, not silent');
      conn.close();
    });

    // Buffering the prompt is only half the promise — the flush has to actually land.
    // _flushInput used to empty the buffer and THEN write inside a bare `catch (_) {}`,
    // so a write onto a socket that had just gone away threw, was swallowed, and took
    // the user's prompt with it: no error, no retry, nothing left to resend. A dropped
    // whole write is exactly the shape of "my long prompt arrived with the beginning
    // missing", so the buffer must survive a failed flush.
    test('a flush whose write FAILS keeps the input buffered for the next one',
        () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket(failAdd: true); // reconnects, but the write throws
      final s3 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          socketFactory: (_) => <_FakeSocket>[s1, s2, s3][i++],
          reconnectBackoff: _slowBackoff);
      await pump();
      s1.serverDrop();
      await pump(15); // offline window
      conn.sendInput('the-whole-long-prompt');
      await pump(120); // reconnect onto s2 — flush throws

      expect(s2.sentStrings.join(), isNot(contains('the-whole-long-prompt')),
          reason: 'the failing socket never received it');

      s2.serverDrop();
      await pump(150); // reconnect onto s3 — the flush must be RETRIED

      expect(s3.sentStrings.join(), contains('the-whole-long-prompt'),
          reason: 'a failed flush is retried, never silently discarded');
      conn.close();
    });
  });

  // #59 — a PTY has ONE size, shared by every viewer. A connection that never states
  // its own inherits whatever the last viewer set, so a phone attaching to a session a
  // desktop is watching renders desktop-width output, torn, until some unrelated
  // relayout happens to fire a resize. The size must be stated in the HANDSHAKE.
  group('#59 the connection states its size on connect', () {
    test('a connection opened with a size sends resize in the connect handshake',
        () async {
      final s1 = _FakeSocket();
      final conn = TerminalConnection(_server, 's',
          cols: 52, rows: 30, socketFactory: (_) => s1);
      await pump();

      // No resize() call was ever made — this must come from the handshake alone.
      expect(
        s1.sentStrings.where((s) => s.contains('"resize"')),
        contains(contains('"cols":52')),
        reason: 'the PTY must learn our size at connect, not at the next relayout',
      );
      conn.close();
    });

    test('with no size, the handshake states none (nothing to invent)', () async {
      final s1 = _FakeSocket();
      final conn = TerminalConnection(_server, 's', socketFactory: (_) => s1);
      await pump();

      expect(s1.sentStrings.where((s) => s.contains('"resize"')), isEmpty);
      conn.close();
    });

    test('a seeded connection can answer the proxy\'s requestResize immediately',
        () async {
      // The cluster proxy asks the client to re-state its size whenever the REMOTE
      // socket connects (server.js: `localWs.send({requestResize:true})`), precisely
      // so the remote PTY matches this client. A connection with no size silently
      // ignored that request — which is why a remotely-viewed session was the worst
      // case. Seeded, it can answer from the very first socket.
      final s1 = _FakeSocket();
      final conn = TerminalConnection(_server, 's',
          cols: 52, rows: 30, socketFactory: (_) => s1);
      await pump();
      s1.sent.clear();

      s1.serverSend('{"requestResize":true}');
      await pump();

      expect(
        s1.sentStrings.where((s) => s.contains('"resize"')),
        contains(contains('"cols":52')),
        reason: 'the proxy asked for our size; we must be able to answer',
      );
      conn.close();
    });

    test('an UNSEEDED connection cannot answer requestResize — the #59 bug', () async {
      final s1 = _FakeSocket();
      final conn = TerminalConnection(_server, 's', socketFactory: (_) => s1);
      await pump();
      s1.sent.clear();

      s1.serverSend('{"requestResize":true}');
      await pump();

      expect(s1.sentStrings.where((s) => s.contains('"resize"')), isEmpty,
          reason: 'documents WHY the size must be seeded: with none, we stay silent');
      conn.close();
    });

    test('the seeded size is replayed on reconnect', () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          cols: 52,
          rows: 30,
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      await pump();
      s1.serverDrop();
      await pump(120);

      expect(s2.sentStrings.where((s) => s.contains('"resize"')),
          contains(contains('"cols":52')));
      conn.close();
    });

    test('a real resize supersedes the seed', () async {
      final s1 = _FakeSocket();
      final s2 = _FakeSocket();
      var i = 0;
      final conn = TerminalConnection(_server, 's',
          cols: 52,
          rows: 30,
          socketFactory: (_) => i++ == 0 ? s1 : s2,
          reconnectBackoff: _slowBackoff);
      await pump();
      conn.resize(120, 40); // the view actually relaid out
      s1.serverDrop();
      await pump(120);

      final replayed =
          s2.sentStrings.where((s) => s.contains('"resize"')).toList();
      expect(replayed, contains(contains('"cols":120')));
      expect(replayed.any((s) => s.contains('"cols":52')), isFalse,
          reason: 'the stale seed must not outlive a real measurement');
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

    // #193 — the server's 64KB WS input cap used to refuse an oversized write with a
    // server-side log only; nothing told the client. It now echoes a bare
    // `{"inputDropped":true,"bytes":N}` frame back on this same socket, and the byte
    // count must reach a listener rather than being written to the terminal as text.
    test('inputDropped is parsed off the wire, forwarded on its own stream, '
        'and never reaches output', () async {
      final s1 = _FakeSocket();
      final conn = TerminalConnection(_server, 's', socketFactory: (_) => s1);
      final out = <String>[];
      final dropped = <int>[];
      conn.output.listen(out.add);
      conn.inputDropped.listen(dropped.add);
      await pump();

      s1.serverSend('{"inputDropped":true,"bytes":70123}');
      await pump();

      expect(dropped, [70123]);
      expect(out, isEmpty, reason: 'the control frame must not be typed as PTY output');
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
