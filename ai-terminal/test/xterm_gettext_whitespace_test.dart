// #151 — copying a terminal selection must put the whitespace on the clipboard.
//
// A terminal does NOT pad the gap between two words with literal 0x20. A cell
// that was never written, or that was erased (ECH / EL), holds codePoint 0 —
// and stock `BufferLine.getText` skipped exactly those cells, so every run of
// blank columns inside a selection vanished and the words on either side were
// concatenated. Shell output typed as one string survived (its spaces really
// are 0x20), which is why the defect read as intermittent: it is the TUI-drawn
// output — the boxes, the indentation, the aligned columns — that is built out
// of cursor moves and erases, and that is precisely what people copy.
//
// THE TRAP these tests exist for: a blank cell and the SECOND HALF OF A WIDE
// CHARACTER are byte-identical in the buffer. `Buffer.writeChar` follows a
// width-2 glyph with `writeChar(0)`, and `wcwidth(0) == 0`, so the trailing
// cell's content word is 0 — the same value `eraseCell` writes. The only thing
// that tells them apart is the cell BEFORE: a continuation cell is one whose
// left neighbour has width 2. Emit a space for it and every CJK/emoji glyph
// grows a phantom space. So: assert on a wide char next to a real gap, every
// time.
//
// AND THE TRAP HAS A SECOND FLOOR, which the first cut of this fix fell
// through: on the LAST column that left neighbour is on the PREVIOUS ROW, so
// the rule above is blind exactly there. See the last-column group below — it
// is red against the patch's first cut rather than against stock, because the
// defect it guards is one the patch itself introduced.
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';

import 'package:ai_terminal/screens/session_screen.dart'
    show copyTerminalSelection;

Terminal _term({int cols = 40, int rows = 8}) {
  final terminal = Terminal(maxLines: 200);
  terminal.resize(cols, rows);
  return terminal;
}

/// The text of one absolute buffer line, exactly as the clipboard would get it.
String _line(Terminal terminal, int y) => terminal.buffer.lines[y].getText();

