// #131 — where the user should stand while a slash command runs.
//
// The rule is a TABLE rather than a computation because the commands divide by
// what they WRITE, and that is not derivable from the text you typed. Measured
// across the 609 Claude transcripts on the reporting machine:
//
//   /issue, /goal, ...   a real user turn + a full agent turn  -> Chat renders it
//   /compact             compact_boundary + the `compacting` flag -> Chat has state
//   /status, /usage      a local_command line whose ENTIRE result is the literal
//                        string "Settings dialog dismissed"      -> nothing for Chat
//
// The last row is the reported bug: Chat showed the invocation and no answer.
import 'package:flutter_test/flutter_test.dart';

import 'package:ai_terminal/services/command_policy.dart';

void main() {
  setUp(() => CommandPolicy.instance.debugReset());

  group('CommandPolicy.nameOf', () {
    test('strips the slash and the arguments', () {
      expect(CommandPolicy.nameOf('/issue fix the thing'), 'issue');
    });

    test('is case-insensitive', () {
      expect(CommandPolicy.nameOf('/STATUS'), 'status');
    });

    test('keeps a namespaced skill whole — /caveman:caveman is one name', () {
      expect(CommandPolicy.nameOf('/caveman:caveman'), 'caveman:caveman');
    });

    test('non-commands and a bare slash have no name', () {
      expect(CommandPolicy.nameOf('just a prompt'), '');
      expect(CommandPolicy.nameOf('/'), '');
    });
  });

  group('pinsTerminal — the fallback table (old server, or fetch failed)', () {
    test('a TUI-only built-in pins the terminal', () {
      for (final c in ['/status', '/usage', '/context', '/model', '/clear']) {
        expect(CommandPolicy.instance.pinsTerminal(c), isTrue, reason: c);
      }
    });

    test('/compact does NOT pin — it writes transcript state and has an indicator',
        () {
      expect(CommandPolicy.instance.pinsTerminal('/compact'), isFalse);
    });

    test('a skill does not pin — it starts a real turn, which chat renders', () {
      expect(CommandPolicy.instance.pinsTerminal('/issue fix it'), isFalse);
      expect(CommandPolicy.instance.pinsTerminal('/caveman:caveman'), isFalse);
    });

    test('an UNKNOWN command defaults to chat — the open-ended class is skills',
        () {
      expect(
        CommandPolicy.instance.pinsTerminal('/some-skill-invented-tomorrow'),
        isFalse,
      );
    });

    test('ordinary prose never pins', () {
      expect(CommandPolicy.instance.pinsTerminal('do the thing'), isFalse);
      expect(CommandPolicy.instance.pinsTerminal(''), isFalse);
    });
  });

  group('pinsTerminal — the server-published policy is authoritative', () {
    test('a published row OVERRIDES the built-in fallback', () {
      // The whole point of publishing it: a newer server can reclassify a
      // command with no client release.
      CommandPolicy.instance.debugReset({'status': 'chat'});
      expect(CommandPolicy.instance.pinsTerminal('/status'), isFalse);

      CommandPolicy.instance.debugReset({'compact': 'terminal'});
      expect(CommandPolicy.instance.pinsTerminal('/compact'), isTrue);
    });

    test('a command the server publishes but the fallback never knew still works',
        () {
      CommandPolicy.instance.debugReset({'brand-new-dialog': 'terminal'});
      expect(CommandPolicy.instance.pinsTerminal('/brand-new-dialog'), isTrue);
    });

    test('a fallback name the server omits still pins — no regression on an '
        'older server', () {
      CommandPolicy.instance.debugReset({'compact': 'chat'});
      expect(CommandPolicy.instance.pinsTerminal('/usage'), isTrue);
    });
  });
}
