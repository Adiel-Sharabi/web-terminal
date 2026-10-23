// #383 - the agent's current turn, read from its transcript: the ONE lead-up rule the
// question overlay and the questions inbox share. It joins every text block of the
// turn, stops at the prompt the person typed, skips user turns nobody typed, falls back
// to "You asked / Earlier it said" for a turn with no prose, pages back past one page,
// and names the tool call a permission prompt is waiting on.
import 'package:ai_terminal/api/models.dart';
import 'package:ai_terminal/util/agent_turn.dart';
import 'package:flutter_test/flutter_test.dart';

TranscriptTurn _say(String text, {String? ts, List<ToolUse> tools = const []}) =>
    TranscriptTurn(role: 'assistant', text: text, toolUses: tools, ts: ts);
TranscriptTurn _tool(String name, {Map<String, dynamic> input = const {}, String? result}) => TranscriptTurn(
    role: 'assistant', text: '', toolUses: [ToolUse(name: name, inputPreview: '', input: input, result: result)], ts: null);
TranscriptTurn _typed(String text) =>
    TranscriptTurn(role: 'user', text: text, typedText: text, userKind: 'human', toolUses: const [], ts: null);
TranscriptTurn _user(String text, String kind) =>
    TranscriptTurn(role: 'user', text: text, typedText: '', userKind: kind, toolUses: const [], ts: null);

/// A fake transcript route over [all] (newest last): pages of [limit] older than the
/// cursor, which is the index of the oldest turn already served. Records each read.
class _Pages {
  _Pages(this.all);
  final List<TranscriptTurn> all;
  final List<(String?, int)> reads = [];

  Future<TranscriptPage> read(String? before, int limit) async {
    reads.add((before, limit));
    final end = before == null ? all.length : int.parse(before);
    final start = (end - limit).clamp(0, end);
    return TranscriptPage(
      messages: all.sublist(start, end),
      cursor: start > 0 ? '$start' : null,
      hasMore: start > 0,
    );
  }
}

