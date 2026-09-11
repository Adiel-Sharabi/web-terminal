// #190 - a session parked on Claude's startup selector must not be described as
// "starting".
//
// The compose bar's #147 wording ("Starting the agent - type now, send in a moment",
// with a spinner) is a PROMISE that the wait ends on its own. It does, for a boot. It
// does not for a folder-trust selector, which sits there until somebody answers it -
// and that is the session where pressing Send confirms `No, exit` and kills the agent.
// So the lie is worst exactly where the stakes are highest.
//
// What is pinned here is the RULE, not a pixel: the wording is a pure top-level
// function for the same reason `terminalTailGateOpen` is, and a widget test could not
// tell a truthful hint from a plausible one anyway.
import 'package:flutter_test/flutter_test.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/screens/session_screen.dart';

void main() {
  group('#190 blockedPromptMessage', () {
    test('null for an ordinary boot - the #147 wording is untouched', () {
      // The default, and the one every existing session and every older server gets.
      // Getting this wrong would replace a correct message everywhere to fix one case.
      expect(blockedPromptMessage(null), isNull);
    });

    test('quotes the dialog OWN options, not a name for the dialog', () {
      final msg = blockedPromptMessage(const BlockedPrompt(
        id: 'folder-trust',
        options: ['No, exit', 'Yes, I trust this folder'],
      ));
      expect(msg, contains('Terminal'));
      expect(msg, contains('No, exit'));
      expect(msg, contains('Yes, I trust this folder'));
      // NOT a paraphrase. #190 asks for "enough of the terminal's own text to say
      // what is being asked", and a session whose choices include `No, exit` is not
      // one to describe in words of our own.
      expect(msg, isNot(contains('starting')));
      expect(msg, isNot(contains('Starting')));
    });

    test('an UNKNOWN member reads the same - recognition is wider than answering', () {
      // A member recognised only by SHAPE carries no id. It must still explain itself:
      // the whole point of the shape gate is to cover dialogs nobody has measured.
      final msg = blockedPromptMessage(const BlockedPrompt(
        options: ['No, disable external imports', 'Yes, allow them'],
      ));
      expect(msg, contains('No, disable external imports'));
      expect(msg, contains('Terminal'));
    });

    test('options missing still explains itself rather than going silent', () {
      // Falling back to null here would put the spinner back on a session we KNOW is
      // blocked - failing open in the one direction that costs a prompt.
      expect(blockedPromptMessage(const BlockedPrompt(id: 'folder-trust')), isNotNull);
      expect(blockedPromptMessage(const BlockedPrompt(options: ['   '])), isNotNull);
    });

    test('a long option list is capped, so a phone bar still shows the choice', () {
      final msg = blockedPromptMessage(const BlockedPrompt(
        options: ['One', 'Two', 'Three', 'Four'],
      ));
      expect(msg, contains('One'));
      expect(msg, contains('Two'));
      expect(msg, isNot(contains('Three')));
      expect(msg, contains('...'));
    });
  });

  group('#190 BlockedPrompt.fromJson', () {
    test('absent reads as null - an older server is an ordinary boot', () {
      expect(BlockedPrompt.fromJson(null), isNull);
      expect(BlockedPrompt.fromJson('nonsense'), isNull);
    });

    test('carries what the server published', () {
      final b = BlockedPrompt.fromJson({
        'id': 'folder-trust',
        'options': ['No, exit', 'Yes, I trust this folder'],
        'at': 1789127552432,
      });
      expect(b!.id, 'folder-trust');
      expect(b.options, ['No, exit', 'Yes, I trust this folder']);
      expect(b.at, 1789127552432);
    });

    test('a shape-only match has a null id and still keeps its options', () {
      final b = BlockedPrompt.fromJson({'options': ['A', 'B']});
      expect(b!.id, isNull);
      expect(b.options, ['A', 'B']);
    });
  });

  group('#190 Session carries it', () {
    test('parsed off GET /api/sessions', () {
      final s = Session.fromJson(
        const ServerConfig(name: 'local', baseUrl: 'http://127.0.0.1:7681', bearerToken: ''),
        {
          'id': 'abc',
          'name': 'n',
          'agentReady': false,
          'blockedPrompt': {'id': 'folder-trust', 'options': ['No, exit', 'Yes, I trust this folder']},
        },
      );
      expect(s.agentReady, isFalse);
      expect(s.blockedPrompt!.id, 'folder-trust');
    });

    test('survives withFavoriteRank - the field-by-field rebuild drops nothing', () {
      // models_test.dart already pins this for every other field; a new one has to be
      // added to that rebuild by hand, and silently loses its value if it is not.
      final s = Session.fromJson(
        const ServerConfig(name: 'local', baseUrl: 'http://127.0.0.1:7681', bearerToken: ''),
        {
          'id': 'abc',
          'name': 'n',
          'blockedPrompt': {'id': 'folder-trust', 'options': ['No, exit']},
        },
      ).withFavoriteRank(3);
      expect(s.blockedPrompt!.id, 'folder-trust');
      expect(s.blockedPrompt!.options, ['No, exit']);
    });
  });
}
