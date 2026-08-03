// #90 — a dropped file must actually REACH the agent.
//
// The old encoding sent one bracketed-paste frame per attachment and then the
// prompt. Measured against a real Claude TUI (scripts/rig/probe-paste-file.js),
// that lost files two ways at once:
//   * consecutive pastes arrive in ONE PTY read and the TUI folds them, so with
//     two dropped files only the FIRST path survived;
//   * nothing separated a paste from the text that followed, so the prompt fused
//     onto the last path ("…8P.pdfName both files I attached.").
// Both are invisible to a widget test that only checks "did we send something",
// which is why these assert on the exact bytes.
import 'package:flutter_test/flutter_test.dart';
import 'package:ai_terminal/screens/session_screen.dart';

const esc = '\x1b';
const pasteOpen = '$esc[200~';
const pasteClose = '$esc[201~';

void main() {
  group('buildComposeSubmission', () {
    test('a single-line prompt is still typed, not pasted', () {
      // Unchanged behaviour: no attachments, no interior newline.
      expect(buildComposeSubmission('hello'), 'hello\r');
    });

    test('forcePaste wraps a lone path so Claude treats it as an attachment', () {
      // One dropped file with no prompt has no interior newline, so without
      // forcePaste it would be TYPED — and typed prose is not an attachment.
      final out = buildComposeSubmission(r'C:\drop\a.pdf', forcePaste: true);
      expect(out, '${pasteOpen}C:\\drop\\a.pdf$pasteClose\r');
    });

    test('forcePaste:false keeps the old single-line behaviour', () {
      expect(buildComposeSubmission(r'C:\drop\a.pdf'), 'C:\\drop\\a.pdf\r');
    });

    test('two paths plus a prompt travel as ONE paste, newline-separated', () {
      // THE regression. Exactly one paste-open and one paste-close, so the TUI
      // cannot fold a second paste away; and the prompt is separated from the
      // last path, so it cannot fuse onto it.
      final body = [r'C:\drop\a.pdf', r'C:\drop\b.zip', 'Name both files.'].join('\n');
      final out = buildComposeSubmission(body, forcePaste: true);

      expect(pasteOpen.allMatches(out).length, 1);
      expect(pasteClose.allMatches(out).length, 1);
      expect(out.endsWith('\r'), isTrue);

      // Inside the paste, newlines travel as CR — each item on its own line.
      final inner = out.substring(pasteOpen.length, out.length - pasteClose.length - 1);
      expect(inner.split('\r'), [
        r'C:\drop\a.pdf',
        r'C:\drop\b.zip',
        'Name both files.',
      ]);

      // The specific fusion that was reported: a path immediately followed by
      // the prompt with nothing between them.
      expect(out.contains('a.pdfName'), isFalse);
      expect(out.contains('b.zipName'), isFalse);
    });

    test('the second path is never swallowed', () {
      final out = buildComposeSubmission(
        [r'C:\drop\a.pdf', r'C:\drop\b.zip'].join('\n'),
        forcePaste: true,
      );
      expect(out.contains(r'C:\drop\a.pdf'), isTrue);
      expect(out.contains(r'C:\drop\b.zip'), isTrue);
    });

    test('a trailing newline is still stripped before wrapping', () {
      // Windows multiline TextField appends one on the submitting Enter.
      expect(buildComposeSubmission('hello\n'), 'hello\r');
    });

    test('embedded paste markers in the body are stripped', () {
      // A pasted-in escape must not be able to close the wrapper early.
      final out = buildComposeSubmission('a${pasteClose}b\nc', forcePaste: true);
      expect(pasteClose.allMatches(out).length, 1);
      expect(out.endsWith('$pasteClose\r'), isTrue);
    });
  });

  // These are the tests that actually pin the REPORTED bug. The group above
  // exercises buildComposeSubmission with an already-joined body, so it stays
  // green even if the composition regresses to one frame per attachment — which
  // is precisely the defect that shipped. Assert on the composition itself.
  group('buildAttachmentSubmission', () {
    test('no attachments is unchanged plain-prompt behaviour', () {
      expect(buildAttachmentSubmission([], 'hello'), 'hello\r');
    });

    test('one attachment and a prompt share a SINGLE paste', () {
      final out = buildAttachmentSubmission([r'C:\drop\a.pdf'], 'Read it.');
      expect(pasteOpen.allMatches(out).length, 1);
      expect(pasteClose.allMatches(out).length, 1);
      expect(out, '${pasteOpen}C:\\drop\\a.pdf\rRead it.$pasteClose\r');
    });

    test('TWO attachments do not become two pastes — the folding bug', () {
      // The old code emitted ESC[200~a ESC[201~ ESC[200~b ESC[201~ as separate
      // frames; the TUI folded the consecutive pastes and only the FIRST path
      // survived. Exactly one wrapper is the invariant that prevents it.
      final out = buildAttachmentSubmission(
        [r'C:\drop\a.pdf', r'C:\drop\b.zip'],
        'Name both files.',
      );
      expect(pasteOpen.allMatches(out).length, 1);
      expect(pasteClose.allMatches(out).length, 1);
      expect(out.contains(r'C:\drop\a.pdf'), isTrue);
      expect(out.contains(r'C:\drop\b.zip'), isTrue);
    });

    test('the prompt never fuses onto the last path — the reported string', () {
      final out = buildAttachmentSubmission(
        [r'C:\drop\a.pdf', r'C:\drop\b.zip'],
        'Name both files.',
      );
      expect(out.contains('a.pdfName'), isFalse);
      expect(out.contains('b.zipName'), isFalse);
      // Each item on its own line inside the paste.
      final inner =
          out.substring(pasteOpen.length, out.length - pasteClose.length - 1);
      expect(inner.split('\r'), [
        r'C:\drop\a.pdf',
        r'C:\drop\b.zip',
        'Name both files.',
      ]);
    });

    test('an attachment with no prompt still pastes, and adds no blank line', () {
      // Image-only / file-only send (#87): the body is one path with no interior
      // newline, so only forcePaste keeps it a paste rather than typed prose.
      final out = buildAttachmentSubmission([r'C:\drop\a.pdf'], '');
      expect(out, '${pasteOpen}C:\\drop\\a.pdf$pasteClose\r');
      expect(out.contains('\r\r'), isFalse);
    });

    test('exactly one submit CR, at the very end', () {
      // #44: one frame, one submit. A stray CR would submit early and split the
      // prompt across two turns.
      final out = buildAttachmentSubmission([r'C:\drop\a.pdf'], 'Read it.');
      expect(out.endsWith('$pasteClose\r'), isTrue);
      expect(out.endsWith('\r'), isTrue);
      // The only CRs are the separators inside the paste plus the final one.
      expect('\r'.allMatches(out).length, 2);
    });
  });
}
