// #383 - two pure text rules the questions inbox reads: which way a paragraph runs
// (Hebrew and English prose sit side by side), and whether an agent's last reply
// ends by asking the person something in prose.
import 'package:ai_terminal/util/inbox_items.dart';
import 'package:ai_terminal/util/text_direction.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

// Built from code points, never typed: a literal Hebrew or Arabic character can be
// normalised in transit, and an escape written into a file has been seen to arrive as
// the character itself (see CLAUDE.md, #190).
String u(List<int> cps) => String.fromCharCodes(cps);
final hebrew = u([0x05E9, 0x05DC, 0x05D5, 0x05DD]);
final hebrewAsk = u([0x05DC, 0x05D3, 0x05D7, 0x05D5, 0x05E3, 0x20, 0x05E2, 0x05DB, 0x05E9, 0x05D9, 0x05D5]);
final arabic = u([0x0645, 0x0631, 0x062D, 0x0628, 0x0627]);
final arabicAsk = u([0x0647, 0x0644, 0x20, 0x0623, 0x0646, 0x0634, 0x0631]);

void main() {
  group('textDirectionFor', () {
    test('Hebrew first -> rtl', () {
      expect(textDirectionFor('$hebrew world'), TextDirection.rtl);
    });

    test('Latin first, Hebrew later -> ltr', () {
      expect(textDirectionFor('Deploy to $hebrew'), TextDirection.ltr);
    });

    test('leading digits, punctuation and spaces are skipped', () {
      expect(textDirectionFor('3. (#383) $hebrew'), TextDirection.rtl);
      expect(textDirectionFor('  - 12:30 ${u([0x2014])} deploy'), TextDirection.ltr);
    });

    test('Arabic is rtl; no strong character at all is ltr', () {
      expect(textDirectionFor(arabic), TextDirection.rtl);
      expect(textDirectionFor('123 ?!'), TextDirection.ltr);
      expect(textDirectionFor(''), TextDirection.ltr);
    });
  });

  group('askingInProse', () {
    test('a ? in the last paragraph -> true', () {
      expect(askingInProse('I fixed the build.\n\nShould I push it?'), isTrue);
    });

    test('a ? only in an EARLIER paragraph -> false: it went on to report', () {
      expect(askingInProse('Should I push it?\n\nPushed it anyway; CI is green.'), isFalse);
    });

    test('a ? only inside code -> false', () {
      expect(askingInProse('Use `a ? b : c` here.'), isFalse);
      expect(askingInProse('Done.\n\n```\nfinal x = a ? b : c;\n```'), isFalse);
      expect(askingInProse('Opened https://example.com/a?b=1 for you.'), isFalse);
    });

    test('Hebrew with ? -> true; the Arabic question mark -> true', () {
      expect(askingInProse('$hebrewAsk?'), isTrue);
      expect(askingInProse('$arabicAsk${u([0x061F])}'), isTrue);
      expect(askingInProse(arabicAsk), isFalse, reason: 'the Arabic mark is what made it true');
    });

    test('no question mark -> false', () {
      expect(askingInProse('All done. The tests pass.'), isFalse);
      expect(askingInProse(''), isFalse);
    });
  });
}
