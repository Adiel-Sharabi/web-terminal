import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

/// Feeds PTY bytes into an xterm [Terminal] without letting a defect in the widget
/// take the whole lens down (#81).
///
/// WHY THIS EXISTS, because a bare try/catch around a third-party call is normally a
/// symptom-hider and this one has to justify itself:
///
/// xterm 4.0.0 throws on a real Codex byte stream. Measured, bisected and pinned in
/// `test/xterm_codex_stream_test.dart`:
///
///     circular_buffer.dart:312  Failed assertion: 'attached': is not true
///     Buffer.index -> CircularBuffer.insert -> _moveChild -> IndexedItem._move
///
/// That line is `_owner!` with the assert compiled out, so in a RELEASE build it is a
/// hard null-check throw. Thrown from inside `Terminal.write`, called from a stream
/// listener, it kills the widget subtree — which is why the reported symptom was a
/// *blank* terminal rather than a garbled one, while the chat lens (built server-side
/// from the rollout, never touching xterm) looked perfectly fine.
///
/// xterm 4.0.0 is the LATEST published release, so there is nothing to upgrade to and
/// the defect cannot be fixed at its owner. Containing it here is the smallest change
/// that restores a usable terminal.
///
/// WHAT IT DOES AND DOES NOT DO. A frame that throws is dropped and the terminal keeps
/// accepting the next one — a slightly imperfect buffer beats a blank one, and the
/// alternative (sanitising the offending escape sequence before it reaches xterm)
/// risks breaking legitimate Codex layout and wants to be a separate, targeted change
/// once the exact sequence is isolated.
///
/// IT IS NOT SILENT. [terminalWriteFailures] counts drops and [debugPrint] reports the
/// first few. A guard that swallowed failures without trace would turn a loud crash
/// into an invisible one, which is a worse bug than the one it fixes.
int terminalWriteFailures = 0;

/// How many failures get reported before the log goes quiet. A stream that throws on
/// every frame must not flood the log with thousands of identical lines.
const int _kMaxReported = 5;

/// Writes [data] to [terminal], returning true when it landed and false when the
/// widget threw and the frame was dropped.
bool safeTerminalWrite(Terminal terminal, String data) {
  try {
    terminal.write(data);
    return true;
  } catch (e) {
    terminalWriteFailures++;
    if (terminalWriteFailures <= _kMaxReported) {
      debugPrint('[terminal] xterm rejected a ${data.length}-byte frame '
          '(#$terminalWriteFailures): $e');
      if (terminalWriteFailures == _kMaxReported) {
        debugPrint('[terminal] further write failures will not be logged');
      }
    }
    return false;
  }
}

/// Test seam: reset the counter between cases.
@visibleForTesting
void resetTerminalWriteFailures() => terminalWriteFailures = 0;
