import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:ai_terminal/util/attach_overlap.dart';

/// #176 — the attach-time overlap cut.
///
/// The shapes here are the ones the live measurement produced (2026-08-27): a
/// replay of `ESC[?2004h` + 32768 units whose TAIL is byte-identical to the end of
/// what the HTTP replay put on screen, and whose HEAD may not be, because the two
/// sanitiser passes disagree there.
///
/// Control characters are built with [String.fromCharCode] rather than written as
/// escapes, so what a reader sees is unambiguously what the test feeds in.
void main() {
  final esc = String.fromCharCode(27);
  final crlf = String.fromCharCode(13) + String.fromCharCode(10);
  final bp = '$esc[?2004h';

  String unique(int n, [String tag = 'L']) {
    final b = StringBuffer();
    var i = 0;
    while (b.length < n) {
      b.write('$tag-${i++}-${'.' * 30}$crlf');
    }
    return b.toString().substring(0, n);
  }

  group('cutAttachOverlap', () {
    test('nothing rendered yet: the replay is written whole', () {
      // The reconnect path clears the buffer first, so there is nothing to
      // overlap — and cutting there would delete the tail rather than dedupe it.
      expect(cutAttachOverlap('', 'abc'), 'abc');
    });

    test('an empty replay stays empty', () {
      expect(cutAttachOverlap('anything', ''), '');
    });

    test('the replay is ENTIRELY already on screen: nothing is written', () {
      // The idle case, and the common one: nothing was emitted between the HTTP
      // fetch and the socket connect, so the socket replay is a strict suffix of
      // what is rendered.
      final screen = unique(20000);
      final replay = screen.substring(screen.length - 5000);
      expect(cutAttachOverlap(screen, replay, anchorBytes: 512), '');
    });

    test('only the genuinely NEW tail is written', () {
      final screen = unique(20000);
      final fresh = 'BRAND-NEW-OUTPUT-AFTER-THE-FETCH$crlf';
      final replay = screen.substring(screen.length - 5000) + fresh;
      expect(cutAttachOverlap(screen, replay, anchorBytes: 512), fresh);
    });

    test('THE MEASURED SHAPE: an 8-unit prefix plus a 32 KB tail', () {
      // Exactly what the probe saw: replay length 32776 = ESC[?2004h + 32768,
      // whose content is the tail of the buffer already on screen. Without the cut
      // every one of those 32768 units renders a second time.
      final screen = unique(262144);
      final replay = bp + screen.substring(screen.length - 32768);
      expect(replay.length, 32776);
      // The mode change survives; not one unit of content is repeated.
      expect(cutAttachOverlap(screen, replay), bp);
    });

    test('the bracketed-paste prefix is kept even when new output follows', () {
      final screen = unique(20000);
      final fresh = 'NEW$crlf';
      final replay = bp + screen.substring(screen.length - 5000) + fresh;
      expect(cutAttachOverlap(screen, replay, anchorBytes: 512), bp + fresh);
    });

    test('a replay that shares NOTHING is written whole — never a hole', () {
      // Legitimate: more than a whole replay's worth of output between the fetch
      // and the connect leaves no overlap at all. Also the honest fallback for a
      // divergence this rule cannot see through — the worst case is today's
      // behaviour, a visible duplicate, never a silent hole.
      final screen = unique(20000, 'OLD');
      final replay = unique(5000, 'NEW');
      expect(cutAttachOverlap(screen, replay, anchorBytes: 512), replay);
    });

    test('a screen shorter than the anchor uses all of it', () {
      const screen = 'tiny screen';
      const fresh = ' and then more';
      expect(cutAttachOverlap(screen, screen + fresh, anchorBytes: 4096), fresh);
    });

    test('on a REPEATING region the FIRST match wins — err toward a duplicate', () {
      // The opposite choice from scrollback_window.dart's backward walk, and
      // deliberate: here a match that is too LATE cuts away live output that was
      // never rendered (a hole), while too EARLY re-renders a little (a
      // duplicate). Only one of those is invisible to the user.
      final frame = 'FRAME$crlf';
      final screen = frame * 50;
      final replay = '${frame * 10}NEW-AFTER$crlf';
      final out = cutAttachOverlap(screen, replay, anchorBytes: frame.length * 2);
      // Cut at the FIRST occurrence: keeps some frames after it (a duplicate)
      // and, critically, keeps the new line.
      expect(out.endsWith('NEW-AFTER$crlf'), isTrue);
      // The last-match choice would have returned just the new line here — right
      // in this fixture, and wrong whenever the repeat is live output.
      expect(out.length, greaterThan('NEW-AFTER$crlf'.length));
    });

    test('the anchor comes from the END of the screen, not the head of the replay', () {
      // The measured divergence is at the replay's HEAD (its truncated sanitise
      // starts mid-stream and mis-tracks alt-screen), so a rule anchored there
      // would fail on exactly the escape-heavy content agent TUIs produce. Model
      // it: the replay's first 200 units differ, the rest agrees.
      final screen = unique(20000);
      final agreed = screen.substring(screen.length - 5000);
      final replay = 'XX-DIVERGENT-HEAD-XX${agreed.substring(200)}';
      expect(cutAttachOverlap(screen, replay, anchorBytes: 512), '');
    });
  });

  group('rendered through the real terminal', () {
    // The layer the user actually sees. #176 was measured as "1129 duplicated
    // lines per attach" through the vendored xterm, so the assertion is made on
    // the RENDERED lines. Both directions are asserted together, so this cannot
    // quietly stop proving anything: without the cut the duplicates MUST be
    // there, and with it there must be none.

    List<String> linesOf(Terminal t) {
      final out = <String>[];
      for (var i = 0; i < t.buffer.lines.length; i++) {
        final s = t.buffer.lines[i].toString().trimRight();
        if (s.isNotEmpty) out.add(s);
      }
      return out;
    }

    /// Markers rendered more than once.
    Map<String, int> dupes(List<String> lines) {
      final seen = <String, int>{};
      final re = RegExp('RMARK-[0-9]+');
      for (final l in lines) {
        final m = re.firstMatch(l);
        if (m != null) seen.update(m[0]!, (v) => v + 1, ifAbsent: () => 1);
      }
      seen.removeWhere((_, v) => v < 2);
      return seen;
    }

    String scrollbackOf(int lines) {
      final b = StringBuffer();
      for (var i = 0; i < lines; i++) {
        b.write('RMARK-$i-${'z' * 20}$crlf');
      }
      return b.toString();
    }

    test('THE REGRESSION: the tail renders twice without the cut, once with it', () {
      final scrollback = scrollbackOf(1200);
      final httpReplay = scrollback.substring(scrollback.length - 24000);
      final socketReplay =
          bp + scrollback.substring(scrollback.length - 8000);

      // --- today's behaviour: both frames land, and the newest lines render twice.
      final before = Terminal(maxLines: 100000)..resize(80, 38);
      before.write(httpReplay);
      before.write(socketReplay);
      expect(dupes(linesOf(before)), isNotEmpty,
          reason: 'the bug must reproduce without the cut, or this test proves '
              'nothing about the fix');

      // --- with the cut: the same two frames, de-duplicated by content.
      final after = Terminal(maxLines: 100000)..resize(80, 38);
      after.write(httpReplay);
      final tail = httpReplay.substring(httpReplay.length - kAttachAnchorBytes);
      after.write(cutAttachOverlap(tail, socketReplay));
      expect(dupes(linesOf(after)), isEmpty,
          reason: 'no printed line may render twice after an attach');

      // ...and nothing was DELETED to achieve it.
      expect(linesOf(after).last.contains('RMARK-1199'), isTrue);
      expect(linesOf(after).length, lessThan(linesOf(before).length));
    });

    test('live output arriving after the fetch still renders exactly once', () {
      final scrollback = scrollbackOf(1200);
      final httpReplay = scrollback.substring(scrollback.length - 24000);
      // The session kept printing between the fetch and the connect, so the
      // socket frame carries genuinely new lines at its end.
      final fresh = 'RMARK-9001-new${crlf}RMARK-9002-new$crlf';
      final socketReplay =
          bp + scrollback.substring(scrollback.length - 8000) + fresh;

      final t = Terminal(maxLines: 100000)..resize(80, 38);
      t.write(httpReplay);
      final tail = httpReplay.substring(httpReplay.length - kAttachAnchorBytes);
      t.write(cutAttachOverlap(tail, socketReplay));

      final lines = linesOf(t);
      expect(dupes(lines), isEmpty);
      // The new lines are NOT lost — that is the failure this rule refuses to
      // trade the duplicate for.
      expect(lines.where((l) => l.contains('RMARK-9001')), hasLength(1));
      expect(lines.where((l) => l.contains('RMARK-9002')), hasLength(1));
    });
  });
}
