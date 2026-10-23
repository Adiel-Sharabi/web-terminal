// #383 - ONE lead-up rule, enforced against the source. The session screen's question
// overlay and the questions inbox both show "Claude said" above a question; they read it
// through the same function (`loadAgentTurn` in `lib/util/agent_turn.dart`), so the two
// can never pick a different text again. Before this, each fetched its own 12-turn page
// and took the newest text line by hand. No behavioural test can see a third copy being
// added next year, which is why this reads the files.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

String _read(String path) => File(path).readAsStringSync();

void main() {
  const overlay = 'lib/screens/session_screen.dart';
  const inbox = 'lib/screens/questions_inbox_screen.dart';

  test('the overlay and the inbox both read the lead-up through loadAgentTurn', () {
    for (final f in [overlay, inbox]) {
      final src = _read(f);
      expect(src, contains("import '../util/agent_turn.dart';"), reason: f);
      expect(src, contains('loadAgentTurn('), reason: f);
      expect(src, contains('.leadUp'), reason: f);
    }
  });

  test('neither picks assistant text by hand, nor reads a fixed transcript page of its own', () {
    for (final f in [overlay, inbox]) {
      final src = _read(f);
      expect(RegExp(r'\.isAssistant\b').hasMatch(src), isFalse, reason: '$f picks a turn by hand');
      expect(RegExp(r'transcript\([^)]*limit:\s*\d').hasMatch(src), isFalse, reason: '$f reads its own page');
    }
  });

  test('the old one-line rule is gone from lib', () {
    final hits = <String>[];
    for (final e in Directory('lib').listSync(recursive: true)) {
      if (e is File && e.path.endsWith('.dart') && e.readAsStringSync().contains('lastAssistantText')) hits.add(e.path);
    }
    expect(hits, isEmpty);
  });
}
