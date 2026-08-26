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
// The second group of tests needs a real terminal, because a seam is a RENDERING
// question: what the harvested bytes look like once xterm has parsed them, next
// to what one contiguous replay of the same bytes looks like. The two are not
// identical and deliberately are not made identical — see the seam group for the
// residual that is accepted, and `olderLineLimit` for why paying `rows - 1` real
// lines per seam to remove it was the worse trade by an order of magnitude.
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
///
/// **Two modelling gaps, stated so nobody reads more into a green run than is
/// there.** (1) It does not apply `sanitizeReplay`, which the real route runs
/// over the WHOLE buffer before slicing — so a trim boundary that splits a
/// DA/DSR sequence retains bytes the previous pass had stripped, and every tail
/// offset moves UP by that much. That is the residual behind the bound in
/// [ScrollbackWindow.consume], and it is why the bound is documented as holding
/// in practice rather than provably. (2) It trims in CODE UNITS; the real
/// `trimScrollback` slices a UTF-8 Buffer by BYTES, so a real head-drop lands on
/// a byte boundary this model cannot place. Neither gap can manufacture a
/// duplicate — both only move the boundary, and a boundary the anchor cannot
/// find stops the walk.
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

/// [count] distinct lines of synthetic output starting at [from], so the anchor
/// taken off the head of it is not self-similar. `'BBBB' * 200` would be: its
/// own first 400 characters occur at every offset in it, and a cut rule has
/// nothing to lock onto.
String _body(int from, int count) =>
    List.generate(count, (i) => _line(from + i)).join();

/// Exactly [units] code units of distinct synthetic output.
String _bodyOfLength(int from, int units) =>
    _body(from, (units / _line(0).length).ceil() + 1).substring(0, units);

/// One row of a repainted panel — 20 code units, and IDENTICAL every time, which
/// is the whole point: a TUI that redraws the same frame fills the buffer with a
/// region that repeats at a fixed period.
const String _panelRow = 'PANEL row ........\r\n';

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
    final harvest = window.consume(
      data: res.data,
      offset: res.offset,
      generation: request.generation,
    );
    // The real caller commits once it has accounted for the harvest; this
    // stand-in accounts for it by keeping the text.
    window.commit(harvest);
    if (harvest.text.isNotEmpty) older.add(harvest.text);
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

/// How many of [lines] the deepening would prepend — the shipped rule, driven
/// from a test the same way `_deepenOnce` drives it off a scratch terminal.
int _harvestOf(List<String> lines) =>
    olderLineLimit(lines.length, (i) => lines[i].trim().isEmpty);

