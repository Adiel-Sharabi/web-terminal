// Tests for the interactive-question overlay (issue #19): the pure frame
// builder that drives Claude's TUI selector with ABSOLUTE row digits,
// PendingQuestion parsing, and the overlay's select-then-send interaction.
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:ai_terminal/widgets/question_overlay.dart';

/// A question in one of the two layouts Claude renders.
///
/// `preview: true` attaches a real, non-empty `preview` BODY to every option as
/// well as raising `hasPreview` (#143). The two always travel together in
/// production — the server derives the flag from the presence of a non-empty
/// body (`lib/transcript.js` `_shapeQuestions`) — and a flag with no bodies is a
/// state that cannot occur. It also renders nothing, so a widget test built on
/// it would silently exercise a card with no preview block and never see the
/// real side-by-side layout: exactly the "assert against the viewport, not the
/// screen" trap #94 recorded.
const String _previewBody = '''
--- a/lib/thing.dart
+++ b/lib/thing.dart
@@ -1,3 +1,3 @@
-  final int oldWay = 1;
+  final int newWay = 2;''';

PendingQuestionItem _q(
  List<String> options, {
  bool multi = false,
  bool preview = false,
  String header = 'H',
}) =>
    PendingQuestionItem(
      header: header,
      question: 'Pick',
      multiSelect: multi,
      hasPreview: preview,
      options: [
        for (final o in options)
          QuestionOption(label: o, preview: preview ? '$o\n$_previewBody' : '')
      ],
    );

/// The keys of each frame, for terse assertions.
List<String> _keys(List<AnswerFrame> f) => [for (final x in f) x.keys];

/// A realistically long lead-up, modelled on the one that produced the report:
/// the explanation sits at the TOP and the closing paragraph at the bottom, so
/// a panel showing only the tail leaves the options unjudgeable.
const String _longLeadUp = '''
HEAD_THE_CHANGE_IS_APPLIED_AND_CORRECT — every part of it is verified. But
testing it end to end turned up a real defect, and it decides which of the
options below is the right one:

The client asks for a retry-safe write. The server turns that into a
conflict check, and a conflict check needs read permission — which this
change deliberately withholds, because withholding it is the entire point.
So the two halves are each individually right and mutually incompatible.

A. neither flag        -> 201
B. first flag only     -> 201
C. second flag only    -> 401  permission denied
D. both (what we send) -> 401  permission denied

TAIL_SO_EVERY_WRITE would have failed, retried, and reported nothing —
forever.''';

