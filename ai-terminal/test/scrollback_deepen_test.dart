// #167 — the companion's terminal repeated whole blocks of output, and
// "scrolling made it worse".
//
// THE MECHANISM, and why these tests look the way they do. The background
// deepening (#127) walks backwards through `GET /api/sessions/:id/scrollback`
// carrying an ABSOLUTE byte offset from one request to the next — into a buffer
// whose HEAD `pty-worker.js` trims on every PTY write (2 MB cap). So each step's
// window has slid forward by exactly the bytes the session emitted since the
// previous step, and re-harvests that much content already on screen. Nothing in
// the response can reveal it: `total` sits pinned at the cap and offset 0 quietly
// means a different byte every time.
//
// So the fixture that matters is not a big scrollback — it is a scrollback that
// TRIMS ITS HEAD BETWEEN CALLS. [_SlidingScrollback] below mirrors
// `trimScrollback` + the server's slicing arithmetic exactly, and the walk is
// driven through the real rules in `ScrollbackWindow`. The assertion is on the
// harvested TEXT, not on a screenshot: every synthetic token must appear exactly
// once, which fails on a duplicate AND on a hole.
//
// The second defect is a rendering one and needs a real terminal: `_deepenOnce`
// harvested EVERY line of its scratch terminal and trimmed only trailing BLANK
// lines. A TUI frame is not blank, so the scratch's viewport — the screen as of
// the byte the slice stops at, which the text below it immediately repaints —
// was stamped into the scrollback at every seam. See the seam group.
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/util/scrollback_window.dart';

/// The server's scrollback as the client actually meets it: an append-only
/// stream of which only the newest [capacity] code units are retained.
///
/// [emit] is `pty-worker.js` `writeScrollback` + `trimScrollback` (head-first
/// drop at `MAX_SCROLLBACK_SIZE`); [fetch] is `server.js`'s
/// `GET /api/sessions/:id/scrollback` slicing arithmetic, verbatim:
/// `start = min(offset, total)`, `end = min(start + limit, total)`.
class _SlidingScrollback {
  _SlidingScrollback(this.capacity);

  /// How much the server keeps.
  final int capacity;

  /// Everything ever emitted — the ground truth the harvest is checked against.
  final StringBuffer _emitted = StringBuffer();

  /// What the server would still serve.
  String _retained = '';

  /// How many requests have been served, so a test can prove the walk ran.
  int fetches = 0;

  String get emitted => _emitted.toString();

  void emit(String data) {
    _emitted.write(data);
    _retained += data;
    if (_retained.length > capacity) {
      _retained = _retained.substring(_retained.length - capacity);
    }
  }

  ({String data, int total, int offset}) fetch(int offset, int limit) {
    fetches++;
    final total = _retained.length;
    final start = offset < total ? offset : total;
    final wanted = start + limit;
    final end = wanted < total ? wanted : total;
    return (data: _retained.substring(start, end), total: total, offset: start);
  }
}

/// One synthetic line, uniquely identifiable in the harvested text.
String _line(int i) => '<<T${i.toString().padLeft(6, '0')}>> ordinary output\r\n';

final RegExp _token = RegExp(r'<<T\d{6}>>');

/// Runs the real walk — attach replay, then deepening steps — against [server],
/// calling [drift] before each step and emitting whatever it returns, the way a
/// live session emits output between one step and the next.
///
/// Returns the harvested text oldest-first: every deepened slice in walk order,
/// reversed, followed by the attach replay. That concatenation is what the
/// terminal ends up holding, and it must be a contiguous stretch of
/// [_SlidingScrollback.emitted].
({String joined, List<String> older, String replay, ScrollbackWindow window})
    _walk(
  _SlidingScrollback server, {
  required int replayBytes,
  required int stepBytes,
  required int anchorBytes,
  String Function(int step)? drift,
  int maxSteps = 100,
}) {
  final window =
      ScrollbackWindow(stepBytes: stepBytes, anchorBytes: anchorBytes);
  window.reset();

  // _attach: one cheap probe for `total`, then the tail.
  final head = server.fetch(0, 1);
  final replayFrom = scrollbackTailOffset(head.total, replayBytes);
  final chunk = server.fetch(replayFrom, replayBytes);
  window.noteReplay(data: chunk.data, offset: chunk.offset);

  final older = <String>[];
  for (var step = 0; step < maxSteps; step++) {
    final request = window.nextRequest();
    if (request == null) break;
    // Live output lands between one step and the next — this is the whole bug.
    final noise = drift?.call(step);
    if (noise != null) server.emit(noise);
    final res = server.fetch(request.offset, request.limit);
    final text = window.consume(
      data: res.data,
      offset: res.offset,
      generation: request.generation,
    );
    if (text.isNotEmpty) older.add(text);
  }

  final joined = older.reversed.join() + chunk.data;
  return (joined: joined, older: older, replay: chunk.data, window: window);
}

