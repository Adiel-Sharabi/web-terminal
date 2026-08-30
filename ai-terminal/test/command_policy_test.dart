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

import 'package:ai_terminal/api/api_client.dart';
import 'package:ai_terminal/api/models.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:ai_terminal/services/command_policy.dart';

void main() {
  setUp(() => CommandPolicy.instance.debugReset());

  _quickTests();   // #188 — the offered button row
  _loadRetryTests();

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

// ---------------------------------------------------------------------------
// #188 — the offered button row.
//
// These tests defend ONE property: the client holds no list of its own. Every
// name, label, order and confirmation comes off the wire, so a command added to
// `lib/commands.js` reaches this client with no release. The regression they
// guard is somebody "tidying" the sheet into a hard-coded list here, which then
// silently disagrees with the server and with app.html.
// ---------------------------------------------------------------------------
void _quickTests() {
  group('#188 QuickCommand.fromJson', () {
    test('reads a full row', () {
      final c = QuickCommand.fromJson({
        'name': 'Compact',
        'label': 'Compact',
        'lens': 'chat',
      })!;
      expect(c.name, 'compact'); // lower-cased, like nameOf
      expect(c.label, 'Compact');
      expect(c.lens, 'chat');
      expect(c.confirm, isNull);
      expect(c.isDestructive, isFalse);
      expect(c.text, '/compact');
    });

    test('a row carrying `confirm` is destructive, and keeps the SERVER wording', () {
      final c = QuickCommand.fromJson({
        'name': 'clear',
        'label': 'Clear',
        'lens': 'terminal',
        'confirm': 'Clear the conversation?',
      })!;
      expect(c.isDestructive, isTrue);
      // Server-owned so both clients say the same thing — never re-worded here.
      expect(c.confirm, 'Clear the conversation?');
    });

    test('a missing label falls back to the name rather than dropping the row', () {
      // A server that adds a command but forgets its label should still give the
      // user the button; silently losing it would be the harder bug to notice.
      final c = QuickCommand.fromJson({'name': 'context', 'lens': 'terminal'})!;
      expect(c.label, 'context');
    });

    test('a nameless row is dropped', () {
      expect(QuickCommand.fromJson({'label': 'Nope'}), isNull);
      expect(QuickCommand.fromJson({'name': ''}), isNull);
    });

    test('a blank confirm is NOT destructive — only a real question asks', () {
      final c = QuickCommand.fromJson({'name': 'x', 'lens': 'chat', 'confirm': '  '});
      expect(c!.isDestructive, isFalse);
    });
  });

  group('#188 CommandPolicy.quickCommands', () {
    test('is empty until the server publishes a row — an old server gets no buttons', () {
      CommandPolicy.instance.debugReset();
      expect(CommandPolicy.instance.quickCommands, isEmpty);
    });

    test('preserves the SERVER order — the destructive row must stay last', () {
      // On a phone the first button is the one a thumb reaches by accident. The
      // order is lib/commands.js's decision; re-sorting it here would be a second
      // opinion on a published fact.
      CommandPolicy.instance.debugReset(const {}, const [
        QuickCommand(name: 'compact', label: 'Compact', lens: 'chat'),
        QuickCommand(name: 'context', label: 'Context', lens: 'terminal'),
        QuickCommand(name: 'usage', label: 'Usage', lens: 'terminal'),
        QuickCommand(name: 'clear', label: 'Clear', lens: 'terminal', confirm: 'sure?'),
      ]);
      expect(
        CommandPolicy.instance.quickCommands.map((c) => c.name).toList(),
        ['compact', 'context', 'usage', 'clear'],
      );
      expect(CommandPolicy.instance.quickCommands.last.isDestructive, isTrue);
    });

    test('a button obeys the SAME lens policy a typed line does', () {
      // The whole reason the buttons hang off this table: a button-run command
      // must land where a typed one does. If these diverge, the client has grown
      // a second notion of where the user should stand.
      CommandPolicy.instance.debugReset(const {
        'compact': 'chat',
        'clear': 'terminal',
      }, const [
        QuickCommand(name: 'compact', label: 'Compact', lens: 'chat'),
        QuickCommand(name: 'clear', label: 'Clear', lens: 'terminal', confirm: 'sure?'),
      ]);
      for (final c in CommandPolicy.instance.quickCommands) {
        expect(
          CommandPolicy.instance.pinsTerminal(c.text),
          c.lens == 'terminal',
          reason: '${c.name}: button lens must equal typed lens',
        );
      }
    });

    test('the returned list cannot be mutated by a caller', () {
      CommandPolicy.instance.debugReset(const {}, const [
        QuickCommand(name: 'compact', label: 'Compact', lens: 'chat'),
      ]);
      expect(
        () => CommandPolicy.instance.quickCommands.add(
          const QuickCommand(name: 'x', label: 'x', lens: 'chat'),
        ),
        throwsUnsupportedError,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// #188 — a FAILED catalogue fetch must not be permanent.
//
// Found in review. `ensureLoaded` set `_loaded = true` BEFORE its await, and
// `ApiClient.commandPolicy()` swallows every failure into empty lists — so one
// transient network error on the first session screen left the app with no
// buttons and no server lens policy for the WHOLE RUN, with nothing to trigger a
// retry. That was survivable while this was only consulted at typing time (the
// fallback table covered it); it is not, now that it decides whether the button
// exists at all.
// ---------------------------------------------------------------------------
void _loadRetryTests() {
  ApiClient clientReturning(String body, {int status = 200}) => ApiClient(
    const ServerConfig(name: 't', baseUrl: 'http://127.0.0.1:1', bearerToken: 'x'),
    httpClient: MockClient((_) async => http.Response(body, status)),
  );

  group('#188 ensureLoaded retry', () {
    test('a FAILED fetch does not latch — the next call tries again', () async {
      CommandPolicy.instance.debugReset();

      // First attempt fails (a 500 becomes empty lists inside commandPolicy()).
      final changed1 = await CommandPolicy.instance.ensureLoaded(
        clientReturning('nope', status: 500),
      );
      expect(changed1, isFalse);
      expect(CommandPolicy.instance.quickCommands, isEmpty);

      // The retry must actually reach the network, not short-circuit on _loaded.
      final changed2 = await CommandPolicy.instance.ensureLoaded(
        clientReturning(
          '{"commands":[{"name":"compact","lens":"chat"}],'
          '"quick":[{"name":"compact","label":"Compact","lens":"chat"}]}',
        ),
      );
      expect(changed2, isTrue, reason: 'a failed load must not be sticky');
      expect(CommandPolicy.instance.quickCommands.map((c) => c.name), ['compact']);
    });

    test('a SUCCESSFUL load latches — no repeat fetch per session screen', () async {
      CommandPolicy.instance.debugReset();
      const ok = '{"commands":[{"name":"compact","lens":"chat"}],'
          '"quick":[{"name":"compact","label":"Compact","lens":"chat"}]}';
      expect(await CommandPolicy.instance.ensureLoaded(clientReturning(ok)), isTrue);
      // Second call is a no-op: `changed` false means the caller does no setState.
      expect(await CommandPolicy.instance.ensureLoaded(clientReturning(ok)), isFalse);
    });

    test('returns changed=true only when there is something to render', () async {
      // An empty-but-successful catalogue (a server older than #131) must not
      // report a change, or every session screen would setState for nothing.
      CommandPolicy.instance.debugReset();
      final changed = await CommandPolicy.instance.ensureLoaded(
        clientReturning('{"commands":[],"quick":[]}'),
      );
      expect(changed, isFalse);
    });
  });
}
