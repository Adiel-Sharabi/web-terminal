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

      // NOTE these two guard less than they look like they do: the old code did
      // not produce `a.pdfName` ON THE WIRE either — it emitted
      // `a.pdf ESC[201~ Name…`, and the fusion happened inside the TUI once it
      // folded the markers away. They pass against the old composition too. The
      // assertion that actually catches the regression is the inner.split('\r')
      // equality above. Kept as documentation of the reported string, not as the
      // gate.
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

    test('a body cannot reconstitute a paste marker and close the wrapper', () {
      // A SINGLE-pass strip is defeated by a marker spelled across another one:
      // deleting the inner ESC[200~ leaves ESC[2 and 01~ adjacent, which spells
      // ESC[201~ — closing the wrapper early, after which the remainder is typed
      // at the prompt and any CR in it SUBMITS. The strip must loop until stable.
      final evil = 'a$esc[2${pasteOpen}01~b\nc';
      final out = buildComposeSubmission(evil, forcePaste: true);

      expect(pasteOpen.allMatches(out).length, 1);
      expect(pasteClose.allMatches(out).length, 1);
      // The one close is the wrapper's own, at the very end.
      expect(out.endsWith('$pasteClose\r'), isTrue);
      // Nothing escaped the wrapper: exactly one CR, the submit.
      expect('\r'.allMatches(out).length, 2); // the \n separator + the submit
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

  // The raw-terminal destination (the image picker with the terminal focused).
  // Same folding defect as the compose path had, and it survived the first pass
  // of this fix — a multi-select pick still sent one paste per file.
  group('buildPastedPaths', () {
    test('several picked images travel as ONE paste, not one each', () {
      final out = buildPastedPaths([r'C:\up\a.png', r'C:\up\b.png']);
      expect(pasteOpen.allMatches(out).length, 1);
      expect(pasteClose.allMatches(out).length, 1);
      expect(out.contains(r'C:\up\a.png'), isTrue);
      expect(out.contains(r'C:\up\b.png'), isTrue);
      expect(out, '${pasteOpen}C:\\up\\a.png\rC:\\up\\b.png$pasteClose');
    });

    test('NO submit CR — this is the user\'s own prompt line', () {
      // The compose path submits for you; this one must not. The user types
      // behind the paths and presses Enter themselves, so a trailing CR here
      // would send a half-written message.
      final out = buildPastedPaths([r'C:\up\a.png']);
      expect(out.endsWith(pasteClose), isTrue);
      expect(out.contains('\r'), isFalse);
    });

    test('an empty pick sends nothing at all', () {
      expect(buildPastedPaths(const []), '');
    });
  });

  group('decodeStagedAttachments (#113 — chips survive leaving the session)', () {
    // Reported 2026-08-12: "I attached the images in here, I swipe to a
    // different session, go back, and those images was gone."
    //
    // The compose bar persisted its TEXT and nothing else, which is the worse
    // half of the two states: the draft came back looking complete while the
    // images it referred to were silently gone.

    test('round-trips a dropped file, keeping its name', () {
      final out = decodeStagedAttachments(
        '[{"path":"/srv/dropped-files/17-report.pdf","name":"report.pdf"}]',
      );
      expect(out, [
        {'path': '/srv/dropped-files/17-report.pdf', 'name': 'report.pdf'},
      ]);
    });

    test('preserves order across several attachments', () {
      final out = decodeStagedAttachments(
        '[{"path":"/a/1.png","name":"one"},'
        '{"path":"/a/2.png","name":"two"},'
        '{"path":"/a/3.png","name":"three"}]',
      );
      expect([for (final a in out) a['name']], ['one', 'two', 'three']);
    });

    test('a nameless clipboard paste falls back to its basename', () {
      // Only DROPPED files carry a name; a clipboard paste is staged with none.
      // Without the fallback every restored paste would be an unlabelled chip —
      // on screen, but naming nothing. And the restored chip has no thumbnail
      // (bytes are never persisted), so the name is all the user gets.
      expect(
        decodeStagedAttachments(
          r'[{"path":"C:\\dev\\web-terminal\\clipboard-images\\clip-178.png","name":""}]',
        ),
        [
          {
            'path': r'C:\dev\web-terminal\clipboard-images\clip-178.png',
            'name': 'clip-178.png',
          }
        ],
      );
      expect(
        decodeStagedAttachments('[{"path":"/srv/clipboard-images/clip-9.png"}]'),
        [
          {'path': '/srv/clipboard-images/clip-9.png', 'name': 'clip-9.png'}
        ],
      );
    });

    test('drops an entry with no path rather than restoring a broken chip', () {
      // A chip with no path is worse than a missing one: it survives to the next
      // send and hands the agent an empty reference — the #90 failure shape
      // ("a path naming no file, glued to a mangled prompt").
      expect(
        decodeStagedAttachments('[{"name":"orphan"},{"path":"","name":"x"}]'),
        isEmpty,
      );
      expect(
        decodeStagedAttachments('[{"name":"orphan"},{"path":"/a/ok.png","name":"ok"}]'),
        [
          {'path': '/a/ok.png', 'name': 'ok'}
        ],
      );
    });

    test('nothing stored, or a corrupt/foreign cache, restores nothing', () {
      // Must never throw: this runs inside the same prefs read that restores the
      // draft, so an exception here would cost the user their typed text too.
      for (final raw in <String?>[
        null,
        '',
        'not json at all',
        '{"path":"/a/b.png"}', // an object, not a list
        '[42,"nope",null]',
        '[',
      ]) {
        expect(decodeStagedAttachments(raw), isEmpty, reason: 'raw=$raw');
      }
    });
  });
}
