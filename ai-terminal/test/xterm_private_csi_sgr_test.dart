// #237 - the companion's terminal underlined every word, on Windows, phone and tablet.
//
// ROOT CAUSE, measured rather than reasoned: `_csiHandlers` in the vendored parser is
// keyed on the CSI's FINAL BYTE alone, and while `_consumeCsi` does store the
// private-parameter prefix in `_csi.prefix`, the dispatch ignores it. So `CSI > 4 m` -
// XTMODKEYS, xterm's modifyOtherKeys, which claude code emits at startup to turn on
// enhanced key reporting - reached the SGR handler as bare parameter 4 and ran
// `setCursorUnderline()`.
//
// Captured off a real claude TUI (scripts/rig/probe-underline-sgr.js): `ESC[>4m` arrives
// once near the head of the session, and the rest of the stream contains NO `SGR 24` and
// no further `SGR 0`. Underline therefore latched on near the start and never turned off
// - which is exactly "every line and every word", and why it looked like a rendering bug
// rather than a parsing one.
//
// The web client (xterm.js) reads the same bytes correctly, so this was companion-only.
//
// WHICH CASE CATCHES WHAT - the two are not interchangeable, and an earlier draft of this
// header had them the wrong way round.
//
//   * A parser that set underline and CLEARED IT on the next attribute change is caught
//     by the FIRST case, `ESC[>4mhello`: the cell is written before any later attribute
//     arrives, so it is underlined there and the assertion goes red. The LATCH case would
//     PASS against such a parser, because its first cell follows `ESC[38;2;...m` - an
//     attribute change that would already have cleared the flag.
//   * THE LATCH is what matches the REPORT: text arriving long after the sequence, past
//     unrelated colour changes, still underlined. It is the case that shows the defect is
//     not a one-cell blip.
//
// Both are red against stock, so both earn their place; neither replaces the other.
import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
// CellData and CellFlags both come from package:xterm/xterm.dart via core.dart.

/// Flags of the cell at [x] on row [y].
int _flags(Terminal t, int x, int y) {
  final cell = CellData.empty();
  t.buffer.lines[y].getCellData(x, cell);
  return cell.flags;
}

bool _underlined(Terminal t, int x, int y) =>
    _flags(t, x, y) & CellFlags.underline != 0;

Terminal _term() => Terminal(maxLines: 200);

void main() {
  group('#237 a private-prefixed CSI is not an SGR', () {
    test('CSI > 4 m (XTMODKEYS) does not underline the text after it', () {
      final t = _term()..write('\x1b[>4mhello');
      expect(_underlined(t, 0, 0), isFalse,
          reason: 'ESC[>4m is modifyOtherKeys, not SGR 4');
    });

    test('THE LATCH: text long after the sequence is still not underlined', () {
      // The real shape - the sequence fires once at startup, then ordinary colour
      // changes follow and nothing ever emits SGR 24 or SGR 0. Before the fix every
      // one of these cells came back underlined.
      final t = _term()
        ..write('\x1b[>4m')
        ..write('\x1b[38;2;215;119;87mfirst\x1b[39m')
        ..write('\x1b[1mbold\x1b[22m')
        ..write('\x1b[32mlater');
      expect(_underlined(t, 0, 0), isFalse, reason: 'coloured text');
      expect(_underlined(t, 5, 0), isFalse, reason: 'bold text');
      expect(_underlined(t, 9, 0), isFalse, reason: 'text much later in the stream');
    });

    test('every private prefix is refused, not just >', () {
      // ECMA-48's private-parameter markers are 0x3C-0x3F, and all four are refused.
      // `_consumeCsi` accepts a WIDER range as a "prefix" - 0x3A ':' and 0x3B ';' too -
      // and those two are NOT private markers. See the next test, which pins them.
      for (final prefix in ['<', '=', '>', '?']) {
        final t = _term()..write('\x1b[${prefix}4mx');
        expect(_underlined(t, 0, 0), isFalse, reason: 'ESC[${prefix}4m must not underline');
      }
    });

    test('REGRESSION GUARD: an EMPTY FIRST PARAMETER is not a private prefix', () {
      // `_consumeCsi` takes anything in 0x3A..0x3F as the prefix, which sweeps in ':'
      // and ';'. So `ESC[;4m` - the perfectly ordinary SGR `0;4`, what a terminal
      // writes when the first parameter is omitted - arrives with `prefix = ';'`.
      //
      // MEASURED: on stock both of these apply (underline, inverse); a guard written
      // as `prefix != null` drops BOTH. Guarding on 0x3C-0x3F instead keeps them.
      // This is the case the fix must not buy its correctness with.
      final u = _term()..write('\x1b[;4munder');
      expect(_underlined(u, 0, 0), isTrue,
          reason: 'ESC[;4m is SGR 0;4 - a legal SGR, it must still underline');

      final i = _term()..write('\x1b[;7minverse');
      expect(_flags(i, 0, 0) & CellFlags.inverse != 0, isTrue,
          reason: 'ESC[;7m is SGR 0;7 - a legal SGR, it must still invert');
    });

    test('REGRESSION GUARD: a real SGR 4 still underlines, and 24 still clears it', () {
      // The fix must not buy its correctness by breaking underline outright - that
      // would trade a visible bug for an invisible one.
      final on = _term()..write('\x1b[4munder');
      expect(_underlined(on, 0, 0), isTrue, reason: 'plain SGR 4 must still work');

      final off = _term()..write('\x1b[4mA\x1b[24mB');
      expect(_underlined(off, 0, 0), isTrue, reason: 'A is inside the underline');
      expect(_underlined(off, 1, 0), isFalse, reason: 'SGR 24 must still clear it');

      final reset = _term()..write('\x1b[4mA\x1b[0mB');
      expect(_underlined(reset, 1, 0), isFalse, reason: 'SGR 0 must still clear it');
    });

    test('other SGR attributes are unaffected by the guard', () {
      final t = _term()..write('\x1b[1mB');
      expect(_flags(t, 0, 0) & CellFlags.bold != 0, isTrue);
    });
  });
}