void main() {
  group('#151 interior gaps survive the copy', () {
    test('a gap made by cursor movement (CUF) copies as spaces', () {
      final terminal = _term();
      terminal.write('foo\x1b[3Cbar');
      expect(_line(terminal, 0), 'foo   bar');
    });

    test('a gap made by erase (ECH) copies as spaces', () {
      final terminal = _term();
      terminal.write('foo###bar');
      terminal.write('\x1b[1;4H'); // back to column 4 (1-based)
      terminal.write('\x1b[3X'); // erase 3 cells in place
      expect(_line(terminal, 0), 'foo   bar');
    });

    test('leading indentation drawn by cursor movement survives', () {
      final terminal = _term();
      terminal.write('\x1b[4Cindented');
      expect(_line(terminal, 0), '    indented');
    });

    test('an erased gap and a literal-space gap produce the same text', () {
      final literal = _term()..write('foo   bar');
      final erased = _term()..write('foo\x1b[3Cbar');
      expect(_line(literal, 0), _line(erased, 0));
      expect(_line(literal, 0), 'foo   bar');
    });
  });

  group('#151 the unwritten remainder of a row is not content', () {
    // Interior gaps are content, the unwritten remainder of the row is not.
    // Without this, every line of a multi-line selection would be padded out to
    // the terminal width, because the segment for a line in the middle of the
    // range spans the WHOLE line.
    test('the blank remainder of a row is not emitted', () {
      final terminal = _term();
      terminal.write('foo');
      expect(_line(terminal, 0), 'foo');
    });

    test('a wholly blank line stays empty', () {
      final terminal = _term();
      terminal.write('a\r\n\r\nb');
      expect(_line(terminal, 1), '');
    });

    // THE ASYMMETRY IS DELIBERATE, and the first cut of this fix got it wrong.
    // A literal 0x20 is a character the program wrote, not padding — and at the
    // last column of a WRAPPED row it is load-bearing, because the next row is
    // joined with no newline. See the rejoin test below, which is what a
    // "trailing whitespace is trailing whitespace" rule breaks.
    test('trailing literal spaces are kept — they are written characters', () {
      final terminal = _term();
      terminal.write('foo   ');
      expect(_line(terminal, 0), 'foo   ');
    });

    test('a wrapped row keeps the space it ends on when the rows rejoin', () {
      final terminal = _term(cols: 10, rows: 6);
      terminal.write('This is a long line that should wrap');

      // Rows: 'This is a ' | 'long line ' | 'that shoul' | 'd wrap'. The first
      // two END on a real space; drop it and the words fuse across the join.
      final text = terminal.buffer.getText(
        BufferRangeLine(const CellOffset(0, 0), const CellOffset(9, 3)),
      );

      expect(text, 'This is a long line that should wrap');
    });
  });

  group('#151 wide characters are not duplicated and grow no phantom space',
      () {
    test('a wide glyph copies once', () {
      final terminal = _term();
      terminal.write('中文');
      expect(_line(terminal, 0), '中文');
    });

    test('an astral glyph copies once', () {
      final terminal = _term();
      terminal.write('\u{1f642}');
      expect(_line(terminal, 0), '\u{1f642}');
    });

    // The discriminating case: the continuation cell of the wide char and the
    // two blank cells after it hold the identical value 0.
    test('a wide glyph followed by a real gap keeps the gap and only the gap',
        () {
      final terminal = _term();
      terminal.write('中\x1b[2Cx');
      expect(_line(terminal, 0), '中  x');
    });

    test('a wide glyph between two words keeps both gaps', () {
      final terminal = _term();
      terminal.write('a\x1b[1C中\x1b[1Cb');
      expect(_line(terminal, 0), 'a 中 b');
    });
  });

  group('#151 a selection copied through Buffer.getText', () {
    test('a multi-line selection keeps interior gaps and indentation', () {
      final terminal = _term();
      terminal.write('cmd\x1b[2Cone\r\n    indented\x1b[3Ctail');

      final text = terminal.buffer.getText(
        BufferRangeLine(const CellOffset(0, 0), const CellOffset(39, 1)),
      );

      expect(text, 'cmd  one\n    indented   tail');
    });

    // NOTE, and it is stock behaviour this change does not touch: a segment's
    // end column is passed straight to `BufferLine.getText` as its EXCLUSIVE
    // `to`, so column 13 here means "up to but not including 13".
    test('a partial selection keeps the gap inside it', () {
      final terminal = _term();
      terminal.write('alpha\x1b[4Cbeta');

      final text = terminal.buffer.getText(
        BufferRangeLine(const CellOffset(0, 0), const CellOffset(13, 0)),
      );

      expect(text, 'alpha    beta');
    });

    test('a partial selection ending inside a gap trims it', () {
      final terminal = _term();
      terminal.write('alpha\x1b[4Cbeta');

      final text = terminal.buffer.getText(
        BufferRangeLine(const CellOffset(0, 0), const CellOffset(8, 0)),
      );

      expect(text, 'alpha');
    });
  });

  // A wide glyph on the LAST column puts its continuation cell at column 0 of
  // the NEXT row: `writeChar` reaches `_cursorX >= viewWidth` on the recursive
  // `writeChar(0)` and runs `index(); setCursorX(0)` BEFORE writing it. So the
  // "look one cell left" rule above is blind exactly there, and the first cut
  // of this fix injected a phantom space into the middle of a word. These cases
  // are red against THAT cut, not against stock — they guard a defect the patch
  // introduced, which is why they live in their own group.
  group('#151 a wide glyph on the last column wraps its continuation cell', () {
    String wrapped(String text, {String gap = ''}) {
      final terminal = _term(cols: 10, rows: 6);
      terminal.write(text);
      if (gap.isNotEmpty) terminal.write(gap);
      return terminal.buffer.getText(
        BufferRangeLine(const CellOffset(0, 0), const CellOffset(9, 1)),
      );
    }

    // (a) The reported shape. Stock drops the glyph itself (`i + width <= to`
    // is false on the last column — pre-existing upstream, untouched here), so
    // the correct answer is the letters joined with nothing between them.
    test('no space is injected before the wrapped row', () {
      expect(wrapped('abcdefghi中jkl'), 'abcdefghijkl');
    });

    // (b) An astral glyph takes the same path.
    test('an astral glyph on the last column behaves the same', () {
      expect(wrapped('abcdefghi\u{1f642}jkl'), 'abcdefghijkl');
    });

    // (c) The discriminating case, red against BOTH the first cut and stock:
    // the continuation must vanish while the REAL gap after it survives.
    test('a real gap after the continuation still copies as spaces', () {
      expect(wrapped('abcdefghi中', gap: '\x1b[2Cx'), 'abcdefghi  x');
    });

    // (d) The skip must never eat a written character. Here the wrapped row
    // begins on a literal 0x20, and nothing above it is wide.
    test('a wrapped row beginning on a real space keeps it', () {
      expect(wrapped('abcdefghij klm'), 'abcdefghij klm');
    });

    // (e) MEASURED, not assumed. The continuation lands at column 0 whether or
    // not DECAWM is on, but `isWrapped` is set only when it is — so a fix keyed
    // on `isWrapped` would leave the phantom space here. With DECAWM off the
    // rows are not joined, hence the newline.
    test('DECAWM off still places the continuation at column 0', () {
      final terminal = _term(cols: 10, rows: 6);
      terminal.write('\x1b[?7l');
      terminal.write('abcdefghi中jkl');

      expect(terminal.buffer.lines[1].isWrapped, isFalse,
          reason: 'the premise: DECAWM off leaves the row unmarked');
      expect(terminal.buffer.lines[1].getCodePoint(0), 0,
          reason: 'the premise: the continuation is still at column 0');

      final text = terminal.buffer.getText(
        BufferRangeLine(const CellOffset(0, 0), const CellOffset(9, 1)),
      );
      expect(text, 'abcdefghi\njkl');
    });
  });

  // Everything above drives the escape sequences by hand. This one replays the
  // checked-in capture of a REAL codex TUI through the app's ONE clipboard
  // function, so the defect cannot be dismissed as an artefact of a synthetic
  // fixture. Codex pads inside its boxes with literal 0x20 but draws the
  // left margin by moving the cursor — so what this capture loses without the
  // fix is the indentation, which is the second half of what #151 reports.
  group('#151 the real clipboard path, on a real codex capture', () {
    testWidgets('copyTerminalSelection keeps the margin codex drew',
        (tester) async {
      final capture = File('test/fixtures/codex-pty-capture.bin');
      if (!capture.existsSync()) {
        markTestSkipped('no codex capture available');
        return;
      }

      final clipboardWrites = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboardWrites.add((call.arguments as Map)['text'] as String);
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger
            .setMockMethodCallHandler(SystemChannels.platform, null),
      );

      final terminal = Terminal(maxLines: 500);
      terminal.resize(120, 40);
      terminal.write(String.fromCharCodes(capture.readAsBytesSync()));

      final controller = TerminalController();
      controller.setSelection(
        terminal.buffer.createAnchor(0, 3),
        terminal.buffer.createAnchor(terminal.viewWidth - 1, 3),
      );

      final copied = copyTerminalSelection(terminal, controller);

      expect(copied, startsWith('  Update available!'));
      expect(clipboardWrites.single, copied);
    });
  });
}
