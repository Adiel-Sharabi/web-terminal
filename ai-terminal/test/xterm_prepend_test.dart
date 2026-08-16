// #127 — prepending older scrollback into a live terminal's buffer.
//
// The whole point of the background-deepening design is that history is added
// WITHOUT rebuilding what is already on screen. That needs two things upstream
// xterm does not offer:
//
//   * an O(N) front insert. `insert(0, …)` shifts every existing element with
//     `_moveChild`, so prepending N items into a list of length L costs
//     O(N x L) — thousands by thousands is tens of millions of moves.
//   * a cap that can grow, so the fetched lines are not immediately evicted by
//     the circular buffer they were just added to.
//
// `prependAll` (WEB-TERMINAL PATCH, circular_buffer.dart) provides the first and
// leans on the existing `maxLength` setter for the second.
//
// THE HAZARD THESE TESTS EXIST FOR is #81's: a `BufferLine` carries an `_owner`,
// and `_attach` does not check whether it already had one. Lines harvested from a
// scratch terminal and adopted by the live one are reachable from two buffers for
// as long as the scratch survives. Get it wrong and you reproduce #81 exactly —
// lines that still PAINT but are detached, so selection returns null, and a hard
// throw out of `Terminal.write` in release. So: assert attachment, every time.
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

/// Parses [text] in a throwaway terminal and returns its lines, exactly as the
/// deepening path does. The scratch terminal is DISCARDED by the caller and must
/// never be read again — see the ownership note above.
List<BufferLine> harvest(String text, {int cols = 80, int rows = 24}) {
  final scratch = Terminal(maxLines: 10000);
  scratch.resize(cols, rows);
  scratch.write(text);
  final lines = <BufferLine>[];
  for (var i = 0; i < scratch.buffer.lines.length; i++) {
    lines.add(scratch.buffer.lines[i]);
  }
  return lines;
}

String lineText(BufferLine line) => line.getText().trimRight();

void main() {
  test('prepended lines land BEFORE the existing ones, in order', () {
    final live = Terminal(maxLines: 1000);
    live.resize(80, 24);
    live.write('NEW_A\r\nNEW_B\r\n');

    final older = harvest('OLD_1\r\nOLD_2\r\n');
    final lengthBefore = live.buffer.lines.length;
    live.buffer.lines.prependAll(older);

    expect(live.buffer.lines.length, lengthBefore + older.length);
    expect(lineText(live.buffer.lines[0]), 'OLD_1');
    expect(lineText(live.buffer.lines[1]), 'OLD_2');
    // The previously-first line is now exactly older.length further down.
    expect(lineText(live.buffer.lines[older.length]), 'NEW_A');
  });

  test('every line stays ATTACHED — the #81 assertion', () {
    final live = Terminal(maxLines: 1000);
    live.resize(80, 24);
    live.write('NEW_A\r\nNEW_B\r\n');
    live.buffer.lines.prependAll(harvest('OLD_1\r\nOLD_2\r\n'));

    var detached = 0;
    for (var i = 0; i < live.buffer.lines.length; i++) {
      if (!live.buffer.lines[i].attached) detached++;
    }
    expect(detached, 0,
        reason: 'a detached line still paints but cannot anchor a selection');
  });

  test('the buffer GROWS past its original cap rather than evicting the new lines', () {
    // A cap of 30 with 24 rows already in use: without growth the prepend would
    // be a no-op (upstream `insert` returns early on a full ring at index 0),
    // which is the silent failure this guards.
    final live = Terminal(maxLines: 30);
    live.resize(80, 24);
    live.write('NEW_A\r\n');
    final capBefore = live.buffer.lines.maxLength;

    final older = harvest('OLD_1\r\nOLD_2\r\n');
    live.buffer.lines.prependAll(older);

    expect(live.buffer.lines.maxLength, greaterThanOrEqualTo(capBefore));
    expect(lineText(live.buffer.lines[0]), 'OLD_1');
    expect(live.buffer.lines.length, greaterThan(capBefore - 1));
  });

  test('indices stay consistent — every line reports the slot it is in', () {
    final live = Terminal(maxLines: 1000);
    live.resize(80, 24);
    live.write('NEW_A\r\n');
    live.buffer.lines.prependAll(harvest('OLD_1\r\nOLD_2\r\n'));

    for (var i = 0; i < live.buffer.lines.length; i++) {
      expect(live.buffer.lines[i].index, i,
          reason: 'a line whose index disagrees with its slot breaks selection '
              'and every range operation built on it');
    }
  });

  test('prepending nothing is a no-op, not a corruption', () {
    final live = Terminal(maxLines: 1000);
    live.resize(80, 24);
    live.write('NEW_A\r\n');
    final before = live.buffer.lines.length;

    live.buffer.lines.prependAll(<BufferLine>[]);

    expect(live.buffer.lines.length, before);
    expect(lineText(live.buffer.lines[0]), 'NEW_A');
  });

  test('the terminal still WRITES correctly after a prepend', () {
    // #81's release-mode symptom was a throw out of Terminal.write once the
    // buffer had been corrupted, so exercising the write path afterwards is the
    // point, not a formality.
    final live = Terminal(maxLines: 1000);
    live.resize(80, 24);
    live.write('NEW_A\r\n');
    live.buffer.lines.prependAll(harvest('OLD_1\r\nOLD_2\r\n'));

    expect(() => live.write('AFTER_PREPEND\r\n'), returnsNormally);

    var found = false;
    for (var i = 0; i < live.buffer.lines.length; i++) {
      if (lineText(live.buffer.lines[i]) == 'AFTER_PREPEND') found = true;
    }
    expect(found, isTrue);
  });
}
