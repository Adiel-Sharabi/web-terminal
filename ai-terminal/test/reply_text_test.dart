// #383 - reading an agent's own words for a card: the TL;DR split, "is it asking" over
// the full TL;DR plus the final paragraph, and the sentence a card shows, cut only at
// sentence boundaries.
import 'package:ai_terminal/util/reply_text.dart';
import 'package:flutter_test/flutter_test.dart';

/// [n] filler sentences, so a text is longer than any card budget.
String filler(int n, [String word = 'Done']) => List.generate(n, (i) => '$word step $i of the work went fine.').join(' ');

void main() {
  group('splitTldr / tldrFirst', () {
    test('a trailing ## TL;DR moves to the top, under its heading', () {
      const text = 'Body one.\n\nBody two.\n\n## TL;DR\nShort recap.';
      expect(splitTldr(text).tldr, 'Short recap.');
      expect(splitTldr(text).rest, 'Body one.\n\nBody two.');
      expect(tldrFirst(text), '## TL;DR\n\nShort recap.\n\nBody one.\n\nBody two.');
    });

    test('the section ends at the next heading; inline "TL;DR:" and bold forms count', () {
      expect(splitTldr('## TL;DR\nA.\n## Notes\nB.').tldr, 'A.');
      expect(splitTldr('**TL;DR:** it works.').tldr, 'it works.');
      expect(splitTldr('TL;DR: it works.').tldr, 'it works.');
    });

    test('a TL;DR first does not swallow the reply after it (a corpus false positive)', () {
      const text = '## TL;DR\nStill measuring; I will report.\n\nDid the dialog close? It did.\n\nMore body.';
      expect(splitTldr(text).tldr, 'Still measuring; I will report.');
      expect(askingInProse(text), isFalse, reason: 'the ? is in the body, above the final paragraph');
    });

    test('the LAST TL;DR of a turn is the one read', () {
      expect(splitTldr('## TL;DR\nearly note\n\nwork\n\n## TL;DR\nfinal recap').tldr, 'final recap');
    });

    test('no TL;DR: unchanged; a heading inside a code fence is not one', () {
      expect(tldrFirst('Just text.'), 'Just text.');
      expect(splitTldr('```\n## TL;DR\n```\nafter').tldr, isNull);
    });
  });

  group('askingInProse: positives', () {
    test('a question mark in the TL;DR, however long the TL;DR is (the 280-char cut)', () {
      // report-Q: two live replies were cut to 280 chars before the request, so the `?`
      // never reached the rule. The whole TL;DR is read now.
      // No request phrase: only the question mark can make this one ask.
      final text = 'Body.\n\n## TL;DR\n${filler(8)} Want me to post the draft to the issue?';
      expect(text.indexOf('?'), greaterThan(280));
      expect(askingInProse(text), isTrue);
    });

    test('a request in the final paragraph ABOVE a TL;DR that only says "drafted above"', () {
      expect(askingInProse('Here is the draft.\n\nTell me which title to use.\n\n## TL;DR\nThe draft is above.'), isTrue);
    });

    test('request phrases at the start of a sentence count without a question mark', () {
      for (final s in [
        'Tell me which one to keep.',
        'Let me know whether to push.',
        'Should I go ahead.',
        'Do you want the long version.',
        'Which option do you prefer.',
        "I'll ask you to pick a name next.",
        'I need you to approve the release.',
        'Confirm and I will merge it.',
        'Please confirm the target branch.',
        'Let me know if I should push or wait.',
      ]) {
        expect(askingInProse('Done the work.\n\n$s'), isTrue, reason: s);
      }
      // "I'll" with a typographic apostrophe (U+2019), built from its code point.
      expect(askingInProse('I${String.fromCharCode(0x2019)}ll ask you for the name once CI is green.'), isTrue);
    });
  });

  group('askingInProse: negatives (a done reply is not a question)', () {
    test('a courtesy offer is not an ask', () {
      for (final s in [
        'Let me know if you want more.',
        'Let me know if anything else comes up.',
        'Tell me if you need further changes.',
      ]) {
        expect(askingInProse('Fixed the build and pushed it.\n\n$s'), isFalse, reason: s);
      }
    });

    test('a phrase in the middle of a sentence is grammar, not a request', () {
      expect(askingInProse('The cache was stale, which means the test was wrong.'), isFalse);
      expect(askingInProse('I confirmed the fix on the rig.'), isFalse);
      expect(askingInProse('Done. Nobody needs to tell me anything.'), isFalse);
    });

    test('a statement that merely STARTS like a request is not an ask (report-T)', () {
      // Both found in real replies: a review's finding, and a note about a guess.
      expect(askingInProse('Traced the retry path.\n\nWhich of the two places fired the second write is still a guess.'),
          isFalse);
      expect(
          askingInProse('Review done.\n\n{"severity": "should-fix", "finding": "The retry is not idempotent. '
              'Confirm with the author that the second write is safe to repeat, and add a test for it '
              'before this merges, since the replay path runs on every reconnect and nothing in the '
              'suite exercises it today."}'),
          isFalse);
      // The asks beside them still count.
      expect(askingInProse('Which of the two should I keep.'), isTrue);
      expect(askingInProse('Which one do you want.'), isTrue);
      expect(askingInProse('Please confirm the target branch.'), isTrue);
    });

    test('an ask above the final paragraph, followed by a report, is not one', () {
      expect(askingInProse('Should I push it?\n\nPushed it anyway; CI is green.\n\n## TL;DR\nPushed; CI green.'), isFalse);
    });

    test('a quoted question or a link label is someone else\'s question', () {
      expect(askingInProse('It is in the FAQ entry "When does it start applying?" on page 3.'), isFalse);
      expect(askingInProse('See [Why is it red?](x/y) for the details.'), isFalse);
      expect(askingInProse('Should I call it "Atlas"?'), isTrue, reason: 'its own ? survives the blanking');
    });

    test('code, fences and URLs never ask', () {
      expect(askingInProse('Use `which python` here.'), isFalse);
      expect(askingInProse('Done.\n\n```\nconfirm() ? a : b\n```'), isFalse);
      expect(askingInProse('See https://x.test/a?b=1 for it.'), isFalse);
    });
  });

  group('questionSnippet: the sentence that asks, cut only between sentences', () {
    test('a short question is shown whole', () {
      expect(questionSnippet('Which store do we use?'), 'Which store do we use?');
    });

    test('a long question shows its question sentence, not its head', () {
      final text = '${filler(10)} Which store should the session cache use? ${filler(2, 'After')}';
      final out = questionSnippet(text);
      expect(out, contains('Which store should the session cache use?'));
      expect(out, startsWith(kEllipsis), reason: 'sentences before it were left out');
      expect(out, endsWith(kEllipsis), reason: 'sentences after it were left out');
      expect(out.length, lessThanOrEqualTo(kSnippetBudget + 4));
    });

    test('every part it shows is a whole sentence of the original', () {
      final text = '${filler(10)} So, which store should we use? ${filler(3, 'Then')}';
      final sentences = sentencesOf(text).toSet();
      // Several budgets, so no single length can line up with a sentence end by luck.
      for (var budget = 200; budget <= 260; budget += 7) {
        final parts = questionSnippet(text, budget: budget).replaceAll(kEllipsis, '').trim();
        final shown = sentencesOf(parts);
        expect(shown, isNotEmpty);
        for (final s in shown) {
          expect(sentences, contains(s), reason: 'budget $budget cut inside a sentence: "$s"');
        }
      }
    });

    test('a run-on sentence over the hard cap is cut at a word, never mid-word', () {
      // Six-character words, so the hard cap itself falls inside a word.
      final runOn = 'Which ${List.filled(120, 'words').join(' ')} do you want?';
      final out = questionSnippet(runOn);
      expect(out, endsWith(kEllipsis));
      final body = out.substring(0, out.length - 1);
      expect(runOn.startsWith(body), isTrue);
      expect(runOn[body.length], ' ', reason: 'the cut falls on a space');
    });

    test('abbreviations and list numbers do not end a sentence', () {
      expect(sentencesOf('Use a cache, e.g. Redis, for it. Then go.'), ['Use a cache, e.g. Redis, for it.', 'Then go.']);
      expect(sentencesOf('Pick:\n1. Redis\n2. SQLite'), ['Pick:', '1. Redis', '2. SQLite']);
    });

    test('askingSnippet shows the request at the end of a reply, not its head', () {
      final reply = '${filler(12)}\n\nI drafted it above. Tell me which title to use.\n\n## TL;DR\nDrafted; need a title.';
      expect(askingSnippet(reply), contains('Tell me which title to use.'));
      expect(askingSnippet(reply), isNot(contains('step 0 ')));
    });
  });
}