Map<String, int> _tokenCounts(String text) {
  final counts = <String, int>{};
  for (final m in _token.allMatches(text)) {
    counts[m.group(0)!] = (counts[m.group(0)!] ?? 0) + 1;
  }
  return counts;
}

List<String> _linesOf(Terminal t) {
  final out = <String>[];
  for (var i = 0; i < t.buffer.lines.length; i++) {
    out.add(t.buffer.lines[i].getText().trimRight());
  }
  return out;
}

void main() {
  group('the walk over a scrollback whose head trims underneath it (#167)', () {
    test('every emitted token is harvested EXACTLY ONCE', () {
      final server = _SlidingScrollback(20000);
      for (var i = 0; i < 2000; i++) {
        server.emit(_line(i));
      }
      var next = 2000;

      final walk = _walk(
        server,
        replayBytes: 4000,
        stepBytes: 4000,
        anchorBytes: 400,
        // 1500 code units per step: roughly 40 lines of fresh output between
        // one deepening step and the next, which a busy agent session emits in
        // far less than the 900 ms gap.
        drift: (_) {
          final b = StringBuffer();
          while (b.length < 1500) {
            b.write(_line(next++));
          }
          return b.toString();
        },
      );

      expect(server.fetches, greaterThan(3),
          reason: 'the walk has to actually run for this to prove anything');
      expect(walk.older, isNotEmpty);
      expect(walk.joined.length, greaterThan(walk.replay.length * 2),
          reason: 'the deepening must have added real history');

      final duplicated = _tokenCounts(walk.joined)
        ..removeWhere((_, count) => count == 1);
      expect(duplicated, isEmpty,
          reason: 'a token harvested twice is a block of output shown twice — '
              'the reported bug');
    });

    test('the harvest is a CONTIGUOUS stretch of what the PTY printed', () {
      // The strictest statement of the same rule: no duplicate (which would
      // break contiguity) and no hole (ditto). Checked against the full emitted
      // stream, not against the window the server happens to still hold.
      final server = _SlidingScrollback(20000);
      for (var i = 0; i < 2000; i++) {
        server.emit(_line(i));
      }
      var next = 2000;

      final walk = _walk(
        server,
        replayBytes: 4000,
        stepBytes: 4000,
        anchorBytes: 400,
        drift: (_) => _line(next++) + _line(next++),
      );

      expect(server.emitted.contains(walk.joined), isTrue,
          reason: 'the harvested text is not a stretch of the real stream — it '
              'either repeats something or skips something');
    });

    test('a still buffer harvests the whole history, seam to seam', () {
      // No drift: the offsets never lie, so nothing may be lost either. Guards
      // the fix against "solving" duplication by throwing history away.
      final server = _SlidingScrollback(1 << 20);
      for (var i = 0; i < 400; i++) {
        server.emit(_line(i));
      }

      final walk = _walk(
        server,
        replayBytes: 4000,
        stepBytes: 4000,
        anchorBytes: 400,
      );

      expect(walk.window.exhausted, isTrue);
      expect(walk.joined, server.emitted,
          reason: 'with a stable buffer the walk must reconstruct the stream '
              'exactly — every byte, once');
    });

    test('the walk STOPS rather than guess when the buffer outruns the overlap',
        () {
      // A whole step of drift inside one gap: the anchor is no longer anywhere
      // in the slice, so where the boundary lies is unknown. Keeping the slice
      // would duplicate; skipping it while advancing would leave a silent hole.
      final server = _SlidingScrollback(20000);
      for (var i = 0; i < 2000; i++) {
        server.emit(_line(i));
      }
      var next = 2000;

      final walk = _walk(
        server,
        replayBytes: 4000,
        stepBytes: 4000,
        anchorBytes: 400,
        drift: (_) {
          final b = StringBuffer();
          while (b.length < 6000) {
            b.write(_line(next++));
          }
          return b.toString();
        },
      );

      expect(walk.window.exhausted, isTrue);
      final duplicated = _tokenCounts(walk.joined)
        ..removeWhere((_, count) => count == 1);
      expect(duplicated, isEmpty);
      expect(server.emitted.contains(walk.joined), isTrue);
    });
  });

  group('a response that outlived its attach (#167 / #147 shape)', () {
    /// [count] distinct lines of synthetic output starting at [from], so the
    /// anchor taken off the head of it is not self-similar. `'BBBB' * 200`
    /// would be: its own first 400 characters occur at every offset in it, and
    /// a cut rule has nothing to lock onto.
    String body(int from, int count) =>
        List.generate(count, (i) => _line(from + i)).join();

    test('is discarded instead of overwriting the freshly-reset walk', () {
      // _attach cancels the deepen TIMER but cannot cancel a request already in
      // flight. Without the generation stamp its `offset` lands on the new walk,
      // leaving a hole in history and restarting from the wrong place — and
      // this fires on every app resume.
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      window.noteReplay(data: body(9000, 100), offset: 100000);
      final inFlight = window.nextRequest()!;

      // The app resumes: _attach clears the terminal and replays afresh.
      window.reset();
      window.noteReplay(data: body(5000, 100), offset: 50000);
      final earliestAfterAttach = window.earliest;
      final anchorAfterAttach = window.anchor;

      final stale = window.consume(
        data: body(1000, 100),
        offset: 96000,
        generation: inFlight.generation,
      );

      expect(stale, isEmpty, reason: 'stale text must not be prepended');
      expect(window.earliest, earliestAfterAttach,
          reason: 'a stale response must not move the new walk');
      expect(window.anchor, anchorAfterAttach,
          reason: "nor replace the new walk's anchor");
    });

    test('the request issued after the attach is honoured', () {
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      window.noteReplay(data: body(9000, 100), offset: 100000);
      window.reset();
      final replay = body(5000, 100);
      window.noteReplay(data: replay, offset: 50000);

      final fresh = window.nextRequest()!;
      expect(fresh.offset, 46000);
      expect(fresh.limit, 4400,
          reason: 'the step, plus the deliberate anchor over-fetch');

      // What the server would return for that range: 4000 code units of older
      // text, then the 400 the client already holds.
      final older = body(4000, 200).substring(0, 4000);
      final text = window.consume(
        data: older + replay.substring(0, 400),
        offset: 46000,
        generation: fresh.generation,
      );
      expect(text, older);
    });
  });

  group('olderLineLimit — a scratch viewport is a frame, not history', () {
    test('drops exactly the viewport', () {
      expect(olderLineLimit(200, 38), 162);
    });

    test('a slice shorter than one screen harvests nothing', () {
      expect(olderLineLimit(38, 38), 0);
      expect(olderLineLimit(10, 38), 0);
      expect(olderLineLimit(0, 24), 0);
    });
  });

  group('the seam — attach + deepen must equal ONE contiguous replay', () {
    test('a full-screen repaint at the boundary is not stamped twice', () {
      const cols = 52;
      const rows = 38;

      // Older history, then a full-screen repaint that the newer half opens
      // with — the shape of an agent TUI panel (`/context`, a spinner) being
      // redrawn, which is exactly what the report showed stacked three deep.
      final older = StringBuffer();
      for (var i = 0; i < 200; i++) {
        older.write(_line(i));
      }
      final newer = StringBuffer();
      newer.write('\x1b[H');
      for (var r = 0; r < rows; r++) {
        newer.write('PANEL row ${r.toString().padLeft(2, '0')}\x1b[K\r\n');
      }
      for (var i = 200; i < 300; i++) {
        newer.write(_line(i));
      }

      final server = _SlidingScrollback(1 << 20);
      server.emit(older.toString());
      server.emit(newer.toString());

      // One contiguous replay of the same bytes — the reference rendering.
      final whole = Terminal(maxLines: 100000)..resize(cols, rows);
      whole.write(server.emitted);
      final reference = _linesOf(whole);

      // The real walk: replay the newest slice, then deepen once.
      final walk = _walk(
        server,
        replayBytes: newer.length,
        stepBytes: 1 << 20,
        anchorBytes: 400,
      );
      expect(walk.older, hasLength(1));

      final live = Terminal(maxLines: 100000)..resize(cols, rows);
      live.write(walk.replay);

      final scratch = Terminal(maxLines: 100000)..resize(cols, rows);
      scratch.write(walk.older.single);
      final scratchLines = _linesOf(scratch);
      final harvested = scratchLines.sublist(
          0, olderLineLimit(scratchLines.length, scratch.viewHeight));

      expect([...harvested, ..._linesOf(live)], reference,
          reason: 'the deepened history must render the same as if the whole '
              'byte range had been replayed in one go');
    });
  });
}