void main() {
  group('agentTurnOf', () {
    test('joins every text block of the turn, in order, across its tool calls', () {
      final t = agentTurnOf([
        _typed('fix the login'),
        _say('First, what I found:', ts: 'a'),
        _tool('Bash', result: 'ok'),
        _say('- the cookie expires\n- the token is stale', ts: 'b'),
        _tool('Read', result: 'ok'),
        _say('Which fix should I take?', ts: 'c'),
        _tool('AskUserQuestion'),
      ]);
      expect(t.prose, 'First, what I found:\n\n- the cookie expires\n- the token is stale\n\nWhich fix should I take?');
      expect(t.leadUp, t.prose);
      expect(t.reachedPrompt, isTrue);
      expect(t.youAsked, 'fix the login');
      expect(t.at, 'c', reason: 'the newest text block');
    });

    test('stops at the prompt the person typed: nothing from the turn before crosses it', () {
      final t = agentTurnOf([
        _typed('first ask'),
        _say('OLD_REPLY from the previous turn'),
        _typed('second ask'),
        _say('the new reply'),
      ]);
      expect(t.prose, 'the new reply');
      expect(t.prose, isNot(contains('OLD_REPLY')));
      expect(t.earlier, isNull, reason: 'the turn has prose, so no earlier reply is shown');
    });

    test('skips user turns nobody typed: a teammate message, a notification, a skill body, a hook', () {
      final t = agentTurnOf([
        _typed('run the review'),
        _say('Starting.'),
        _user('Another Claude session sent a message:\n<teammate-message teammate_id="J4b2">done</teammate-message>', 'teammate'),
        _say('The reviewer replied.'),
        _user('<task-notification><task-id>1</task-id></task-notification>', 'system'),
        _user('Base directory for this skill: x', 'meta'),
        _say('Pick one?'),
      ]);
      expect(t.prose, 'Starting.\n\nThe reviewer replied.\n\nPick one?');
      expect(t.youAsked, 'run the review');
    });

    test('an older server with no verdict: the local classifier still skips a teammate message', () {
      final t = agentTurnOf([
        _typed('go'),
        _say('one'),
        const TranscriptTurn(
            role: 'user',
            text: 'Another Claude session sent a message:\n<teammate-message teammate_id="J4b2">hi</teammate-message>',
            toolUses: [],
            ts: null),
        _say('two'),
      ]);
      expect(t.prose, 'one\n\ntwo');
    });

    test('a turn with no prose shows "You asked" and "Earlier it said", each labelled', () {
      final t = agentTurnOf([
        _typed('earlier ask'),
        _say('EARLIER_REPLY part one'),
        _say('part two'),
        _typed('/plan the feature'),
        _tool('Read', result: 'ok'),
        _tool('AskUserQuestion'),
      ]);
      expect(t.prose, isEmpty);
      expect(t.youAsked, '/plan the feature');
      expect(t.earlier, 'EARLIER_REPLY part one\n\npart two');
      expect(t.leadUp, '**You asked:**\n\n/plan the feature\n\n**Earlier it said:**\n\nEARLIER_REPLY part one\n\npart two');
    });

    test('nothing at all to show is null, never an empty panel', () {
      expect(agentTurnOf(const []).leadUp, isNull);
      expect(agentTurnOf([_tool('Bash')]).leadUp, isNull);
    });
  });

  group('loadAgentTurn', () {
    test('pages back past one page (the old limit:12) until the prompt is found', () async {
      final all = [
        _say('OLD'),
        _typed('the real prompt'),
        _say('HEAD_OF_TURN'),
        for (var i = 0; i < 120; i++) _tool('Bash', result: 'ok'),
        _say('Which one?'),
        _tool('AskUserQuestion'),
      ];
      final pages = _Pages(all);
      final t = await loadAgentTurn(pages.read);
      expect(t.prose, 'HEAD_OF_TURN\n\nWhich one?');
      expect(t.reachedPrompt, isTrue);
      expect(pages.reads.first, (null, kAgentTurnFirstPage));
      expect(pages.reads.length, greaterThan(1), reason: 'the prompt is 123 turns back');
      expect(pages.reads.skip(1).every((r) => r.$1 != null), isTrue, reason: 'each further read passes the cursor');
    });

    test('one page is enough when the prompt is on it', () async {
      final pages = _Pages([_typed('go'), _say('Which?')]);
      await loadAgentTurn(pages.read);
      expect(pages.reads, hasLength(1));
    });

    test('for "Earlier it said" it reads on to the previous prompt, unless asked not to', () async {
      final all = [
        _typed('before'),
        _say('EARLIER'),
        for (var i = 0; i < 80; i++) _tool('Bash', result: 'ok'),
        _typed('now'),
        _tool('AskUserQuestion'),
      ];
      final withEarlier = await loadAgentTurn(_Pages(all).read);
      expect(withEarlier.earlier, 'EARLIER');
      final pages = _Pages(all);
      final without = await loadAgentTurn(pages.read, earlier: false);
      expect(without.earlier, isNull);
      expect(pages.reads, hasLength(1));
    });

    test('never reads more than the cap, and says the prompt was not reached', () async {
      final pages = _Pages([
        _typed('far back'),
        for (var i = 0; i < 1000; i++) _tool('Bash', result: 'ok'),
        _say('tail'),
      ]);
      final t = await loadAgentTurn(pages.read);
      final read = pages.reads.fold<int>(0, (n, r) => n + r.$2);
      expect(read, lessThanOrEqualTo(kAgentTurnMaxTurns));
      expect(t.reachedPrompt, isFalse);
      expect(t.prose, 'tail', reason: 'what was read is still shown');
    });
  });

  group('the tool call a permission waits on', () {
    test('the newest call with no result is pending; one with a result is not', () {
      final pending = pendingToolUse([
        _typed('clean up'),
        _tool('Read', result: 'ok'),
        _say('Removing the build folder.'),
        _tool('Bash', input: {'command': 'rm -rf build', 'description': 'Remove build'}),
      ]);
      expect(pending?.name, 'Bash');
      expect(toolCallText(pending!), 'rm -rf build');
      expect(pendingToolUse([_typed('x'), _tool('Bash', input: {'command': 'ls'}, result: 'a b')]), isNull);
      expect(pendingToolUse([_tool('Bash'), _typed('new prompt')]), isNull, reason: 'not across a prompt');
    });

    test('toolCallText names a file or path when there is no command', () {
      expect(toolCallText(const ToolUse(name: 'Edit', inputPreview: '', input: {'file_path': 'lib/a.dart'})), 'lib/a.dart');
      expect(toolCallText(const ToolUse(name: 'X', inputPreview: '{}')), isNull);
    });

    test('loadAgentTurn reads it from the newest page', () async {
      final t = await loadAgentTurn(_Pages([
        _typed('go'),
        _say('About to clean.'),
        _tool('Bash', input: {'command': 'rm -rf build'}),
      ]).read);
      expect(t.pendingTool?.input['command'], 'rm -rf build');
      expect(t.leadUp, 'About to clean.');
    });
  });

  // Review findings on the full-text change (report-T).
  group('the approval screen names a call only when it is unambiguous', () {
    ToolUse bash(String cmd, {String? result}) => ToolUse(name: 'Bash', inputPreview: '', input: {'command': cmd}, result: result);
    TranscriptTurn calls(List<ToolUse> uses) => TranscriptTurn(role: 'assistant', text: '', toolUses: uses, ts: null);

    test('one waiting call: named', () {
      final p = pendingToolUse([_typed('ship it'), _say('Pushing.'), calls([bash('git push')])]);
      expect(p?.input['command'], 'git push');
    });

    test('parallel calls, both waiting: which one asks is unknown, so none', () {
      // Claude Code writes each block of one message as its own line: two lines here.
      expect(pendingToolUse([_typed('clean'), calls([bash('rm -rf dist')]), calls([bash('git push --force')])]), isNull);
      expect(pendingToolUse([_typed('clean'), calls([bash('rm -rf dist'), bash('git push --force')])]), isNull);
    });

    test('an allow-listed call still running beside the one that asks: none', () {
      expect(pendingToolUse([_typed('go'), calls([bash('npm test')]), _say('Meanwhile:'), calls([bash('git push')])]), isNull);
    });

    test('a subagent asking: the open Agent/Task call is not the command, so none', () {
      for (final name in ['Agent', 'Task']) {
        expect(
            pendingToolUse([
              _typed('review it'),
              _tool(name, input: {'description': 'review', 'prompt': '{"files": ["a.dart"]}'}),
            ]),
            isNull,
            reason: name);
      }
    });

    test('a finished call does not count against the one that waits', () {
      final p = pendingToolUse([_typed('go'), calls([bash('ls', result: 'a b')]), calls([bash('git push')])]);
      expect(p?.input['command'], 'git push');
    });

    test('the server\'s own "now" line must agree; a subagent\'s, or another tool\'s, hides it', () {
      final p = bash('git push');
      const dot = '\u00b7';
      expect(permissionToolCall(p, null), same(p), reason: 'no line: the transcript alone');
      expect(permissionToolCall(p, 'Bash $dot Push to origin'), same(p));
      expect(permissionToolCall(p, 'Subagent: Bash $dot Push to origin'), isNull);
      expect(permissionToolCall(p, 'Subagent $dot review the diff'), isNull);
      expect(permissionToolCall(p, 'Edit $dot a.dart'), isNull);
      const mcp = ToolUse(name: 'mcp__github__create_issue', inputPreview: '', input: {'title': 'x'});
      expect(permissionToolCall(mcp, 'github $dot create_issue'), same(mcp));
      expect(permissionToolCall(null, 'Bash $dot x'), isNull);
    });
  });

  group('a turn begins at a HUMAN prompt (the server\'s isHumanPrompt)', () {
    test('/cost after an ask is not a boundary: the ask still stands', () {
      final t = agentTurnOf([
        _typed('push the fix'),
        _say('Tests pass. Should I push it?'),
        _user('<command-name>/cost</command-name>\n<command-message>cost</command-message>\n<command-args></command-args>', 'command'),
        _user('<local-command-stdout>Total cost: \$0.42</local-command-stdout>', 'system'),
      ]);
      expect(t.prose, 'Tests pass. Should I push it?');
      expect(t.youAsked, 'push the fix');
    });

    test('a skill or prompt command (written message-first, read as human) IS a boundary', () {
      final t = agentTurnOf([
        _typed('earlier'),
        _say('OLD_REPLY'),
        _user('<command-message>dds-recap</command-message>\n<command-name>/dds-recap</command-name>\n<command-args>383</command-args>',
            'human'),
        _user('Base directory for this skill: x', 'meta'),
        _say('Recap: 3 done.'),
      ]);
      expect(t.prose, 'Recap: 3 done.');
      expect(t.prose, isNot(contains('OLD_REPLY')));
    });
  });

  group('what the lead-up says about itself', () {
    test('the fallback goes under its own heading, not "Claude said"', () {
      final prose = agentTurnOf([_typed('go'), _say('words')]);
      expect(prose.leadUpLabel, kLeadUpLabel);
      final fallback = agentTurnOf([_typed('first'), _say('earlier words'), _typed('second'), _tool('Bash')]);
      expect(fallback.leadUp, contains('**You asked:**'));
      expect(fallback.leadUpLabel, kLeadUpFallbackLabel);
      expect(kLeadUpFallbackLabel, isNot(kLeadUpLabel));
    });

    test('a turn the cap cut says so; one that reached its prompt does not', () async {
      final cut = await loadAgentTurn(_Pages([
        _typed('far back'),
        for (var i = 0; i < 1000; i++) _tool('Bash', result: 'ok'),
        _say('tail'),
      ]).read);
      expect(cut.capped, isTrue);
      expect(cut.leadUp, '$kAgentTurnCappedNote\n\ntail');
      final whole = await loadAgentTurn(_Pages([_typed('go'), _say('tail')]).read);
      expect(whole.capped, isFalse);
      expect(whole.leadUp, 'tail');
      final short = await loadAgentTurn(_Pages([_say('no prompt at all'), _say('tail')]).read);
      expect(short.capped, isFalse, reason: 'the transcript ran out: nothing was left unread');
    });
  });
}