void main() {
  group('buildAnswerFrames', () {
    test('single-select, single question: the row digit THEN a committing Enter',
        () {
      // The digit alone is not enough. When any option has a `preview` Claude
      // renders the selector side-by-side and the digit only MOVES THE
      // HIGHLIGHT — Enter is what commits. Measured on the real TUI (claude
      // 2.1.220), verdict read from the transcript's AskUserQuestion
      // tool_result, because the screen cannot distinguish highlighted from
      // submitted: preview + `3` => nothing submitted, prompt still up (this is
      // the reported bug — the app looked like it had answered and the question
      // had to be finished by hand in the terminal); preview + `3\r` =>
      // recorded "Fold themes into Home.md". In the compact layout `3` already
      // submits and the extra Enter is a no-op on an empty prompt line, so one
      // sequence is correct for both layouts when there is only one question —
      // no branch needed here. (Multi-question DOES need the branch, and gets it
      // from `hasPreview`; see the tests below.)
      final qs = [_q(['A', 'B', 'C'])];
      expect(_keys(buildAnswerFrames(qs, [
        {0}
      ])), ['1', '\r']);
      expect(_keys(buildAnswerFrames(qs, [
        {2}
      ])), ['3', '\r']);
    });

    test('single-select single question: the committing Enter gets its own read',
        () {
      // A digit+CR folded into ONE stdin read is the paste-burst shape the TUI
      // swallows, so the Enter must carry a real gap — the same rule the rest of
      // the submit contract lives by (never "fix" a submit by changing bytes).
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {2}
      ]);
      expect(frames.last.keys, '\r');
      expect(frames[frames.length - 2].delayMs, greaterThanOrEqualTo(500));
    });

    test('multi-question single-select does NOT get a per-question Enter', () {
      // Guard on the fix above. In the compact layout a multi-question digit
      // AUTO-ADVANCES to the next tab, so an Enter after each digit would land
      // on the NEXT, still-unanswered question and commit its default top row —
      // silently answering something the user never chose. Only the single
      // post-loop Enter (the Submit review) is allowed here.
      final qs = [_q(['A', 'B']), _q(['X', 'Y', 'Z'])];
      final keys = _keys(buildAnswerFrames(qs, [
        {1},
        {0}
      ]));
      expect(keys, ['2', '1', '\r']);
      expect(keys.where((k) => k == '\r').length, 1);
    });

    test('multi-question + PREVIEW: each previewed tab gets a committing Enter',
        () {
      // THE regression, reported 2026-08-03: "the chat lens didn't fill the
      // multiselect part at all even I see and mark it. I had to do it on
      // terminal." The prompt was Q1 single-select whose 3 options all carried
      // previews + Q2 multi-select. Q1 therefore rendered SIDE-BY-SIDE, where a
      // digit only moves the highlight and advances nothing — so every key meant
      // for Q2 landed back on Q1.
      //
      // Reproduced against the real TUI with scripts/rig/probe-askq-layout.js,
      // verdict from the transcript's tool_result:
      //   `2,1,3,→,\r`    -> Q1 left BLANK (tab bar still showed an unticked
      //                      box), nothing submitted, and the trailing Enter
      //                      toggled whichever Q2 row the cursor sat on;
      //   `2,\r,1,3,→,\r` -> "Pick a color"="Green", "Pick fruits"="Apple, Cherry".
      final qs = [
        _q(['Red', 'Green', 'Blue'], preview: true),
        _q(['Apple', 'Banana', 'Cherry', 'Date'], multi: true),
      ];
      expect(
        _keys(buildAnswerFrames(qs, [
          {1},
          {0, 2}
        ])),
        ['2', '\r', '1', '3', '\x1b[C', '\r'],
      );
    });

    test('multi-question + preview: the committing Enter gets its own read', () {
      // Same paste-burst rule as everywhere else in the submit contract — a
      // digit+CR folded into one stdin read is swallowed, so the Enter needs a
      // real temporal gap, never a byte-level trick.
      final frames = buildAnswerFrames([
        _q(['A', 'B'], preview: true),
        _q(['X', 'Y'], multi: true),
      ], [
        {1},
        {0}
      ]);
      expect(frames[0].keys, '2');
      expect(frames[1].keys, '\r');
      expect(frames[0].delayMs, greaterThanOrEqualTo(500));
    });

    test('a previewed tab does not drag its plain siblings side-by-side', () {
      // Layout is per-QUESTION, not per-prompt: measured on claude 2.1.220, a
      // previewed Q1 rendered side-by-side while the same prompt's preview-less
      // Q2 rendered compact. So only the previewed tab may take the Enter — the
      // compact one must keep relying on its digit's auto-advance, or that Enter
      // commits the following tab's default row.
      final qs = [
        _q(['A', 'B'], preview: true),
        _q(['X', 'Y', 'Z']), // plain single-select
      ];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0},
          {2}
        ])),
        ['1', '\r', '3', '\r'],
      );
      final plainFirst = [
        _q(['A', 'B']), // plain single-select
        _q(['X', 'Y', 'Z'], preview: true),
      ];
      expect(
        _keys(buildAnswerFrames(plainFirst, [
          {0},
          {2}
        ])),
        ['1', '3', '\r', '\r'],
      );
    });

    test('multi-select (single question): toggle digits, Right-arrow, "1" (#39)',
        () {
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      // Verified on-device: select A and C -> toggle 1, toggle 3; then Enter
      // would only TOGGLE the highlighted row (never submits), so Right-arrow
      // jumps to the "Submit" review and digit "1" ("Submit answers") finalizes.
      expect(_keys(buildAnswerFrames(qs, [
        {0, 2}
      ])), ['1', '3', '\x1b[C', '1']);
    });

    test('multi-select toggle+submit frames land in separate PTY reads (#39)',
        () {
      // The toggles may coalesce safely (settle), but the Right-arrow and the
      // "1" must each be read separately (a coalesced Right+1 would misfire).
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'], multi: true)], [
        {0, 2}
      ]);
      // last two frames = Right-arrow, then "1"
      expect(frames[frames.length - 2].keys, '\x1b[C');
      expect(frames.last.keys, '1');
      expect(frames[frames.length - 2].delayMs, greaterThanOrEqualTo(500));
      expect(frames.last.delayMs, greaterThanOrEqualTo(500));
    });

    test('multiple questions: a digit per tab, then a final Submit Enter', () {
      final qs = [_q(['A', 'B']), _q(['X', 'Y', 'Z'])];
      // Q1 -> B (digit 2, advances); Q2 -> X (digit 1, advances); Submit (Enter)
      expect(_keys(buildAnswerFrames(qs, [
        {1},
        {0}
      ])), ['2', '1', '\r']);
    });

    test('multi-question + multi-select: advance a multi-select tab with →, not Enter',
        () {
      // The bug: this branch sent Enter to advance, but in the multi-select
      // selector Enter TOGGLES the highlighted row and stays on the tab — so the
      // trailing Enter un-toggled a row and never advanced, later digits fell on
      // the wrong question, and the remaining tabs recorded nothing. Proven on
      // the real Opus-5 TUI (claude 2.1.220): `1,3,Enter,2,Enter` recorded
      // Red+Blue+Green for Q1 and NOTHING for Q2; `1,3,→,2,Enter` recorded
      // Red+Green for Q1 and the Q2 pick correctly. Q1 multi-select {A,C} ->
      // toggle 1, toggle 3, → to next tab; Q2 single {Y} -> digit 2 (advances to
      // the Submit review); trailing Enter finalizes.
      final qs = [_q(['A', 'B', 'C'], multi: true), _q(['X', 'Y', 'Z'])];
      expect(_keys(buildAnswerFrames(qs, [
        {0, 2},
        {1}
      ])), ['1', '3', '\x1b[C', '2', '\r']);
    });

    test('multi-question ending in a multi-select tab: → reaches Submit, Enter finalizes',
        () {
      // A multi-select as the LAST question: the → lands on the Submit review
      // (one tab past the last question), and the single post-loop Enter submits
      // — same endpoint as a single-select last tab.
      final qs = [_q(['A', 'B']), _q(['X', 'Y', 'Z'], multi: true)];
      expect(_keys(buildAnswerFrames(qs, [
        {0},
        {1, 2}
      ])), ['1', '2', '3', '\x1b[C', '\r']);
    });

    test('transition frames use a gap so they land in separate PTY reads', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {1}
      ]);
      expect(frames.first.delayMs, greaterThanOrEqualTo(500));
    });

    test(
        'single-select via Other free-text: "Type something." row, text, submit',
        () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [<int>{}],
        otherText: const ['deploy to staging'],
      );
      // 3 options -> the implied "Type something." row is digit 4; the digit is
      // CONSUMED (selects the row, not part of the answer); then the free text;
      // then Enter submits.
      expect(_keys(frames), ['4', 'deploy to staging', '\r']);
      // All three must land in SEPARATE stdin reads (text+CR in one burst reads
      // as a paste, not a submit) -> each carries the full inter-frame gap.
      for (final f in frames) {
        expect(f.delayMs, greaterThanOrEqualTo(500));
      }
    });

    test('Other free-text is trimmed before it is sent', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [<int>{}], otherText: const ['  hi there '])),
        ['4', 'hi there', '\r'],
      );
    });

    test('multi-select ignores Other entirely (no free-text path)', () {
      // On-device: in multi-select the "Type something." row is a CHECKBOX —
      // digit N+1 only toggles it, it does NOT open a free-text input and any
      // typed text is discarded. So Other is not offered for multi-select and
      // buildAnswerFrames must ignore otherText here, emitting the normal
      // toggle+confirm frames instead.
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0, 2}
        ], otherText: const ['custom'])),
        ['1', '3', '\x1b[C', '1'],
      );
    });

    test('blank/whitespace Other falls back to the numeric selection', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [
          {1}
        ], otherText: const ['   '])),
        ['2', '\r'],
      );
    });

    test('otherText default does not change existing (non-Other) frames', () {
      final qs = [_q(['A', 'B', 'C'])];
      // Regression guard: passing otherText:[null] must be byte-for-byte
      // identical to omitting it entirely.
      expect(
        _keys(buildAnswerFrames(qs, [
          {0}
        ])),
        _keys(buildAnswerFrames(qs, [
          {0}
        ], otherText: const [null])),
      );
    });

    // #143 — this was skipped as "deferred until the TUI mechanism is
    // verified". It has now been verified, and it WORKS. Measured on claude
    // 2.1.234 by driving 4,<text>,CR,1,RIGHT,CR at a real TUI over a real PTY:
    // the transcript recorded BOTH answers — "Pick a color"="freeform answer",
    // "Pick fruits"="Apple". The digit opens a free-text editor and the CR
    // commits it AND advances the tab, exactly as a single-select digit does.
    test('multi-question + Other: the free text IS sent, and the tab advances '
        'on the branch CR (#143 — deferral lifted, measured)', () {
      final qs = [_q(['A', 'B']), _q(['X', 'Y'])];
      final frames = buildAnswerFrames(
        qs,
        [<int>{}, {0}],
        otherText: const ['freeform', null],
      );
      // Q1 goes through Other: "Type something." is row options.length + 1 = 3,
      // then the text, then the CR that commits it and moves to the next tab.
      // Q2 is a plain compact single-select digit. The loop tail then adds the
      // single Submit-review Enter.
      expect(_keys(frames), ['3', 'freeform', '\r', '1', '\r']);
      // Each of the three Other frames must land in its OWN PTY read, or the
      // text+CR burst reads as a paste and submits nothing.
      expect(frames[1].delayMs, greaterThanOrEqualTo(500));
      expect(frames[2].delayMs, greaterThanOrEqualTo(500));
    });

    test('multi-question + Other on the LAST tab: the branch CR advances onto '
        'the Submit review, which the tail Enter finalises (#143)', () {
      // Advancing past the final tab lands on the Submit review rather than
      // another question — the same place #39's Right-arrow lands after the
      // last multi-select tab. Measured on claude 2.1.234 with exactly the
      // sequence below (1,4,<text>,CR,CR): the transcript recorded BOTH answers,
      // "Pick a color"="Red" and "Pick a size"="extra large please".
      final qs = [_q(['Red', 'Green', 'Blue']), _q(['S', 'M', 'L'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {0},
          <int>{}
        ],
        otherText: const [null, 'extra large please'],
      );
      expect(_keys(frames),
          ['1', '4', 'extra large please', '\r', '\r']);
    });

    // #143 — re-measured and the deferral HOLDS, so this is now un-skipped and
    // pins real, verified behaviour rather than an intention.
    test('multi-select + Other stays deferred: the checkbox row has no '
        'free-text input (#143 — re-measured, deferral holds)', () {
      // Measured on claude 2.1.234: pressing the trailing row's digit CHECKS a
      // box ("5. [x] Type something") rather than opening a field, and the
      // typed text is swallowed. Submitting with only that row checked records
      // "The user did not answer the questions." — the WHOLE answer comes back
      // null, which is worse than merely losing the text. So buildAnswerFrames
      // must never emit the free-text path for a multi-select question.
      final qs = [_q(['A', 'B', 'C'], multi: true)];
      final frames = buildAnswerFrames(qs, [<int>{}], otherText: const ['x']);
      expect(_keys(frames), isNot(contains('x')));
    });

    // ---------------------------------------------------------------- #143
    // Other is a COMPACT-layout feature, the exact mirror of notes.
    //
    // Measured on claude 2.1.237, `probe-askq-layout.js --shape preview-single
    // --keys "4,indigo actually,CR"`, verdict from the transcript: the previewed
    // selector lists only "1. Red / 2. Green / 3. Blue" and then "Chat about
    // this" — there is NO "Type something." row. The screens after the digit and
    // after the text were byte-identical to the first render, and the trailing
    // CR committed the still-default top row. Recorded answer:
    // "Pick a color"="Red".
    //
    // So the un-gated branch does not merely lose the free text: it submits an
    // option the user never picked. Both tests below are RED against the code
    // this fix replaces, which emitted ['4', <text>, '\r'] here.
    test('a PREVIEWED single-select takes NO Other path — the side-by-side '
        'selector has no "Type something." row (#143)', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ],
        otherText: const ['indigo actually'],
      );
      // The plain previewed single-select path: land on the row, commit it.
      expect(_keys(frames), ['2', '\r']);
      expect(_keys(frames), isNot(contains('4')));
      expect(_keys(frames), isNot(contains('indigo actually')));
    });

    test('a PREVIEWED tab of a MULTI-QUESTION prompt takes no Other path '
        'either — the lift is compact-only (#143)', () {
      // The #145 shape: a previewed Q1 beside a preview-less Q2. Q1 must fall
      // back to its digit+Enter, and Q2 must keep the compact behaviour the
      // lifted deferral was actually measured on.
      final qs = [
        _q(['Red', 'Green', 'Blue'], preview: true),
        _q(['S', 'M', 'L']),
      ];
      final frames = buildAnswerFrames(
        qs,
        [
          {2},
          <int>{}
        ],
        otherText: const ['indigo actually', 'extra large please'],
      );
      expect(_keys(frames),
          ['3', '\r', '4', 'extra large please', '\r', '\r']);
      expect(_keys(frames), isNot(contains('indigo actually')));
    });
  });

  group('buildAnswerFrames — note attached to an option (#64 Gap 1)', () {
    // #143 — every note test below uses `preview: true`. Notes are a
    // SIDE-BY-SIDE-layout feature: the previewed selector's footer advertises
    // "n to add notes" and honours the key, and the compact one does neither.
    // The compact case has its own test at the end of this group, and it is the
    // one that is RED without the fix.

    test(
        'note on an already-chosen option: highlight move, n, note text, ESC, '
        'commit — as SEPARATE frames', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ], // "B" already chosen (index 1)
        noteText: const ['please clarify the deploy target'],
      );
      // Measured on claude 2.1.234: the default highlight is the top row, so
      // one Down-arrow reaches index 1; n opens the note editor; the text; then
      // ESC closes the EDITOR (not the question) so the trailing CR is free to
      // commit the highlighted option WITH the note. Without the ESC the CR is
      // eaten by the editor and the answer records "(no option selected)".
      expect(_keys(frames), [
        '\x1b[B',
        'n',
        'please clarify the deploy target',
        '\x1b',
        '\r',
      ]);
      // n / note text / ESC / commit must each land in a SEPARATE PTY read.
      expect(frames[1].delayMs, greaterThanOrEqualTo(500));
      expect(frames[2].delayMs, greaterThanOrEqualTo(500));
      expect(frames[3].delayMs, greaterThanOrEqualTo(500));
      expect(frames[4].delayMs, greaterThanOrEqualTo(500));
    });

    test('the ESC comes BEFORE the committing CR, and exactly once', () {
      // Pins the ordering that the whole fix rests on. A lone ESC after the CR
      // would cancel nothing and leave the note uncommitted; two ESCs would
      // close the editor and then cancel the question.
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final keys = _keys(buildAnswerFrames(qs, [
        {0}
      ], noteText: const ['why not']));
      expect(keys.where((k) => k == '\x1b').length, 1);
      expect(keys.indexOf('\x1b'), lessThan(keys.lastIndexOf('\r')));
      expect(keys.last, '\r');
    });

    test('note on the first option (index 0): no highlight move needed', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final frames = buildAnswerFrames(
        qs,
        [
          {0}
        ],
        noteText: const ['note for A'],
      );
      expect(_keys(frames), ['n', 'note for A', '\x1b', '\r']);
    });

    test('note on the third option: TWO highlight-move frames first', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final frames = buildAnswerFrames(
        qs,
        [
          {2}
        ],
        noteText: const ['note for C'],
      );
      expect(_keys(frames),
          ['\x1b[B', '\x1b[B', 'n', 'note for C', '\x1b', '\r']);
    });

    test('note text is trimmed before it is sent', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0}
        ], noteText: const ['  hi  '])),
        ['n', 'hi', '\x1b', '\r'],
      );
    });

    test('blank/whitespace note falls back to the plain digit path (no note)',
        () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      expect(
        _keys(buildAnswerFrames(qs, [
          {1}
        ], noteText: const ['   '])),
        ['2', '\r'],
      );
    });

    test('no note set does not change the existing single-select path '
        '(regression guard)', () {
      final qs = [_q(['A', 'B', 'C'])];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0}
        ])),
        _keys(buildAnswerFrames(qs, [
          {0}
        ], noteText: const [null])),
      );
    });

    test('note is ignored when no option is selected yet (falls back to the '
        'plain digit path, defaulting to row 1)', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      expect(
        _keys(buildAnswerFrames(qs, [<int>{}], noteText: const ['orphan'])),
        ['1', '\r'],
      );
    });

    test(
        'when BOTH are set on a COMPACT question, Other wins and the note is '
        'never sent (mutually exclusive at the UI layer, but buildAnswerFrames '
        'must still resolve deterministically)', () {
      final qs = [_q(['A', 'B', 'C'])];
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ],
        otherText: const ['free text answer'],
        noteText: const ['should never appear'],
      );
      expect(_keys(frames), ['4', 'free text answer', '\r']);
      expect(_keys(frames), isNot(contains('should never appear')));
    });

    test(
        'when BOTH are set on a PREVIEWED question the NOTE wins — the layout '
        'decides, not the branch order (#143)', () {
      // Since #143 gated each affordance to the layout that actually has it,
      // "Other is checked first" no longer means "Other always wins": on a
      // previewed card the Other branch is not eligible at all, so the note
      // takes it. The UI can no longer produce this state (a card shows one
      // affordance or the other, never both), but the pure function is public
      // and must still resolve it the way the TUI would.
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ],
        otherText: const ['should never appear'],
        noteText: const ['a real note'],
      );
      expect(_keys(frames), ['\x1b[B', 'n', 'a real note', '\x1b', '\r']);
      expect(_keys(frames), isNot(contains('should never appear')));
    });

    test(
        'note state is independent of otherText: a note-only call never '
        'touches the Other path', () {
      final qs = [_q(['A', 'B', 'C'], preview: true)];
      final frames = buildAnswerFrames(
        qs,
        [
          {0}
        ],
        noteText: const ['just a note'],
      );
      // No "Type something." row digit (options.length + 1 == "4") appears —
      // this went through the note path, not Other's.
      expect(_keys(frames), isNot(contains('4')));
      expect(_keys(frames), ['n', 'just a note', '\x1b', '\r']);
    });

    test('note is ignored for multi-select (same deferred scope as Other)',
        () {
      final qs = [_q(['A', 'B', 'C'], multi: true, preview: true)];
      expect(
        _keys(buildAnswerFrames(qs, [
          {0, 2}
        ], noteText: const ['x'])),
        ['1', '3', '\x1b[C', '1'],
      );
    });

    test('note is ignored for multi-question (same deferred scope as Other)',
        () {
      final qs = [
        _q(['A', 'B'], preview: true),
        _q(['X', 'Y'], preview: true),
      ];
      final frames = buildAnswerFrames(
        qs,
        [
          {1},
          {0}
        ],
        noteText: const ['x', null],
      );
      expect(_keys(frames), isNot(contains('x')));
    });

    // ---------------------------------------------------------------- #143
    // THE regression test: red without the fix.
    //
    // Against the pre-#143 code this question (no previews) emitted
    // ['\x1b[B', 'n', 'ship it', '\r'] — and on a real compact selector the n
    // and the text are both ignored, so what actually reached Claude was a
    // bare, correct selection with the note thrown away in silence. Nothing
    // looked wrong, which is why it survived to ship.
    test('COMPACT single-select takes NO note path — the TUI has no notes '
        'feature there, so the note must not be silently swallowed (#143)', () {
      final qs = [_q(['A', 'B', 'C'])]; // preview: false — compact layout
      final frames = buildAnswerFrames(
        qs,
        [
          {1}
        ],
        noteText: const ['ship it'],
      );
      // Plain digit path, exactly as if no note had been offered at all.
      expect(_keys(frames), ['2', '\r']);
      expect(_keys(frames), isNot(contains('n')));
      expect(_keys(frames), isNot(contains('ship it')));
      expect(_keys(frames), isNot(contains('\x1b')));
    });

    test('a compact question and a previewed one with the SAME note diverge '
        '— proof the gate is hasPreview and nothing else (#143)', () {
      final compact = _keys(buildAnswerFrames([
        _q(['A', 'B', 'C'])
      ], [
        {0}
      ], noteText: const ['same note']));
      final previewed = _keys(buildAnswerFrames([
        _q(['A', 'B', 'C'], preview: true)
      ], [
        {0}
      ], noteText: const ['same note']));
      expect(compact, ['1', '\r']);
      expect(previewed, ['n', 'same note', '\x1b', '\r']);
      expect(compact, isNot(previewed));
    });
  });

  group('answerNeedsConfirm (cluster-path Enter re-send gate)', () {
    test('single-select single question NEEDS a confirm (it ends in the '
        'committing Enter)', () {
      // Was isFalse while the digit was believed to always auto-submit. It does
      // not: in the preview (side-by-side) layout a digit only moves the
      // highlight, so the sequence now ends in an explicit Enter — and because
      // answerNeedsConfirm is DERIVED from the frames, the resend-once recovery
      // in _verifyAnswerLanded starts covering this shape for free, which is
      // exactly what a dropped answer needed.
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [
        {1}
      ]);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('multi-select (single question) needs no confirm — ends in digit "1"',
        () {
      // #39: the sequence now ends in "1" ("Submit answers"), which auto-submits
      // like a single-select digit. A re-sent Enter would toggle a row, so this
      // must NOT trigger the confirm re-send.
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'], multi: true)], [
        {0, 2}
      ]);
      expect(answerNeedsConfirm(frames), isFalse);
    });

    test('multi-question needs a confirm (Submit-review Enter)', () {
      final frames = buildAnswerFrames([_q(['A', 'B']), _q(['X', 'Y'])], [
        {0},
        {1}
      ]);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('Other free-text answer ends in Enter -> needs confirm', () {
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'])], [<int>{}],
          otherText: const ['hello']);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('note (#64 Gap 1) ends in Enter -> needs confirm', () {
      // preview: true, or this never enters the note branch at all (#143) and
      // the test passes on the plain digit path under a note's title — an
      // assertion that would survive the note path being deleted outright.
      final frames = buildAnswerFrames([_q(['A', 'B', 'C'], preview: true)], [
        {1}
      ], noteText: const ['a note']);
      expect(_keys(frames), ['\x1b[B', 'n', 'a note', '\x1b', '\r']);
      expect(answerNeedsConfirm(frames), isTrue);
    });

    test('empty frame list needs no confirm', () {
      expect(answerNeedsConfirm(const []), isFalse);
    });
  });

  group('PendingQuestion.fromJson', () {
    test('pending:false -> null', () {
      expect(PendingQuestion.fromJson({'pending': false}), isNull);
      expect(PendingQuestion.fromJson({}), isNull);
    });

    test('parses questions + options', () {
      final pq = PendingQuestion.fromJson({
        'pending': true,
        'question': {
          'toolUseId': 'toolu_1',
          'questions': [
            {
              'header': 'DB',
              'question': 'Which database?',
              'multiSelect': false,
              'options': [
                {'label': 'Postgres', 'description': 'default'},
                {'label': 'MySQL'},
              ],
            },
          ],
        },
      });
      expect(pq, isNotNull);
      expect(pq!.toolUseId, 'toolu_1');
      expect(pq.questions.single.options.map((o) => o.label),
          ['Postgres', 'MySQL']);
    });

    test('empty questions -> null', () {
      expect(
        PendingQuestion.fromJson({
          'pending': true,
          'question': {'toolUseId': 't', 'questions': []},
        }),
        isNull,
      );
    });
  });

  group('lastAssistantText (question context)', () {
    test('returns the most recent non-empty assistant turn', () {
      final turns = [
        const TranscriptTurn(role: 'assistant', text: 'old', toolUses: [], ts: null),
        const TranscriptTurn(role: 'user', text: 'hi', toolUses: [], ts: null),
        const TranscriptTurn(
            role: 'assistant', text: 'the full answer', toolUses: [], ts: null),
        const TranscriptTurn(role: 'user', text: 'ok', toolUses: [], ts: null),
      ];
      expect(lastAssistantText(turns), 'the full answer');
    });

    test('skips empty assistant turns; null when none', () {
      expect(
        lastAssistantText(const [
          TranscriptTurn(role: 'assistant', text: '   ', toolUses: [], ts: null),
          TranscriptTurn(role: 'user', text: 'x', toolUses: [], ts: null),
        ]),
        isNull,
      );
      expect(lastAssistantText(const []), isNull);
    });
  });

  testWidgets('shows Claude\'s preceding message as context when provided',
      (tester) async {
    // A roomy card: since #108 the lead-up starts collapsed when there is no
    // room for it, and this test is about it being SHOWN, not about the budget.
    tester.view.physicalSize = const Size(1200, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'tc',
                  questions: [_q(['A', 'B'])],
                ),
                contextText:
                    'Here is the FULL_ANSWER_CONTEXT that led to the question.',
                onSend: (_) {},
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Claude said'), findsOneWidget);
    expect(find.textContaining('FULL_ANSWER_CONTEXT'), findsOneWidget);
  });

  testWidgets(
      'a LONG lead-up gets a viewport scaled to the card, starts at the top, '
      'and advertises that there is more to read', (tester) async {
    // Reported 2026-08-05 (XPS session, Windows companion, chat lens): the
    // options "change the app" vs "change only the database" could not be
    // judged, because the panel showed only the closing paragraph of a
    // 997-char lead-up. Everything that explained the choice — the defect, and
    // the 201/401 table proving it — sat above the fold behind a fixed 160px
    // window (a 116px viewport once the label and padding were taken) with NO
    // scrollbar, so nothing suggested there was more to read. The text was all
    // present; it simply was not what you saw.
    //
    // The short-context test above always fitted, which is exactly why this
    // shipped: a one-line fixture cannot see a clipping bug.
    tester.view.physicalSize = const Size(1200, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'tlong',
                  questions: [_q(['change the app', 'change the database'])],
                ),
                contextText: _longLeadUp,
                onSend: (_) {},
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Anchored on the MarkdownBody since #108 made the lead-up rendered rather
    // than a plain Text — markdown emits RichText, so a `w is Text` predicate
    // finds nothing. What this test pins is unchanged.
    final ctxText = find.byType(MarkdownBody);
    expect(ctxText, findsOneWidget);

    // The lead-up IS the reasoning, so on a roomy window it must get a real
    // share of the card rather than the sliver that caused the report.
    //
    // The floor reads 200, not the 240 this test shipped with. It was NOT
    // lowered to accommodate a regression: #94 found the opposite failure on a
    // phone — the lead-up's share had grown large enough to leave the options
    // less room than the question alone needed — and rebalancing it moved this
    // viewport from ~282 to ~228 while the option list on the same screen went
    // 198 -> ~340. What this test defends is the ORIGINAL defect, a lead-up
    // pinned to a fixed sliver regardless of card size: that was 116px, and any
    // number in this range is still nearly double it. The panel also gained an
    // expander since, so its full text is one tap away rather than lost.
    final viewport = find.ancestor(
      of: ctxText,
      matching: find.byType(SingleChildScrollView),
    );
    expect(tester.getSize(viewport).height, greaterThanOrEqualTo(200.0));

    // A clipped panel with no thumb reads as a COMPLETE message — the thumb is
    // the only thing that says "there is more above/below".
    expect(
      find.ancestor(of: ctxText, matching: find.byType(Scrollbar)),
      findsOneWidget,
    );

    // Guards the other half of the report: what you see first must be the
    // BEGINNING of the explanation, never its tail.
    final position = tester
        .state<ScrollableState>(
          find.ancestor(of: ctxText, matching: find.byType(Scrollable)).first,
        )
        .position;
    expect(position.pixels, 0.0);
  });

  testWidgets(
      'typing a free-text (Other) answer frees vertical room: the context panel '
      'and the numeric-nav keys hide so the input + Send stay above the keyboard',
      (tester) async {
    // The reported bug: with the soft keyboard up, the fixed "Claude said" panel
    // and the ^/v/Space/Tab/Enter row over-filled the card and clipped the field +
    // Send button — you could not see what you were typing. Both are useless while
    // free-texting, so they collapse in that mode.
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'tk',
                  questions: [_q(['A', 'B'])], // single-select single → Other offered
                ),
                contextText: 'CTX_CLAUDE_SAID that should hide while typing.',
                onSend: (_) {},
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Numeric mode: the space-eaters are present.
    expect(find.text('Claude said'), findsOneWidget);
    // Reveal the raw keys first (#108 hides them by default), so that their
    // disappearance below is caused by the text field, not by the default.
    await tester.tap(find.byTooltip('Show raw keys'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(OutlinedButton, 'Space'), findsOneWidget);

    // Enter free-text mode and type an answer.
    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'my typed answer');
    await tester.pumpAndSettle();

    // The context panel + nav-key row are gone; the field + Send remain visible.
    expect(find.text('Claude said'), findsNothing);
    expect(find.textContaining('CTX_CLAUDE_SAID'), findsNothing);
    expect(find.widgetWithText(OutlinedButton, 'Space'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Send answer'), findsOneWidget);
  });

  testWidgets('select an option then Send forwards the built frames',
      (tester) async {
    List<AnswerFrame>? sent;
    final pq = PendingQuestion(
      toolUseId: 't1',
      questions: [_q(['Alpha', 'Beta', 'Gamma'])],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: pq,
                onSend: (s) => sent = s,
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Send is disabled until an option is chosen.
    final sendFinder = find.widgetWithText(FilledButton, 'Pick an option');
    expect(tester.widget<FilledButton>(sendFinder).onPressed, isNull);

    await tester.tap(find.text('Gamma'));
    await tester.pumpAndSettle();

    final ready = find.widgetWithText(FilledButton, 'Send answer');
    expect(tester.widget<FilledButton>(ready).onPressed, isNotNull);
    await tester.tap(ready);
    await tester.pumpAndSettle();

    // Gamma is index 2 -> the absolute row digit "3", then the committing
    // Enter (a digit alone does not submit in the preview layout).
    expect(_keys(sent!), ['3', '\r']);
  });

  testWidgets('manual Enter key button forwards a raw CR', (tester) async {
    String? key;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 't2',
                  questions: [_q(['A', 'B'])],
                ),
                onSend: (_) {},
                onKey: (s) => key = s,
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // The raw-key row is hidden until asked for (#108).
    await tester.tap(find.byTooltip('Show raw keys'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(OutlinedButton, 'Enter'));
    await tester.pump();
    expect(key, '\r');
  });

  testWidgets(
      '#50: hardware Tab forwards to the PTY; arrows stay with a focused field',
      (tester) async {
    final keys = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 't50',
                  questions: [_q(['A', 'B'])], // single-select → Other offered
                ),
                onSend: (_) {},
                onKey: keys.add,
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Reveal + autofocus the free-text ("Other") field, so a control inside the
    // overlay's Shortcuts subtree holds focus.
    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    // Hardware Tab is NOT consumed by a text field → the overlay Shortcuts
    // forwards it to the PTY (drives Claude's TUI, e.g. /status tabs).
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.pump();
    expect(keys, ['\t']);

    // A hardware arrow IS consumed by the focused field (caret nav) before the
    // ancestor Shortcuts sees it → not forwarded, so typing in Other still works.
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump();
    expect(keys, ['\t']); // unchanged
  });

  testWidgets('#50: hardware arrows forward to the PTY from a focused overlay button',
      (tester) async {
    final keys = <String>[];
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 't50b',
                  questions: [_q(['A', 'B'])],
                ),
                onSend: (_) {},
                onKey: keys.add,
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Focus a non-text overlay control (Other is inactive → no free-text field),
    // then prove a HARDWARE arrow is forwarded to the PTY rather than moving the
    // app's focus ring.
    FocusScope.of(tester.element(find.byType(QuestionOverlay))).nextFocus();
    await tester.pump();

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    expect(keys, ['\x1b[B']);
  });

  testWidgets(
      'Other row reveals a field; Send gated on text; sends digit+text+Enter',
      (tester) async {
    List<AnswerFrame>? sent;
    final pq = PendingQuestion(
      toolUseId: 'other1',
      questions: [_q(['Alpha', 'Beta', 'Gamma'])],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: pq,
                onSend: (s) => sent = s,
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    // Nothing picked yet -> Send disabled, no free-text field shown.
    expect(find.byType(TextField), findsNothing);
    expect(
      tester
          .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Pick an option'))
          .onPressed,
      isNull,
    );

    // Choose the free-text ("Other") row -> a field appears.
    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsOneWidget);

    // Gating: still disabled while the field is empty.
    expect(
      tester
          .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Pick an option'))
          .onPressed,
      isNull,
    );

    await tester.enterText(find.byType(TextField), 'deploy to staging');
    await tester.pumpAndSettle();

    final ready = find.widgetWithText(FilledButton, 'Send answer');
    expect(tester.widget<FilledButton>(ready).onPressed, isNotNull);
    await tester.tap(ready);
    await tester.pumpAndSettle();

    // 3 options -> "Type something." is row 4, then the text, then submit.
    expect(_keys(sent!), ['4', 'deploy to staging', '\r']);
  });

  testWidgets('picking a listed option after Other exits free-text mode',
      (tester) async {
    List<AnswerFrame>? sent;
    final pq = PendingQuestion(
      toolUseId: 'other2',
      questions: [_q(['Alpha', 'Beta', 'Gamma'])],
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: pq,
                onSend: (s) => sent = s,
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );

    await tester.tap(find.text('Other…'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'ignore me');
    await tester.pumpAndSettle();

    // Switching back to a real option must clear Other (field disappears) and
    // send the plain row digit, not the free text.
    await tester.tap(find.text('Beta'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
    await tester.pumpAndSettle();
    expect(_keys(sent!), ['2', '\r']);
  });

  group('note attached to a selected option (#64 Gap 1)', () {
    // #143: these drive a PREVIEWED question, because that is the only layout
    // where Claude's selector has a notes feature at all. The compact case has
    // its own widget test at the end of this group asserting the affordance is
    // absent — offering it there promised something the TUI cannot receive.
    testWidgets(
        'affordance hidden until a real option is picked; toggling it '
        'reveals a field; Send emits select-move + n + note + ESC + commit',
        (tester) async {
      List<AnswerFrame>? sent;
      final pq = PendingQuestion(
        toolUseId: 'note1',
        questions: [_q(['Alpha', 'Beta', 'Gamma'], preview: true)],
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: pq,
                  onSend: (s) => sent = s,
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // No option picked yet -> no note affordance.
      expect(find.text('Add a note'), findsNothing);

      await tester.tap(find.text('Beta')); // index 1
      await tester.pumpAndSettle();

      // Now the affordance appears, but the field is not revealed yet.
      expect(find.text('Add a note'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.text('Add a note'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Remove note'), findsOneWidget);

      await tester.enterText(
          find.byType(TextField), 'please explain the tradeoffs');
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      // Beta is index 1 -> one Down-arrow to reach it, then n, the note, the
      // ESC that closes the editor, then the CR that commits the option.
      expect(_keys(sent!),
          ['\x1b[B', 'n', 'please explain the tradeoffs', '\x1b', '\r']);
    });

    testWidgets(
        'a PREVIEWED card offers the note and NOT Other — the two affordances '
        'mirror the two layouts and never coexist (#143)',
        (tester) async {
      final pq = PendingQuestion(
        toolUseId: 'note2',
        questions: [_q(['Alpha', 'Beta'], preview: true)],
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: pq,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The Other row is absent before anything is picked and stays absent
      // after — this card is side-by-side, and that selector has no
      // "Type something." row for the text to land in (measured; see the
      // buildAnswerFrames tests). Red against the pre-fix overlay, which
      // rendered "Other…" on every single-select question.
      expect(find.text('Other…'), findsNothing);

      await tester.tap(find.text('Alpha'));
      await tester.pumpAndSettle();
      expect(find.text('Other…'), findsNothing);

      // The note is what this layout DOES have, and it owns the only text
      // field on the card, so its content can never be confused with Other's.
      await tester.tap(find.text('Add a note'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'note text');
      await tester.pumpAndSettle();
      expect(find.text('Other…'), findsNothing);
    });

    // The other half of the mirror: a COMPACT card offers Other and no note.
    // Together with the test above this pins "one affordance per layout, never
    // both" from the UI side, which is what the state the pure resolution test
    // covers can no longer be reached through.
    testWidgets(
        'a COMPACT card offers Other and NOT the note affordance (#143)',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'note2b',
                    questions: [_q(['Alpha', 'Beta'])], // compact
                  ),
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Other…'), findsOneWidget);
      await tester.tap(find.text('Alpha'));
      await tester.pumpAndSettle();
      expect(find.text('Other…'), findsOneWidget);
      expect(find.text('Add a note'), findsNothing);
    });

    testWidgets('note affordance is not offered for a multi-select question',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'msnote1',
                    questions: [
                      _q(['Alpha', 'Beta', 'Gamma'], multi: true)
                    ],
                  ),
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Alpha'));
      await tester.pumpAndSettle();
      expect(find.text('Add a note'), findsNothing);
    });

    // #143 — the UI half of the regression test. Before the fix this rendered
    // "+ Add a note" on a compact question, took the user's text, reported a
    // successful send, and delivered a note the TUI had already thrown away.
    testWidgets(
        'COMPACT question offers NO note affordance — Claude has no notes '
        'feature in that layout (#143)', (tester) async {
      List<AnswerFrame>? sent;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'compactnote1',
                    // preview: false — the compact selector.
                    questions: [_q(['Alpha', 'Beta', 'Gamma'])],
                  ),
                  onSend: (s) => sent = s,
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Beta'));
      await tester.pumpAndSettle();

      // Picking an option is exactly the state that used to reveal it.
      expect(find.text('Add a note'), findsNothing);

      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();
      expect(_keys(sent!), ['2', '\r']);
    });

    testWidgets(
        'no note set does not regress the plain single-select Send path',
        (tester) async {
      List<AnswerFrame>? sent;
      final pq = PendingQuestion(
        toolUseId: 'note3',
        questions: [_q(['Alpha', 'Beta', 'Gamma'], preview: true)],
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: pq,
                  onSend: (s) => sent = s,
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Gamma'));
      await tester.pumpAndSettle();
      // The note affordance appeared but was never tapped -> no note active.
      expect(find.text('Add a note'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      expect(_keys(sent!), ['3', '\r']);
    });

    // #143 x #145. The note affordance is rendered AFTER the option list and
    // inside the same scroll view, and a previewed row opens a block up to
    // kPreviewMaxLines tall directly above it. On a phone the option list gets
    // kOptionFloor (~two rows), and _revealPreview then aligns the selected
    // tile's BOTTOM with the viewport bottom — which is precisely where the
    // affordance sits. So the very act of selecting an option pushes the note
    // affordance out of view; the question this pins is whether it is still
    // REACHABLE by scrolling, because an unreachable affordance is the same
    // "shipped and unseeable" failure #145 was reported for.
    //
    // Asserted against the SCROLL VIEWPORT, not the screen: getRect returns
    // unclipped positions, so "is it on screen" answers yes for a row scrolled
    // well out of sight (#94).
    testWidgets(
        'on a PHONE the note affordance is still reachable under a revealed '
        'preview block (#143 x #145)', (tester) async {
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final tallPreview = [for (var i = 0; i < 14; i++) 'line $i'].join('\n');
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'notephone',
                    questions: [
                      PendingQuestionItem(
                        header: 'Ship',
                        question: 'Pick one',
                        multiSelect: false,
                        hasPreview: true,
                        options: [
                          for (final label in const [
                            'First', 'Second', 'Third', 'Fourth', 'Fifth',
                          ])
                            QuestionOption(
                                label: label, preview: 'body of $label'),
                          QuestionOption(label: 'Sixth', preview: tallPreview),
                        ],
                      ),
                    ],
                  ),
                  contextText: _longLeadUp,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final list = find
          .ancestor(
            of: find.text('First'),
            matching: find.byType(SingleChildScrollView),
          )
          .first;
      final scrollable =
          find.descendant(of: list, matching: find.byType(Scrollable)).first;

      // Pick the LAST option — the worst case, and the one #145 was reported
      // from: its preview is the tallest and it sits at the very bottom.
      await tester.scrollUntilVisible(find.text('Sixth'), 120,
          scrollable: scrollable);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sixth'));
      await tester.pumpAndSettle();

      // It exists in the tree, but that alone proves nothing about reach.
      // MEASURED at this point: the affordance sits at 844..860 in a 404..836
      // viewport - fully below the fold, exactly as the concern predicted. So
      // the scroll below is doing real work and this test is not vacuous.
      expect(find.text('Add a note'), findsOneWidget);

      await tester.scrollUntilVisible(find.text('Add a note'), 120,
          scrollable: scrollable);
      await tester.pumpAndSettle();

      final viewport = tester.getRect(list);
      final rect = tester.getRect(find.text('Add a note'));
      expect(rect.bottom, lessThanOrEqualTo(viewport.bottom + 0.5),
          reason: 'the note affordance cannot be scrolled fully into the '
              'option viewport under a revealed preview block');
      expect(rect.top, greaterThanOrEqualTo(viewport.top - 0.5));

      // And it still WORKS once reached — reachable but inert would be the
      // same defect wearing a different hat.
      await tester.tap(find.text('Add a note'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsOneWidget);
    });
  });

  group('hardware Enter submits the selection (#64 Gap 2)', () {
    testWidgets(
        'select an option then a real hardware Enter sends the SAME frames '
        'as tapping Send', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        List<AnswerFrame>? sent;
        final pq = PendingQuestion(
          toolUseId: 'enter1',
          questions: [_q(['Alpha', 'Beta', 'Gamma'])],
        );
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            home: Scaffold(
              body: Stack(
                children: [
                  QuestionOverlay(
                    question: pq,
                    onSend: (s) => sent = s,
                    onKey: (_) {},
                    onDismiss: () {},
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.text('Gamma'));
        await tester.pumpAndSettle();

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();

        // Gamma is index 2 -> the same absolute row digit "3" the Send
        // button would have sent (see 'select an option then Send forwards
        // the built frames' above).
        expect(sent, isNotNull);
        expect(_keys(sent!), ['3', '\r']);
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets('Enter before any option is picked is a no-op', (tester) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      try {
        List<AnswerFrame>? sent;
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.dark,
            home: Scaffold(
              body: Stack(
                children: [
                  QuestionOverlay(
                    question: PendingQuestion(
                      toolUseId: 'enter2',
                      questions: [_q(['A', 'B'])],
                    ),
                    onSend: (s) => sent = s,
                    onKey: (_) {},
                    onDismiss: () {},
                  ),
                ],
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();

        expect(sent, isNull, reason: 'an incomplete selection must not submit');
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    });

    testWidgets(
        'on Android/iOS Enter is NOT bound — a soft-keyboard Enter must not '
        'submit (#55 mobile contract)', (tester) async {
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        debugDefaultTargetPlatformOverride = platform;
        try {
          List<AnswerFrame>? sent;
          final pq = PendingQuestion(
            toolUseId: 'enter3-$platform',
            questions: [_q(['Alpha', 'Beta'])],
          );
          await tester.pumpWidget(
            MaterialApp(
              theme: AppTheme.dark,
              home: Scaffold(
                body: Stack(
                  children: [
                    QuestionOverlay(
                      question: pq,
                      onSend: (s) => sent = s,
                      onKey: (_) {},
                      onDismiss: () {},
                    ),
                  ],
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();

          await tester.tap(find.text('Beta'));
          await tester.pumpAndSettle();

          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pump();

          expect(
            sent,
            isNull,
            reason: 'mobile Enter must stay unbound (newline/no-op), '
                'per the #55 platform contract',
          );

          // The Send button still works — mobile just relies on it instead
          // of the key.
          await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
          await tester.pumpAndSettle();
          expect(_keys(sent!), ['2', '\r']);
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      }
    });
  });

  testWidgets('Other row is not offered for a multi-select question',
      (tester) async {
    // Multi-select's "Type something." row is a TUI checkbox that never opens a
    // free-text input (on-device verified), so the overlay must not offer Other.
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'ms1',
                  questions: [_q(['Alpha', 'Beta', 'Gamma'], multi: true)],
                ),
                onSend: (_) {},
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Other…'), findsNothing);
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('#108: the lead-up is RENDERED markdown, not raw syntax',
      (tester) async {
    // Reported 2026-08-12 with a screenshot: the "Claude said" panel showed
    // literal `**6 approved and marked Committed, 1 rejected.**`, a literal
    // `## Branch pushed`, and backticked refs still wearing their backticks.
    // The one block you must read carefully in order to judge the options was
    // the only place in the app where the agent's formatting was stripped.
    const raw = '## Branch pushed\n\n'
        '**6 approved and marked Committed, 1 rejected.**\n\n'
        'Pushed `origin/feature/journal-unified` at `10f65c80da`.';

    // A roomy card, so the lead-up is open by default and there is a body to
    // assert on: on a cramped one it now starts collapsed (#108), which is a
    // different behaviour with its own test below.
    tester.view.physicalSize = const Size(1200, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Stack(
            children: [
              QuestionOverlay(
                question: PendingQuestion(
                  toolUseId: 'md',
                  questions: [_q(['Keep', 'Revert'])],
                ),
                contextText: raw,
                onSend: (_) {},
                onKey: (_) {},
                onDismiss: () {},
              ),
            ],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Rendered by the SHARED chat-lens renderer, not a second one.
    expect(find.byType(MarkdownBody), findsOneWidget);

    // And the syntax itself is gone from the tree. This is the assertion that
    // is red against the old plain Text, which carried `raw` verbatim.
    final literal = find.byWidgetPredicate(
      (w) => w is Text && (w.data ?? '').contains('**'),
    );
    expect(literal, findsNothing);
    final heading = find.byWidgetPredicate(
      (w) => w is Text && (w.data ?? '').contains('## '),
    );
    expect(heading, findsNothing);
  });

  group('#94 — answering from a phone', () {
    // Reported from mobile: "when a question comes up the context isn't clear
    // and the actual question text is sometimes missing", so the answer had to
    // be given in the terminal instead — where the narrow window wraps Claude's
    // boxed selector into unreadable lines.
    //
    // Measured on a 412x915 phone before the fix, with the fixture below:
    //
    //   option-list viewport   198px
    //   the question text      192px of it
    //   options fully visible  0 of 4
    //   nav-key strip          overflowed by 7.3px
    //
    // Nothing was missing and nothing was stale — the card gave the lead-up a
    // flat 45% and capped itself at 720px, so the answering half was left less
    // room than the question alone needed. You saw the reasoning and not one
    // option; scrolling to find them pushed the question off screen, which is
    // the "question text is missing" half of the same report.
    //
    // Every existing overlay test ran at the 800x600 harness default or wider,
    // which is exactly why this shipped — the squeeze only bites once the fixed
    // header and footer are a large share of a short card.

    /// A realistically hard case: a long lead-up, a question that runs to
    /// several lines, and four options that each carry a description.
    PendingQuestionItem mobileQuestion() => const PendingQuestionItem(
          header: 'Scope',
          question: 'QMARK Should the fix change the app so it stops asking '
              'for the conflict check, or change the database so that the '
              'check is permitted?',
          multiSelect: false,
          hasPreview: false,
          options: [
            QuestionOption(
                label: 'Change the app',
                description:
                    'Drop the retry-safe header; tolerate duplicates instead.'),
            QuestionOption(
                label: 'Change the database',
                description:
                    'Grant the read the conflict check needs, narrowed to '
                    'this table.'),
            QuestionOption(
                label: 'Both',
                description: 'Belt and braces; a wider blast radius.'),
            QuestionOption(
                label: 'Neither — revert',
                description: 'Back it out and rethink the approach.'),
          ],
        );

    Future<void> pumpPhone(WidgetTester tester) async {
      // A Pixel-class phone in logical pixels. NOT the 800x600 default: the
      // whole defect is a short-card squeeze and a roomy harness hides it.
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'm94',
                    questions: [mobileQuestion()],
                  ),
                  contextText: _longLeadUp,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    /// The scroll viewport that owns the options — the band an option must fall
    /// inside to be reachable without scrolling. Asserting on the SCREEN rect
    /// instead would pass while the option sat clipped outside its own
    /// viewport, which is how the first cut of this test overstated the fix.
    Rect optionViewport(WidgetTester tester) => tester.getRect(find
        .ancestor(
          of: find.text('Change the app'),
          matching: find.byType(SingleChildScrollView),
        )
        .first);

    int visibleOptions(WidgetTester tester) {
      final vp = optionViewport(tester);
      var n = 0;
      for (final label in const [
        'Change the app',
        'Change the database',
        'Both',
        'Neither — revert',
      ]) {
        if (tester.getRect(find.text(label)).bottom <= vp.bottom + 0.5) n++;
      }
      return n;
    }

    testWidgets('options are reachable without scrolling', (tester) async {
      await pumpPhone(tester);
      // Was 0. The card exists so a question can be answered from it; an
      // overlay showing no option at all is one you have to leave.
      expect(visibleOptions(tester), greaterThanOrEqualTo(2));
    });

    testWidgets('the question is fully readable without scrolling it',
        (tester) async {
      await pumpPhone(tester);
      final text = find.textContaining('QMARK');
      expect(text, findsOneWidget);
      final vp = tester.getRect(
          find.ancestor(of: text, matching: find.byType(SingleChildScrollView))
              .first);
      expect(tester.getRect(text).height, lessThanOrEqualTo(vp.height + 0.5));
    });

    testWidgets('the question stays on screen while you scroll the options',
        (tester) async {
      // The sharpest statement of "the actual question text is missing": it
      // used to be the first child of the OPTION scroll view, so the very act
      // of scrolling down to reach an option carried it away. You could see
      // what you were choosing between, or what you were choosing FOR, never
      // both at once. It is now pinned outside that view.
      await pumpPhone(tester);
      final text = find.textContaining('QMARK');
      final questionBefore = tester.getRect(text);
      final optionBefore = tester.getRect(find.text('Change the app'));

      await tester.drag(find.text('Change the app'), const Offset(0, -400));
      await tester.pumpAndSettle();

      // The options really did move...
      expect(
        tester.getRect(find.text('Change the app')).top,
        lessThan(optionBefore.top),
      );
      // ...and the question did not.
      expect(tester.getRect(text), questionBefore);
    });

    testWidgets('collapsing the lead-up hands its room to the options',
        (tester) async {
      // The lead-up is the only part of the card that can yield, and the user
      // is the one who knows when they have finished reading it. Without this
      // lever a long explanation and four described options cannot both fit a
      // phone — no split of a fixed card can make them.
      await pumpPhone(tester);
      final expanded = optionViewport(tester).height;
      expect(find.textContaining('HEAD_'), findsOneWidget);

      await tester.tap(find.text('Claude said'));
      await tester.pumpAndSettle();

      expect(find.textContaining('HEAD_'), findsNothing);
      expect(optionViewport(tester).height, greaterThan(expanded));
      // The point of collapsing is to finish the job, so it must actually get
      // you there: every option reachable, no scrolling.
      expect(visibleOptions(tester), 4);

      // ...and it is a toggle, not a one-way door — the lead-up comes back.
      await tester.tap(find.text('Claude said'));
      await tester.pumpAndSettle();
      expect(find.textContaining('HEAD_'), findsOneWidget);
    });

    testWidgets('a SHORT question reserves only what it needs', (tester) async {
      // Found in review of the fix itself, and it undid most of the fix's own
      // benefit: giving the pinned block an `alignment:` wraps it in an Align,
      // which does NOT shrink-wrap under bounded constraints — it expands to
      // constraints.biggest. A one-line question (24px of text) therefore took
      // the whole 260px cap, handing the options 236px of dead space in exactly
      // the ordinary case this change exists to protect.
      //
      // The cap must behave as a CEILING, not a height.
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'short',
                    questions: [_q(['Change the app', 'Beta', 'Gamma'])],
                  ),
                  contextText: 'a short lead-up',
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // _q()'s question is the single word 'Pick'.
      final text = find.text('Pick');
      final scroller = find
          .ancestor(of: text, matching: find.byType(SingleChildScrollView))
          .first;
      final block =
          find.ancestor(of: scroller, matching: find.byType(Container)).first;
      // Text + this block's own 10px of vertical padding, and nothing like the
      // 260px cap. 60 leaves room for font metrics without admitting the bug.
      expect(tester.getRect(block).height, lessThan(60.0));
    });

    testWidgets('a NEW prompt gets its lead-up back after a collapse',
        (tester) async {
      // Collapsing is a per-question decision — "I have read THIS one" — not a
      // standing preference. Carried over, the next question would open with
      // its context hidden, which is the very report this change fixes. The
      // other per-prompt state is already reset in didUpdateWidget; this was
      // missed because it is the one piece added by this change.
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      Widget app(String toolUseId) => MaterialApp(
            theme: AppTheme.dark,
            home: Scaffold(
              body: Stack(
                children: [
                  QuestionOverlay(
                    question: PendingQuestion(
                      toolUseId: toolUseId,
                      questions: [_q(['A', 'B'])],
                    ),
                    contextText: _longLeadUp,
                    onSend: (_) {},
                    onKey: (_) {},
                    onDismiss: () {},
                  ),
                ],
              ),
            ),
          );

      await tester.pumpWidget(app('first'));
      await tester.pumpAndSettle();
      expect(find.textContaining('HEAD_'), findsOneWidget);

      await tester.tap(find.text('Claude said'));
      await tester.pumpAndSettle();
      expect(find.textContaining('HEAD_'), findsNothing);

      // A different prompt arrives into the same overlay.
      await tester.pumpWidget(app('second'));
      await tester.pumpAndSettle();
      expect(find.textContaining('HEAD_'), findsOneWidget);
    });

    testWidgets('the raw-key row is hidden until asked for (#108)',
        (tester) async {
      // It is a FALLBACK — for a prompt whose keybindings don't match the built
      // sequence — but it charged every card a permanent row, and the card pays
      // for that out of the option list. Six keys wrap to two rows at a phone
      // width, measured at 36px straight off the options.
      await pumpPhone(tester);
      expect(find.text('Space'), findsNothing);
      expect(find.text('Esc'), findsNothing);
      final hidden = optionViewport(tester).height;

      await tester.tap(find.byTooltip('Show raw keys'));
      await tester.pumpAndSettle();
      expect(find.text('Space'), findsOneWidget);
      // Esc joined the row when the overlay began covering TerminalKeyStrip;
      // it is the only one of that strip's keys that means anything AT a prompt.
      expect(find.text('Esc'), findsOneWidget);

      // Revealing them costs the options room — which is exactly why it is not
      // the default.
      expect(optionViewport(tester).height, lessThan(hidden));
    });

    testWidgets('the lead-up toggle is two-way even when it starts collapsed',
        (tester) async {
      // Found by instrumenting the fix, not by reading it. The collapsed panel
      // was given `maxHeight: 0` on its CONTAINER, which took the "Claude said"
      // header down with the body: the row still existed for `find`, but at zero
      // height, so the chevron could not be tapped and the toggle was ONE-WAY.
      // On a card that auto-collapses, that would have made the lead-up
      // unreachable — strictly worse than the crowding being fixed.
      tester.view.physicalSize = const Size(412 * 3, 620 * 3); // cramped
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'tight',
                    questions: [mobileQuestion()],
                  ),
                  contextText: _longLeadUp,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The header is ALWAYS present — it is the only way back to the context.
      expect(find.text('Claude said'), findsOneWidget);

      // Whatever it starts as, tapping must flip it, and flip it back.
      final startedOpen = find.byType(MarkdownBody).evaluate().isNotEmpty;
      await tester.tap(find.text('Claude said'));
      await tester.pumpAndSettle();
      expect(find.byType(MarkdownBody).evaluate().isNotEmpty, !startedOpen);

      await tester.tap(find.text('Claude said'));
      await tester.pumpAndSettle();
      expect(find.byType(MarkdownBody).evaluate().isNotEmpty, startedOpen);
    });

    testWidgets('the nav-key strip fits a phone width', (tester) async {
      // Five keys in a Row overflowed 412dp by 7.3px. A RenderFlex does not
      // shrink to fit — it paints past its bounds and the overflowing child is
      // unreachable, and here that child is 'Enter', the one key whose whole
      // purpose is to commit an answer.
      await pumpPhone(tester);
      expect(tester.takeException(), isNull);
      // Hidden by default since #108 — reveal them before measuring.
      await tester.tap(find.byTooltip('Show raw keys'));
      await tester.pumpAndSettle();
      for (final k in const ['Space', 'Tab', 'Enter', 'Esc']) {
        expect(find.text(k), findsOneWidget);
        expect(tester.getRect(find.text(k)).right,
            lessThanOrEqualTo(412.0));
      }
    });
  });

  // #108 — a desktop window is not a big phone. The single-column budget rations
  // height between the lead-up and the options; on a roomy window that height was
  // never scarce, so the rationing was pure loss. These pin the two-column shape
  // AND that the phone shape is untouched — the same prompt, two viewports.
  group('#108 — the wide (desktop) layout', () {
    PendingQuestionItem wideQuestion() => const PendingQuestionItem(
          header: 'Scope',
          question: 'Should the fix change the app so it stops asking for the '
              'conflict check, or change the database so that the check is '
              'permitted?',
          multiSelect: false,
          hasPreview: false,
          options: [
            QuestionOption(
                label: 'Change the app',
                description:
                    'Drop the retry-safe header; tolerate duplicates instead.'),
            QuestionOption(
                label: 'Change the database',
                description: 'Permit the check; migrate the unique index.'),
            QuestionOption(
                label: 'Both', description: 'Do the app change and the migration.'),
            QuestionOption(
                label: 'Neither — revert', description: 'Back out the change.'),
          ],
        );

    Future<void> pumpAt(WidgetTester tester, Size logical) async {
      tester.view.physicalSize = Size(logical.width * 2, logical.height * 2);
      tester.view.devicePixelRatio = 2.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                      toolUseId: 'w108', questions: [wideQuestion()]),
                  contextText: _longLeadUp,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    // The band an option must fall inside to be reachable without scrolling —
    // the SCROLL VIEWPORT, never the screen (#94: getRect returns unclipped
    // positions, and asserting on the screen overstated that fix 3x).
    Rect optionViewport(WidgetTester tester) => tester.getRect(find
        .ancestor(
          of: find.text('Change the app'),
          matching: find.byType(SingleChildScrollView),
        )
        .first);

    int visibleOptions(WidgetTester tester) {
      final vp = optionViewport(tester);
      var n = 0;
      for (final label in const [
        'Change the app',
        'Change the database',
        'Both',
        'Neither — revert',
      ]) {
        if (tester.getRect(find.text(label)).bottom <= vp.bottom + 0.5) n++;
      }
      return n;
    }

    testWidgets('every option is reachable without scrolling on a desktop window',
        (tester) async {
      await pumpAt(tester, const Size(1600, 1000));
      expect(visibleOptions(tester), 4);
    });

    // The card's own width. Its Container is the one with the 640/1040 cap, so
    // measuring it is measuring the decision rather than a proxy for it.
    double cardWidth(WidgetTester tester) => tester
        .getRect(find
            .ancestor(
              of: find.text('Claude said'),
              matching: find.byType(Container),
            )
            .last)
        .width;

    testWidgets('a desktop window gets a WIDER card — not a phone card centred in it',
        (tester) async {
      await pumpAt(tester, const Size(1600, 1000));
      expect(cardWidth(tester), greaterThan(640.0));
    });

    testWidgets('the lead-up sits BESIDE the options, not above them',
        (tester) async {
      await pumpAt(tester, const Size(1600, 1000));
      // Assert on the lead-up's own SCROLL VIEWPORT, not its 'Claude said'
      // header label: the label sits at the top of a full-height column, so
      // comparing against it would call a correct two-column layout stacked.
      final ctxBody = tester.getRect(find
          .ancestor(
            of: find.textContaining('conflict check'),
            matching: find.byType(SingleChildScrollView),
          )
          .first);
      final opts = optionViewport(tester);
      // Beside: the options are entirely to the RIGHT of the lead-up column,
      // and the two overlap vertically — which is exactly what stacking cannot do.
      expect(opts.left, greaterThanOrEqualTo(ctxBody.right));
      expect(opts.top, lessThan(ctxBody.bottom));
    });

    testWidgets('the lead-up is open by default — it is borrowing from nobody',
        (tester) async {
      await pumpAt(tester, const Size(1600, 1000));
      expect(find.textContaining('conflict check'), findsWidgets);
    });

    testWidgets('a NARROW desktop window keeps the phone shape — size decides, not platform',
        (tester) async {
      // 700 logical: a side-by-side window on a laptop. Wide enough to look like
      // "desktop" and far too narrow for two readable columns.
      await pumpAt(tester, const Size(700, 900));
      final ctx = tester.getRect(find.text('Claude said'));
      final opts = optionViewport(tester);
      expect(opts.top, greaterThan(ctx.top)); // stacked, as on a phone
    });

    testWidgets('a wide but SHORT window keeps the phone shape too',
        (tester) async {
      await pumpAt(tester, const Size(1600, 480));
      final ctx = tester.getRect(find.text('Claude said'));
      final opts = optionViewport(tester);
      expect(opts.top, greaterThan(ctx.top));
    });

    testWidgets('the question is still pinned above the options (#94 holds)',
        (tester) async {
      await pumpAt(tester, const Size(1600, 1000));
      final qRect = tester.getRect(find.textContaining('Should the fix change'));
      expect(qRect.bottom, lessThanOrEqualTo(optionViewport(tester).top + 0.5));
    });
  });

  // #108 (2026-08-12b) — "I just had a question that I can select multiple
  // answers, but I didn't get, in the chat mode, something that I can click in
  // myself and then it submits, so I had to do it in the terminal."
  //
  // The delivery path (#39) was never broken and its pure tests stayed green
  // throughout — but NOTHING drove a real multi-select through the real UI, and
  // every viewport test used a single-select fixture. So the one shape the user
  // could not answer was the one shape no widget test covered.
  //
  // Measured against real data, this is also WHY it went unnoticed: across the
  // 127 AskUserQuestion calls in this machine's transcripts, only 2 questions
  // were multi-select.
  group('#108 — a multi-select question is answerable AT A PHONE SIZE', () {
    PendingQuestionItem multiQuestion() => PendingQuestionItem(
          question: 'Which checks should run before every deploy? '
              'Pick all that apply.',
          header: 'Checks',
          multiSelect: true,
          options: const [
            QuestionOption(
                label: 'Unit tests',
                description:
                    'The fast suite. Runs in under a minute and catches the '
                    'regressions that matter most.'),
            QuestionOption(
                label: 'Integration tests',
                description:
                    'Slower, but the only place the wire format is actually '
                    'exercised end to end.'),
            QuestionOption(
                label: 'Lint',
                description: 'Style and dead-code checks.'),
            QuestionOption(
                label: 'Security scan',
                description: 'Dependency CVEs and secret detection.'),
          ],
        );

    Future<List<AnswerFrame>> pumpMultiPhone(WidgetTester tester) async {
      final sent = <AnswerFrame>[];
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'ms1',
                    questions: [multiQuestion()],
                  ),
                  contextText: _longLeadUp,
                  onSend: sent.addAll,
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return sent;
    }

    testWidgets('tap two rows, both show CHECKED — not radio buttons',
        (tester) async {
      await pumpMultiPhone(tester);

      // The unchecked box is what tells the user this question takes more than
      // one answer at all. A radio here would be a lie about the shape.
      expect(find.byIcon(Icons.check_box_outline_blank), findsWidgets);
      expect(find.byIcon(Icons.radio_button_unchecked), findsNothing);

      await tester.tap(find.text('Unit tests'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lint'));
      await tester.pumpAndSettle();

      // Two ticked, and crucially the FIRST is still ticked — a single-select
      // _toggle would have cleared it when the second was tapped.
      expect(find.byIcon(Icons.check_box), findsNWidgets(2));
    });

    testWidgets('the Send button is INSIDE the screen, not below the fold',
        (tester) async {
      await pumpMultiPhone(tester);
      await tester.tap(find.text('Unit tests'));
      await tester.pumpAndSettle();

      // The reported failure was "there was nothing I could click that
      // submits". An affordance that exists but sits past the bottom edge is
      // indistinguishable from one that does not exist.
      final send = find.widgetWithText(FilledButton, 'Send answer');
      expect(send, findsOneWidget);
      final r = tester.getRect(send);
      final screen = tester.view.physicalSize / tester.view.devicePixelRatio;
      expect(r.bottom, lessThanOrEqualTo(screen.height + 0.5));
      expect(r.top, greaterThanOrEqualTo(-0.5));
      expect(r.height, greaterThan(0));
    });

    testWidgets('tap two rows then Send delivers the #39 multi-select frames',
        (tester) async {
      final sent = await pumpMultiPhone(tester);

      await tester.tap(find.text('Unit tests'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lint'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      // Options 1 and 3 toggled, Right-arrow to the Submit review, "1" to
      // finalise — the sequence #39 measured. Driven here through real taps
      // rather than handed to buildAnswerFrames, which is the gap that let the
      // reporter hit a dead end while every pure test passed.
      expect(sent.map((f) => f.keys).toList(), ['1', '3', '\x1b[C', '1']);
    });

    testWidgets('Send stays disabled until at least one row is ticked',
        (tester) async {
      await pumpMultiPhone(tester);
      expect(find.widgetWithText(FilledButton, 'Pick an option'), findsOneWidget);
      final before =
          tester.widget<FilledButton>(find.byType(FilledButton).last);
      expect(before.onPressed, isNull);

      await tester.tap(find.text('Security scan'));
      await tester.pumpAndSettle();

      final after = tester.widget<FilledButton>(
          find.widgetWithText(FilledButton, 'Send answer'));
      expect(after.onPressed, isNotNull);
    });

    testWidgets('untapping the last row disables Send again', (tester) async {
      await pumpMultiPhone(tester);
      await tester.tap(find.text('Lint'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Send answer'), findsOneWidget);

      await tester.tap(find.text('Lint'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Pick an option'), findsOneWidget);
    });
  });

  // #108 — the multi-QUESTION tab strip, driven through the UI. Like
  // multi-select above, this shape was proven only at the buildAnswerFrames
  // level; nothing tapped a tab.
  group('#108 — the multi-question tab strip', () {
    Future<List<AnswerFrame>> pumpTabs(WidgetTester tester) async {
      final sent = <AnswerFrame>[];
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'mq1',
                    questions: [
                      PendingQuestionItem(
                        question: 'Which colour?',
                        header: 'Colour',
                        multiSelect: false,
                        options: const [
                          QuestionOption(label: 'Red', description: 'Warm.'),
                          QuestionOption(label: 'Green', description: 'Calm.'),
                        ],
                      ),
                      PendingQuestionItem(
                        question: 'Which fruit?',
                        header: 'Fruit',
                        multiSelect: false,
                        options: const [
                          QuestionOption(label: 'Apple', description: 'Crisp.'),
                          QuestionOption(label: 'Pear', description: 'Soft.'),
                        ],
                      ),
                    ],
                  ),
                  contextText: 'Pick one of each.',
                  onSend: sent.addAll,
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return sent;
    }

    testWidgets('each tab shows its OWN options, not the first tab\'s',
        (tester) async {
      await pumpTabs(tester);
      expect(find.text('Red'), findsOneWidget);
      expect(find.text('Apple'), findsNothing);

      await tester.tap(find.text('Fruit'));
      await tester.pumpAndSettle();

      expect(find.text('Apple'), findsOneWidget);
      expect(find.text('Red'), findsNothing);
    });

    testWidgets('answering both tabs by tapping delivers a digit per tab + Enter',
        (tester) async {
      final sent = await pumpTabs(tester);

      await tester.tap(find.text('Green'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Fruit'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Apple'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      // Q1 -> Green (digit 2, auto-advances), Q2 -> Apple (digit 1), Enter
      // submits. No preview on either question, so the compact layout applies
      // and there is no extra per-tab Enter (#19).
      expect(sent.map((f) => f.keys).toList(), ['2', '1', '\r']);
    });

    testWidgets('a tab left unanswered keeps Send disabled', (tester) async {
      await pumpTabs(tester);
      await tester.tap(find.text('Green'));
      await tester.pumpAndSettle();
      // Only Q1 answered.
      expect(find.widgetWithText(FilledButton, 'Pick an option'), findsOneWidget);
    });
  });

  // #108 — option descriptions rendered their markdown as literal syntax, the
  // same defect the lead-up panel had. Measured first: 3.3% of the 483 real
  // option descriptions carry markdown, and every occurrence is an inline code
  // span — which is why this is spans-and-code, not a MarkdownBody.
  group('inlineMarkdownSpans', () {
    String flatten(List<InlineSpan> spans) =>
        spans.map((s) => (s as TextSpan).text ?? '').join();

    test('a code span loses its backticks and gains the code style', () {
      final spans = inlineMarkdownSpans(
        'Run `flutter test` first.',
        base: const TextStyle(fontSize: 12),
        code: const TextStyle(fontFamily: 'monospace'),
      );
      expect(flatten(spans), 'Run flutter test first.');
      final code = spans
          .whereType<TextSpan>()
          .where((s) => s.style?.fontFamily == 'monospace')
          .toList();
      expect(code, hasLength(1));
      expect(code.single.text, 'flutter test');
    });

    test('bold loses its asterisks and gains weight', () {
      final spans = inlineMarkdownSpans('A **strong** claim.',
          base: const TextStyle(fontSize: 12), code: null);
      expect(flatten(spans), 'A strong claim.');
      expect(
        spans.whereType<TextSpan>().any(
            (s) => s.text == 'strong' && s.style?.fontWeight == FontWeight.w700),
        isTrue,
      );
    });

    test('plain prose — the 96.7% case — is exactly one span, unchanged', () {
      const plain = 'Belt and braces; a wider blast radius.';
      final spans = inlineMarkdownSpans(plain,
          base: const TextStyle(fontSize: 12), code: null);
      expect(spans, hasLength(1));
      expect(flatten(spans), plain);
    });

    test('a glob is NOT read as italics — why single-asterisk is unsupported',
        () {
      const glob = 'Matches *.dart and lib/*.g.dart under the package root.';
      final spans = inlineMarkdownSpans(glob,
          base: const TextStyle(fontSize: 12), code: null);
      expect(flatten(spans), glob, reason: 'asterisks survive as literal text');
    });

    test('unbalanced syntax is left alone rather than guessed at', () {
      const odd = 'A stray ` backtick and a lone ** pair.';
      expect(
        flatten(inlineMarkdownSpans(odd,
            base: const TextStyle(fontSize: 12), code: null)),
        odd,
      );
    });

    test('an empty description does not produce an empty span list', () {
      expect(
          inlineMarkdownSpans('', base: null, code: null), hasLength(1));
    });
  });

  group('#108 — the option description renders its markdown', () {
    testWidgets('backticks do not reach the screen, and the clamp survives',
        (tester) async {
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'md1',
                    questions: [
                      PendingQuestionItem(
                        question: 'How should the profile be produced?',
                        header: 'Profile',
                        multiSelect: false,
                        options: const [
                          QuestionOption(
                            label: 'Ship a flag',
                            description:
                                'Expose it as `ACS.Server.exe --out <path>`. '
                                'That exe is already installed everywhere.',
                          ),
                          QuestionOption(
                              label: 'Do nothing', description: 'Defer it.'),
                        ],
                      ),
                    ],
                  ),
                  contextText: 'Pick one.',
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The literal backticks the screenshot showed must be gone...
      expect(find.textContaining('`'), findsNothing);
      // ...while the text itself survives, in one paragraph.
      expect(find.textContaining('ACS.Server.exe --out <path>'), findsOneWidget);

      // The clamp is load-bearing: kOptionRowMax was MEASURED against a
      // two-line description, so losing it to a block renderer would let one
      // verbose option push every other choice off screen.
      final desc = tester.widget<Text>(
          find.textContaining('ACS.Server.exe --out <path>'));
      expect(desc.maxLines, 2);
      expect(desc.overflow, TextOverflow.ellipsis);

      // Selecting reveals the whole thing (#108's reveal-on-select).
      await tester.tap(find.text('Ship a flag'));
      await tester.pumpAndSettle();
      final expanded = tester.widget<Text>(
          find.textContaining('ACS.Server.exe --out <path>'));
      expect(expanded.maxLines, isNull);
    });
  });

  // #145 — the option `preview` BLOCK.
  //
  // Reported 2026-08-19: a three-option question whose labels were terse and
  // whose entire technical content sat in Claude's side-by-side preview box
  // showed none of it in chat, because the server dropped the body and only
  // published `hasPreview`. The chat lens was strictly less informative than
  // the terminal on exactly the questions that need the most reading.
  group('#145 — the option preview block', () {
    const kSnippet = 'debug {\n  applicationIdSuffix = ".debug"\n}';
    const kOther = 'net.hilash.rega  <- Play, your real data';

    PendingQuestion previewed() => const PendingQuestion(
          toolUseId: 'tp',
          questions: [
            PendingQuestionItem(
              header: 'Ship',
              question: 'Pick',
              multiSelect: false,
              hasPreview: true,
              options: [
                QuestionOption(label: 'Land it', preview: kSnippet),
                QuestionOption(label: 'Closed track', preview: kOther),
                QuestionOption(label: 'Leave it'),
              ],
            ),
          ],
        );

    Future<void> pump(WidgetTester tester, PendingQuestion q) async {
      tester.view.physicalSize = const Size(1200, 1800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: q,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    test('QuestionOption reads `preview`; an absent one is empty, never null',
        () {
      expect(
        QuestionOption.fromJson({'label': 'A', 'preview': kSnippet}).preview,
        kSnippet,
      );
      // An older server never sends the field — that must read as "no preview",
      // which is exactly today's behaviour, not a crash.
      expect(QuestionOption.fromJson({'label': 'A'}).preview, '');
    });

    testWidgets('the preview is revealed by selecting its option',
        (tester) async {
      await pump(tester, previewed());

      // Nothing is selected yet, so no preview competes for the room the
      // options need (#94/#108 — the option list is the scarce region).
      expect(find.text(kSnippet), findsNothing);

      await tester.tap(find.text('Land it'));
      await tester.pumpAndSettle();
      expect(find.text(kSnippet), findsOneWidget);
    });

    testWidgets('only the SELECTED option shows a preview — they swap',
        (tester) async {
      await pump(tester, previewed());

      await tester.tap(find.text('Land it'));
      await tester.pumpAndSettle();
      expect(find.text(kSnippet), findsOneWidget);
      expect(find.text(kOther), findsNothing);

      // Single-select: choosing another row moves the selection, so the
      // preview follows it. This mirrors Claude's own side-by-side layout,
      // where moving the highlight is what swaps the box and Enter commits.
      await tester.tap(find.text('Closed track'));
      await tester.pumpAndSettle();
      expect(find.text(kSnippet), findsNothing);
      expect(find.text(kOther), findsOneWidget);
    });

    testWidgets('an option carrying no preview renders no block',
        (tester) async {
      await pump(tester, previewed());
      await tester.tap(find.text('Leave it'));
      await tester.pumpAndSettle();
      expect(find.text(kSnippet), findsNothing);
      expect(find.text(kOther), findsNothing);
    });

    testWidgets('a preview is MONOSPACE and unparsed — its markup is content',
        (tester) async {
      // The description next door goes through inlineMarkdownSpans, and doing
      // the same here would eat the asterisks and backticks a snippet is MADE
      // of — and lose the alignment that makes it readable at all.
      const marky = '**not bold**\n`not code`\n  aligned';
      await pump(
        tester,
        const PendingQuestion(
          toolUseId: 'tm',
          questions: [
            PendingQuestionItem(
              header: 'H',
              question: 'Pick',
              multiSelect: false,
              hasPreview: true,
              options: [QuestionOption(label: 'One', preview: marky)],
            ),
          ],
        ),
      );
      await tester.tap(find.text('One'));
      await tester.pumpAndSettle();

      final block = tester.widget<Text>(find.text(marky));
      expect(block.style?.fontFamily, 'monospace');
      // Rendered verbatim: the markup survives as text rather than being
      // interpreted away.
      expect(block.data, contains('**not bold**'));
      expect(block.data, contains('`not code`'));
    });

    testWidgets(
        'on a PHONE, selecting an option BELOW THE FOLD reveals its preview',
        (tester) async {
      // Found in review of #148, and invisible to every other test here because
      // they all pump at 1200x1800. On a 412dp phone the option list gets
      // kOptionFloor (~two rows), so an option further down is reached by
      // scrolling — and selecting it opens a preview block BELOW the row, i.e.
      // below the viewport. The radio fills and nothing else appears to happen:
      // the feature is shipped and unseeable on exactly the screen it was
      // reported from.
      //
      // Asserted against the SCROLL VIEWPORT, never the screen (#94: getRect
      // returns unclipped positions, so "is it on screen" answers yes for a row
      // scrolled well out of sight).
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      const tail = 'TAIL_PREVIEW_BODY';
      final tallPreview =
          [tail, for (var i = 0; i < 13; i++) 'line $i'].join('\n');
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'tphone',
                    questions: [
                      PendingQuestionItem(
                        header: 'Ship',
                        question: 'Pick one',
                        multiSelect: false,
                        hasPreview: true,
                        options: [
                          for (final label in const [
                            'First', 'Second', 'Third', 'Fourth', 'Fifth',
                          ])
                            QuestionOption(
                                label: label, preview: 'body of $label'),
                          QuestionOption(label: 'Sixth', preview: tallPreview),
                        ],
                      ),
                    ],
                  ),
                  contextText: _longLeadUp,
                  onSend: (_) {},
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Reach the last option the way a user does — by scrolling the list.
      final list = find
          .ancestor(
            of: find.text('First'),
            matching: find.byType(SingleChildScrollView),
          )
          .first;
      await tester.scrollUntilVisible(find.text('Sixth'), 120, scrollable: find
          .descendant(of: list, matching: find.byType(Scrollable))
          .first);
      await tester.pumpAndSettle();

      await tester.tap(find.text('Sixth'));
      await tester.pumpAndSettle();

      final body = find.text(tallPreview);
      expect(body, findsOneWidget);
      final viewport = tester.getRect(list);
      final rect = tester.getRect(body);
      // MEASURED, not assumed. Without the reveal this preview lands at
      // 708..932 in a 404..836 viewport: it opens, but its last ~96px are
      // clipped with nothing saying so — you read a snippet that stops
      // mid-thought and cannot tell that it did.
      expect(rect.bottom, lessThanOrEqualTo(viewport.bottom + 0.5),
          reason: 'the tail of the preview was clipped below the option '
              'viewport and nothing scrolled to it');
      expect(rect.top, greaterThanOrEqualTo(viewport.top - 0.5),
          reason: 'the preview must not be scrolled off the top either');
    });

    testWidgets('a long preview is clamped VISIBLY, never silently',
        (tester) async {
      final long = [for (var i = 0; i < 60; i++) 'line $i'].join('\n');
      await pump(
        tester,
        PendingQuestion(
          toolUseId: 'tl',
          questions: [
            PendingQuestionItem(
              header: 'H',
              question: 'Pick',
              multiSelect: false,
              hasPreview: true,
              options: [QuestionOption(label: 'One', preview: long)],
            ),
          ],
        ),
      );
      await tester.tap(find.text('One'));
      await tester.pumpAndSettle();

      final block = tester.widget<Text>(find.text(long));
      expect(block.maxLines, kPreviewMaxLines);
      // The ellipsis is the point: a silent cut would let the reader believe
      // they had seen the whole snippet — the #143 failure mode.
      expect(block.overflow, TextOverflow.ellipsis);
    });
  });

  // ---------------------------------------------------------------------
  // #164 — free text is per TAB. Other became a per-question affordance in
  // #143 (every compact tab offers it), but the widget kept ONE controller and
  // one save step: tab 2 opened already holding tab 1's characters, and
  // _chooseOther copied them into tab 2's answer. The pure layer had taken a
  // per-question `otherText` list since #143 (see the multi-question cases
  // above), so the capability was on the wire and unreachable from the UI.
  group('per-tab Other free text (#164)', () {
    Future<List<AnswerFrame>> pumpTwoCompactTabs(WidgetTester tester) async {
      final sent = <AnswerFrame>[];
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Stack(
              children: [
                QuestionOverlay(
                  question: PendingQuestion(
                    toolUseId: 'other-mq',
                    questions: [
                      _q(['Red', 'Green'], header: 'Colour'),
                      _q(['Apple', 'Pear'], header: 'Fruit'),
                    ],
                  ),
                  onSend: sent.addAll,
                  onKey: (_) {},
                  onDismiss: () {},
                ),
              ],
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return sent;
    }

    /// Tap a tab by INDEX, never by its label: the label gains a tick the
    /// moment the tab is answered, so a text finder would stop matching
    /// exactly where these tests need it most.
    Future<void> tapTab(WidgetTester tester, int i) async {
      await tester.tap(find.byType(ChoiceChip).at(i));
      await tester.pumpAndSettle();
    }

    String fieldText(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField)).controller!.text;

    String chipLabel(WidgetTester tester, int i) => tester
        .widget<Text>(find
            .descendant(
              of: find.byType(ChoiceChip).at(i),
              matching: find.byType(Text),
            )
            .first)
        .data!;

    Future<void> chooseOther(WidgetTester tester, String text) async {
      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), text);
      await tester.pumpAndSettle();
    }

    testWidgets(
        "a second tab's Other opens EMPTY — the first tab's characters never "
        'carry across', (tester) async {
      await pumpTwoCompactTabs(tester);
      await chooseOther(tester, 'alpha answer');

      await tapTab(tester, 1);
      // Q2 is untouched, so it shows no field at all yet.
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      expect(fieldText(tester), isEmpty);
    });

    testWidgets("leaving a tab and returning restores THAT tab's own text",
        (tester) async {
      await pumpTwoCompactTabs(tester);
      await chooseOther(tester, 'alpha answer');

      await tapTab(tester, 1);
      await chooseOther(tester, 'beta answer');

      await tapTab(tester, 0);
      expect(fieldText(tester), 'alpha answer');

      await tapTab(tester, 1);
      expect(fieldText(tester), 'beta answer');
    });

    testWidgets(
        'opening Other on a tab is not an ANSWER, and both texts reach '
        'buildAnswerFrames as distinct entries', (tester) async {
      final sent = await pumpTwoCompactTabs(tester);
      await chooseOther(tester, 'alpha answer');

      await tapTab(tester, 1);
      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();

      // Q2's field is open and EMPTY, so the prompt is not answered yet. With
      // one shared controller it inherited 'alpha answer' the instant Other
      // was tapped, and Send went live carrying a Q2 answer nobody typed.
      expect(
          find.widgetWithText(FilledButton, 'Pick an option'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'beta answer');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Send answer'));
      await tester.pumpAndSettle();

      // Two options per question -> "Type something." is row 3 on both tabs;
      // each branch CR commits its text and advances, and the tail Enter
      // finalises the Submit review.
      expect(_keys(sent),
          ['3', 'alpha answer', '\r', '3', 'beta answer', '\r', '\r']);
    });

    testWidgets('a tab answered only via Other shows its chip tick',
        (tester) async {
      await pumpTwoCompactTabs(tester);
      expect(chipLabel(tester, 0), 'Colour');

      await chooseOther(tester, 'alpha answer');

      // The chip is the only per-question state readout on the card, and it
      // read _selected alone — so a tab answered by free text reported
      // "unanswered" while Send said the prompt was ready.
      expect(chipLabel(tester, 0), 'Colour ✓');

      // ...and it must agree with the SAME trim rule the Send gate uses:
      // whitespace is discarded by buildAnswerFrames, so it is not an answer.
      await tester.enterText(find.byType(TextField), '   ');
      await tester.pumpAndSettle();
      expect(chipLabel(tester, 0), 'Colour');
    });

    testWidgets(
        'a NEW prompt rebuilds the per-tab fields — no stale text, and a '
        'different question count is safe', (tester) async {
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      Future<void> pump(PendingQuestion pq) => tester.pumpWidget(
            MaterialApp(
              theme: AppTheme.dark,
              home: Scaffold(
                body: Stack(
                  children: [
                    QuestionOverlay(
                      question: pq,
                      onSend: (_) {},
                      onKey: (_) {},
                      onDismiss: () {},
                    ),
                  ],
                ),
              ),
            ),
          );

      await pump(PendingQuestion(toolUseId: 'p1', questions: [
        _q(['Red', 'Green'], header: 'Colour'),
        _q(['Apple', 'Pear'], header: 'Fruit'),
      ]));
      await tester.pumpAndSettle();
      await chooseOther(tester, 'stale');

      // One question this time: the per-tab controller list must shrink with
      // the prompt rather than index past its end.
      await pump(PendingQuestion(toolUseId: 'p2', questions: [
        _q(['Yes', 'No'], header: 'Ship'),
      ]));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);

      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      expect(fieldText(tester), isEmpty);
    });

    // The GATE for the question-count half of the reset condition. The test
    // above swaps the toolUseId too, so the FIRST clause fires there and the
    // count clause is never what saves it — delete the clause and that test
    // still passes. This one holds the toolUseId FIXED, so the count is the
    // only thing that can trigger the reset: without it `_selected` and the
    // controller lists keep their old length while `_tab` still points at a
    // question the new prompt does not have, and the first per-index read
    // throws. A guard with no test that fails without it is the shape this
    // repo has been bitten by before.
    testWidgets(
        'the SAME toolUseId with fewer questions still resets — the count '
        'clause is what catches it', (tester) async {
      tester.view.physicalSize = const Size(412 * 3, 915 * 3);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      Future<void> pump(List<PendingQuestionItem> qs) => tester.pumpWidget(
            MaterialApp(
              theme: AppTheme.dark,
              home: Scaffold(
                body: Stack(
                  children: [
                    QuestionOverlay(
                      // SAME id on purpose — a prompt edited in place.
                      question: PendingQuestion(toolUseId: 'same-id', questions: qs),
                      onSend: (_) {},
                      onKey: (_) {},
                      onDismiss: () {},
                    ),
                  ],
                ),
              ),
            ),
          );

      await pump([
        _q(['Red', 'Green'], header: 'Colour'),
        _q(['Apple', 'Pear'], header: 'Fruit'),
      ]);
      await tester.pumpAndSettle();
      // Park on the LAST tab: the index that stops existing when the prompt
      // shrinks, and therefore the one that proves the reset ran.
      await tapTab(tester, 1);
      await chooseOther(tester, 'fruit text');

      await pump([_q(['Yes', 'No'], header: 'Ship')]);
      await tester.pumpAndSettle();

      // Rendered at all => no RangeError escaped the build.
      expect(tester.takeException(), isNull);
      expect(find.text('Yes'), findsOneWidget);
      // And the stale free text went with the old prompt.
      expect(find.byType(TextField), findsNothing);
      await tester.tap(find.text('Other…'));
      await tester.pumpAndSettle();
      expect(fieldText(tester), isEmpty);
    });
  });
}