/// The first index at which [a] and [b] differ, or their common length.
int _divergence(List<String> a, List<String> b) {
  final n = a.length < b.length ? a.length : b.length;
  for (var i = 0; i < n; i++) {
    if (a[i] != b[i]) return i;
  }
  return n;
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
    test('is discarded instead of overwriting the freshly-reset walk', () {
      // _attach cancels the deepen TIMER but cannot cancel a request already in
      // flight. Without the generation stamp its `offset` lands on the new walk,
      // leaving a hole in history and restarting from the wrong place — and
      // this fires on every app resume.
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      window.noteReplay(data: _body(9000, 100), offset: 100000);
      final inFlight = window.nextRequest()!;

      // The app resumes: _attach clears the terminal and replays afresh.
      window.reset();
      window.noteReplay(data: _body(5000, 100), offset: 50000);
      final earliestAfterAttach = window.earliest;
      final anchorAfterAttach = window.anchor;

      final stale = window.consume(
        data: _body(1000, 100),
        offset: 96000,
        generation: inFlight.generation,
      );
      window.commit(stale);

      expect(stale.text, isEmpty, reason: 'stale text must not be prepended');
      expect(window.earliest, earliestAfterAttach,
          reason: 'a stale response must not move the new walk');
      expect(window.anchor, anchorAfterAttach,
          reason: "nor replace the new walk's anchor");
    });

    test('the request issued after the attach is honoured', () {
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      window.noteReplay(data: _body(9000, 100), offset: 100000);
      window.reset();
      final replay = _body(5000, 100);
      window.noteReplay(data: replay, offset: 50000);

      final fresh = window.nextRequest()!;
      expect(fresh.offset, 46000);
      expect(fresh.limit, 4400,
          reason: 'the step, plus the deliberate anchor over-fetch');

      // What the server would return for that range: 4000 code units of older
      // text, then the 400 the client already holds.
      final older = _body(4000, 200).substring(0, 4000);
      final harvest = window.consume(
        data: older + replay.substring(0, 400),
        offset: 46000,
        generation: fresh.generation,
      );
      expect(harvest.text, older);
    });
  });

  group('the walk moves only when the CALLER commits the harvest', () {
    test('a harvest the caller never uses does not move the walk', () {
      // The caller renders the harvested text into a scratch terminal and can
      // still decide there is nothing to prepend. If folding the slice in has
      // ALREADY moved the walk past those bytes, that decision costs a silent
      // hole in the history — the exact failure this module refuses to make
      // when the anchor goes missing.
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      final replay = _body(5000, 100);
      window.noteReplay(data: replay, offset: 50000);
      final request = window.nextRequest()!;
      final older = _bodyOfLength(4000, 4000);

      final harvest = window.consume(
        data: older + replay.substring(0, 400),
        offset: 46000,
        generation: request.generation,
      );
      expect(harvest.text, older);

      expect(window.earliest, 50000,
          reason: 'the walk must not have moved before the caller committed');
      expect(window.anchor, replay.substring(0, 400),
          reason: 'nor may the anchor have been replaced');

      // The same request again: forgetting to commit costs a RE-FETCH, which is
      // harmless, where committing early would have cost history.
      final again = window.nextRequest()!;
      expect(again.offset, request.offset);
      expect(again.limit, request.limit);
    });

    test('committing moves it, and only then', () {
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      final replay = _body(5000, 100);
      window.noteReplay(data: replay, offset: 50000);
      final request = window.nextRequest()!;
      final older = _bodyOfLength(4000, 4000);

      window.commit(window.consume(
        data: older + replay.substring(0, 400),
        offset: 46000,
        generation: request.generation,
      ));

      expect(window.earliest, 46000);
      expect(window.anchor, older.substring(0, 400));
    });

    test('a harvest from an abandoned walk is ignored even if committed', () {
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      final replay = _body(5000, 100);
      window.noteReplay(data: replay, offset: 50000);
      final request = window.nextRequest()!;
      final harvest = window.consume(
        data: _bodyOfLength(4000, 4000) + replay.substring(0, 400),
        offset: 46000,
        generation: request.generation,
      );

      // The app resumes between consume and commit.
      window.reset();
      window.noteReplay(data: _body(1000, 100), offset: 20000);
      window.commit(harvest);

      expect(window.earliest, 20000);
    });
  });

  group('the cut cannot be trusted inside a SELF-SIMILAR region', () {
    // `lastIndexOf(previous, limit)` takes the LAST match at or before the
    // bound, and the bound is an upper bound that includes the drift. So any
    // byte-identical repeat of the anchor between the true boundary and the
    // bound wins, and the slice keeps text that is already on screen — the
    // reported bug, produced by the rule that exists to prevent it. Measured
    // with exact server-side bookkeeping: a repainted 180-unit panel gave 3
    // wrong cuts in 9 steps and 16,650 duplicated units; a run of blank lines
    // gave 1 in 9 and 5,000.
    //
    // A periodic region is therefore one where the cut is UNKNOWABLE, and the
    // module's own philosophy already says what to do with an unknowable
    // boundary: stop.

    test('a repainted panel does not get cut on a false anchor match', () {
      final window = ScrollbackWindow(stepBytes: 1000, anchorBytes: 40);
      // The screen holds a repainting panel; its head anchor is two rows, and
      // those two rows occur at every even multiple of the row width.
      window.noteReplay(data: _panelRow * 50, offset: 1000);
      final request = window.nextRequest()!;

      final harvest = window.consume(
        data: _panelRow * 100,
        offset: 0,
        generation: request.generation,
      );

      expect(harvest.text, isEmpty,
          reason: 'the anchor matches at every period, so WHERE the older text '
              'ends is unknown — keeping the slice duplicates whatever part of '
              'it is already on screen');
      expect(window.exhausted, isTrue,
          reason: 'an untrustworthy cut stops the walk, like a missing anchor');
    });

    test('a run of blank lines does not get cut on a false anchor match', () {
      final window = ScrollbackWindow(stepBytes: 1000, anchorBytes: 40);
      // A quiet agent prints nothing but newlines; the anchor is 20 blank
      // lines, which occur at every even offset inside the run.
      window.noteReplay(data: '\r\n' * 500, offset: 1500);
      final request = window.nextRequest()!;

      final harvest = window.consume(
        data: _bodyOfLength(7000, 1000) + '\r\n' * 500,
        offset: 0,
        generation: request.generation,
      );

      expect(harvest.text, isEmpty);
      expect(window.exhausted, isTrue);
    });

    test('ordinary output is still cut — the guard is not a blanket stop', () {
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      final replay = _body(5000, 100);
      window.noteReplay(data: replay, offset: 50000);
      final request = window.nextRequest()!;
      final older = _bodyOfLength(4000, 4000);

      final harvest = window.consume(
        data: older + replay.substring(0, 400),
        offset: 46000,
        generation: request.generation,
      );

      expect(harvest.text, older);
      expect(window.exhausted, isFalse);
    });
  });

  group('a slice SHORTER than the walk expected (#167)', () {
    test('does not throw out of the pure rule', () {
      // Reachable in production: `persistScrollback` defaults OFF, so a worker
      // restart collapses a session's scrollback to nothing and it regrows from
      // there, while the socket `reconnected` handler clears the terminal
      // without resetting the window. `_deepenOnce`'s `catch (_)` then swallows
      // the throw, so the walk dies silently for the rest of the session.
      final window = ScrollbackWindow(); // production defaults
      window.noteReplay(data: _bodyOfLength(900000, 8000), offset: 400000);
      final request = window.nextRequest()!;
      expect(request.offset, 137856);
      expect(request.limit, 266240);

      // The buffer collapsed to 200000 units: the server serves what is left.
      final data = _bodyOfLength(1000, 200000 - 137856);
      expect(
        () => window.consume(
          data: data,
          offset: 137856,
          generation: request.generation,
        ),
        returnsNormally,
        reason: 'String.lastIndexOf throws when its start is past the end — '
            'the bound is a walk coordinate and must be clamped to the slice',
      );
      expect(window.exhausted, isTrue,
          reason: 'the anchor is not in this slice, so the walk stops');
    });
  });

  group('nothing on screen means no anchor, and no anchor means no cut', () {
    test('a slice arriving with no anchor STOPS instead of prepending whole',
        () {
      // The old reading was "nothing is on screen yet, so there is nothing this
      // slice could duplicate". That is unsound: an attach whose HTTP replay
      // came back empty still ends up with a terminal filled by the SOCKET
      // replay, and this branch then prepends the whole slice uncut, on top of
      // text it overlaps.
      final window = ScrollbackWindow(stepBytes: 4000, anchorBytes: 400);
      window.noteReplay(data: '', offset: 8000);
      final request = window.nextRequest()!;

      final harvest = window.consume(
        data: _body(0, 100),
        offset: 4000,
        generation: request.generation,
      );

      expect(harvest.text, isEmpty);
      expect(window.exhausted, isTrue);
    });
  });

  group('a NON-repainting seam — plain output must SURVIVE it', () {
    test('plain scrolling output across a seam reconstructs EXACTLY', () {
      // The counter-case to the seam group below, and the reason the viewport
      // is not dropped: for output the continuation does NOT repaint, the last
      // screenful of a slice is real history, and dropping it deletes it
      // silently — `rows - 1` lines per seam, with no error anywhere.
      const cols = 52;
      const rows = 38;

      final older = StringBuffer();
      for (var i = 0; i < 200; i++) {
        older.write(_line(i));
      }
      final newer = StringBuffer();
      for (var i = 200; i < 300; i++) {
        newer.write(_line(i));
      }

      final server = _SlidingScrollback(1 << 20);
      server.emit(older.toString());
      server.emit(newer.toString());

      final whole = Terminal(maxLines: 100000)..resize(cols, rows);
      whole.write(server.emitted);
      final reference = _linesOf(whole);

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
      final harvested = scratchLines.sublist(0, _harvestOf(scratchLines));
      final combined = [...harvested, ..._linesOf(live)];

      expect(_tokenCounts(combined.join('\n')).length, 300,
          reason: 'every line the PTY printed must still be there — a seam is '
              'not allowed to delete history');
      expect(combined, reference,
          reason: 'plain output across a seam must render exactly as one '
              'contiguous replay of the same bytes');
    });
  });

  group('olderLineLimit — trailing BLANKS go, real content stays', () {
    int limitOf(List<String> lines) =>
        olderLineLimit(lines.length, (i) => lines[i].trim().isEmpty);

    test('drops the trailing blank lines the scratch viewport contributes', () {
      expect(limitOf(['a', 'b', '', '   ', '']), 2);
    });

    test('keeps a full slice that ends in real content', () {
      expect(limitOf(['a', 'b', 'c']), 3);
    });

    test('an all-blank slice harvests nothing', () {
      expect(limitOf(['', '  ', '']), 0);
      expect(limitOf(const <String>[]), 0);
    });

    test('a blank line SURROUNDED by content is history and stays', () {
      // The rule trims from the end only. A gap the PTY really printed is part
      // of the output and prepending it is what a contiguous replay would do.
      expect(limitOf(['a', '', 'b']), 3);
    });
  });

  group('the seam — the accepted residual, pinned so it is not forgotten', () {
    // This group used to assert that attach + deepen renders IDENTICALLY to one
    // contiguous replay. It does not, and buying that equality cost `rows - 1`
    // lines of real history at every non-repainting seam — see the group above
    // and [olderLineLimit]. So the residual is recorded instead of removed:
    //
    //   * what a REPAINTING continuation drew over is kept rather than dropped,
    //     so the harvest can carry one extra frame of pre-repaint content;
    //   * it is bounded by ONE SCREEN, and it is one contiguous block — the
    //     rest of the rendering still matches a contiguous replay exactly;
    //   * nothing is ever missing, which is the half that matters.

    test('a repaint at the boundary leaves at most ONE extra frame', () {
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
      final harvested = scratchLines.sublist(0, _harvestOf(scratchLines));

      final combined = [...harvested, ..._linesOf(live)];

      // The panel itself is drawn ONCE: the older slice predates it, so no
      // stale copy of the frame is stamped into the scrollback.
      expect(combined.where((l) => l.startsWith('PANEL row 00')), hasLength(1));

      // The residual: the lines the repaint drew OVER survive here, where a
      // contiguous replay had already lost them.
      final extra = combined.length - reference.length;
      expect(extra, greaterThan(0),
          reason: 'this is the known, accepted difference — if it is gone, the '
              'viewport drop is back and plain output is being deleted');
      expect(extra, lessThanOrEqualTo(rows),
          reason: 'bounded by one screen: a slice can end mid-frame, never '
              'more');

      // ...and it is ONE contiguous block. Remove it and the rendering matches
      // a contiguous replay exactly, which is the real guarantee.
      final d = _divergence(combined, reference);
      expect([...combined.sublist(0, d), ...combined.sublist(d + extra)],
          reference,
          reason: 'apart from that single block the deepened history must '
              'render exactly as one contiguous replay');
      expect(_tokenCounts(combined.join()).length, 300,
          reason: 'and no line the PTY printed is missing');
    });

    test('a slice that ENDS mid-frame stamps that frame a second time', () {
      // The honest worst case: the older half already finished drawing the
      // panel, and the newer half opens by drawing the same panel again. A
      // contiguous replay paints it once, in place; the walk shows it twice.
      const cols = 52;
      const rows = 38;

      String panel() {
        final b = StringBuffer('\x1b[H');
        for (var r = 0; r < rows; r++) {
          b.write('PANEL row ${r.toString().padLeft(2, '0')}\x1b[K\r\n');
        }
        return b.toString();
      }

      final older = StringBuffer();
      for (var i = 0; i < 200; i++) {
        older.write(_line(i));
      }
      older.write(panel());
      final newer = StringBuffer()..write(panel());
      for (var i = 200; i < 300; i++) {
        newer.write(_line(i));
      }

      final server = _SlidingScrollback(1 << 20);
      server.emit(older.toString());
      server.emit(newer.toString());

      final whole = Terminal(maxLines: 100000)..resize(cols, rows);
      whole.write(server.emitted);
      final reference = _linesOf(whole);

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
      final combined = [
        ...scratchLines.sublist(0, _harvestOf(scratchLines)),
        ..._linesOf(live),
      ];

      expect(combined.where((l) => l.startsWith('PANEL row 00')), hasLength(2),
          reason: 'THE accepted residual, stated out loud: one repainted frame '
              'appears twice. It is bounded by a screen, and the alternative '
              'deletes real history at every seam that does NOT repaint');
      expect(combined.length - reference.length, lessThanOrEqualTo(rows));
      // Nothing a contiguous replay would still SHOW is missing. (The fixture's
      // own panel overwrote 37 token lines in both renderings, so the count is
      // measured against the reference, not against everything ever printed.)
      expect(_tokenCounts(combined.join()).keys,
          containsAll(_tokenCounts(reference.join()).keys),
          reason: 'nothing the PTY printed is missing — the half that matters');
    });
  });
}
