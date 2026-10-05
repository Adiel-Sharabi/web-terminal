// #291: dictate into the compose bar without opening the keyboard.
//
// SCOPE: these tests pin the Dart half — where dictated words land in the field,
// which native reports are believed, and what the bar draws. They CANNOT prove
// the phone hears anything: that is Android's SpeechRecognizer behind a channel,
// and only a real device shows it (and only a person can judge Hebrew quality).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/services/dictation_service.dart';
import 'package:ai_terminal/theme/app_theme.dart';
import 'package:ai_terminal/widgets/compose_bar.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('DictationMerge', () {
    test('an empty field receives the words with no padding', () {
      final m = DictationMerge('', 0)..onPartial('hello');
      expect(m.render().text, 'hello');
      expect(m.render().selection.baseOffset, 5);
    });

    test('a partial is REVISED, not appended, until the utterance ends', () {
      final m = DictationMerge('', 0)
        ..onPartial('add the')
        ..onPartial('add the keyboard');
      expect(m.render().text, 'add the keyboard');
    });

    test('finished utterances accumulate; the next partial follows them', () {
      final m = DictationMerge('', 0)
        ..onFinal('Add the keyboard view.')
        ..onPartial('then the mic');
      expect(m.render().text, 'Add the keyboard view. then the mic');
    });

    test('words go in at the caret, spaced from the text on both sides', () {
      final m = DictationMerge('fix thebug', 7)..onPartial('nasty');
      expect(m.render().text, 'fix the nasty bug');
      expect(m.render().selection.baseOffset, 'fix the nasty'.length);
    });

    test('existing whitespace is not doubled', () {
      final m = DictationMerge('one  two', 4)..onPartial('and');
      expect(m.render().text, 'one and two');
    });

    test('nothing heard leaves the field exactly as it was', () {
      final m = DictationMerge('keep me', 4);
      expect(m.render().text, 'keep me');
    });

    test('a language switch keeps the words already on screen', () {
      final m = DictationMerge('', 0)
        ..onPartial('hello there')
        ..commitPartial()
        ..onPartial('שלום');
      expect(m.render().text, 'hello there שלום');
    });

    test('a selection is REPLACED by the dictated words', () {
      final m = DictationMerge('fix the bug', 4, 7)..onPartial('a');
      expect(m.render().text, 'fix a bug');
    });

    test('a selection survives until a word is HEARD (a blank partial is not one)', () {
      final m = DictationMerge('fix the bug', 4, 7)..onPartial('   ');
      expect(m.render().text, 'fix the bug');
    });

    test('a caret past the end is clamped rather than throwing', () {
      final m = DictationMerge('abc', 99)..onPartial('d');
      expect(m.render().text, 'abc d');
    });
  });

  group('DictationService', () {
    late List<MethodCall> calls;
    late StreamController<dynamic> events;
    late DictationService svc;
    late TextEditingController field;
    const channel = MethodChannel('wt/dictation-test');

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      calls = [];
      events = StreamController<dynamic>.broadcast();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return true;
      });
      svc = DictationService.forTest(channel, events.stream);
      field = TextEditingController();
    });

    tearDown(() => events.close());

    Future<void> send(Map<String, Object?> e) async {
      events.add(e);
      await Future<void>.delayed(Duration.zero);
    }

    int sessionOf(MethodCall c) => (c.arguments as Map)['session'] as int;

    test('start asks for the remembered language and numbers the session', () async {
      SharedPreferences.setMockInitialValues({DictationService.languageKey: 'he-IL'});
      await svc.start(field);
      final start = calls.singleWhere((c) => c.method == 'start');
      expect((start.arguments as Map)['language'], 'he-IL');
      expect(sessionOf(start), 1);
      expect(svc.isListeningTo(field), isTrue);
    });

    test('heard words are written into the field', () async {
      await svc.start(field);
      await send({'type': 'partial', 'text': 'add the', 'session': 1});
      await send({'type': 'final', 'text': 'add the keyboard', 'session': 1});
      await send({'type': 'partial', 'text': 'view', 'session': 1});
      expect(field.text, 'add the keyboard view');
    });

    test('a report from an ENDED session is ignored', () async {
      await svc.start(field);
      await svc.stop();
      await svc.start(field); // session 2, before session 1 reported "stopped"
      await send({'type': 'state', 'listening': false, 'session': 1});
      await send({'type': 'partial', 'text': 'stale', 'session': 1});
      expect(svc.isListeningTo(field), isTrue,
          reason: "session 1's late 'stopped' must not end session 2");
      expect(field.text, isEmpty);
    });

    test('the user typing wins: a later report is dropped and the mic cancelled', () async {
      await svc.start(field);
      await send({'type': 'partial', 'text': 'hello', 'session': 1});
      field.text = 'hello, edited by hand';
      await send({'type': 'final', 'text': 'hello world', 'session': 1});
      expect(field.text, 'hello, edited by hand');
      expect(svc.isListeningTo(field), isFalse);
      expect(calls.map((c) => c.method), contains('cancel'));
    });

    test('a selection-only change (focus loss) is NOT an edit', () async {
      await svc.start(field);
      await send({'type': 'partial', 'text': 'hello', 'session': 1});
      field.selection = const TextSelection.collapsed(offset: 0);
      await send({'type': 'partial', 'text': 'hello world', 'session': 1});
      expect(field.text, 'hello world');
      expect(svc.isListeningTo(field), isTrue);
    });

    test('cancel stops at once; nothing heard afterwards lands', () async {
      await svc.start(field);
      await send({'type': 'partial', 'text': 'send this', 'session': 1});
      await svc.cancelFor(field);
      await send({'type': 'final', 'text': 'send this please', 'session': 1});
      expect(field.text, 'send this');
      expect(svc.isListeningTo(field), isFalse);
    });

    test('cancelFor another field leaves this one listening', () async {
      await svc.start(field);
      await svc.cancelFor(TextEditingController());
      expect(svc.isListeningTo(field), isTrue);
    });

    test('a native "stopped" ends the session (after a stop flushed its words)', () async {
      await svc.start(field);
      await svc.stop();
      await send({'type': 'final', 'text': 'last words', 'session': 1});
      await send({'type': 'state', 'listening': false, 'session': 1});
      expect(field.text, 'last words');
      expect(svc.isListeningTo(field), isFalse);
    });

    test('an error ends the session and is reported against THIS field', () async {
      await svc.start(field);
      await send({'type': 'error', 'code': '13', 'session': 1});
      expect(svc.isListeningTo(field), isFalse);
      expect(svc.errorFor(field), 'English dictation is not available on this device');
      expect(svc.errorFor(TextEditingController()), isNull);
    });

    test('leaving an errored field clears its error AND tells the bar', () async {
      await svc.start(field);
      await send({'type': 'error', 'code': 'permission', 'session': 1});
      var notified = 0;
      svc.addListener(() => notified++);
      await svc.cancelFor(field);
      expect(svc.errorFor(field), isNull);
      expect(notified, greaterThan(0),
          reason: 'without a notify the error row stays drawn and Dismiss is dead');
    });

    test('a heard word marks the mic ready even without a ready event', () async {
      await svc.start(field);
      expect(svc.ready, isFalse);
      await send({'type': 'partial', 'text': 'hello', 'session': 1});
      expect(svc.ready, isTrue);
    });

    test('switching language persists it and restarts listening in it', () async {
      await svc.start(field);
      await send({'type': 'partial', 'text': 'hello', 'session': 1});
      await svc.nextLanguage();
      expect(svc.language.tag, 'he-IL');
      final lang = calls.lastWhere((c) => c.method == 'language');
      expect((lang.arguments as Map)['language'], 'he-IL');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(DictationService.languageKey), 'he-IL');
      await send({'type': 'partial', 'text': 'שלום', 'session': 1});
      expect(field.text, 'hello שלום', reason: 'the English words must survive the switch');
    });

    test('starting on a second field ends the first', () async {
      final other = TextEditingController();
      await svc.start(field);
      await svc.start(other);
      expect(svc.isListeningTo(field), isFalse);
      expect(svc.isListeningTo(other), isTrue);
    });
  });

  group('dictationErrorMessage', () {
    const he = DictationLanguage('he-IL', 'עב', 'Hebrew');
    test('names the language when it is the language that is missing', () {
      expect(dictationErrorMessage('12', he), 'Hebrew dictation is not available on this device');
    });
    test('permission and network failures say what to fix', () {
      expect(dictationErrorMessage('permission', he), contains('permission'));
      expect(dictationErrorMessage('2', he), contains('network'));
    });
  });

  group('ComposeBar mic', () {
    late StreamController<dynamic> events;
    late DictationService svc;
    const channel = MethodChannel('wt/dictation-bar-test');

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      events = StreamController<dynamic>.broadcast();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async => true);
      svc = DictationService.forTest(channel, events.stream);
    });

    tearDown(() => events.close());

    Widget bar(TextEditingController c, {VoidCallback? onDictate, DictationService? d}) =>
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: ComposeBar(
                controller: c,
                focusNode: FocusNode(),
                onSend: () {},
                isLive: false,
                dictation: d,
                onDictate: onDictate,
              ),
            ),
          ),
        );

    testWidgets('no dictation service, no mic (desktop and every older call site)', (t) async {
      await t.pumpWidget(bar(TextEditingController()));
      expect(find.byKey(const ValueKey('compose-mic')), findsNothing);
    });

    testWidgets('the mic calls onDictate', (t) async {
      var taps = 0;
      await t.pumpWidget(bar(TextEditingController(), d: svc, onDictate: () => taps++));
      await t.tap(find.byKey(const ValueKey('compose-mic')));
      expect(taps, 1);
    });

    testWidgets('while listening: a stop mic and a status line with the language switch', (t) async {
      final c = TextEditingController();
      await t.pumpWidget(bar(c, d: svc, onDictate: () {}));
      expect(find.byKey(const ValueKey('compose-dictation-status')), findsNothing);
      await t.runAsync(() => svc.start(c));
      await t.pump();
      // Not "Listening" until the mic is really open: words before that are lost.
      expect(find.text('Starting the mic · English'), findsOneWidget);
      await t.runAsync(() async {
        events.add({'type': 'ready', 'session': 1});
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      await t.pump();
      expect(find.text('Listening · English'), findsOneWidget);
      expect(find.byTooltip('Stop dictation'), findsOneWidget);
      await t.tap(find.byKey(const ValueKey('compose-dictation-language')));
      await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await t.pump();
      expect(find.text('Listening · Hebrew'), findsOneWidget);
    });

    testWidgets('a failure is shown on the bar until dismissed', (t) async {
      final c = TextEditingController();
      await t.pumpWidget(bar(c, d: svc, onDictate: () {}));
      await t.runAsync(() async {
        await svc.start(c);
        events.add({'type': 'error', 'code': 'permission', 'session': 1});
        await Future<void>.delayed(const Duration(milliseconds: 10));
      });
      await t.pump();
      expect(find.text('Microphone permission was denied'), findsOneWidget);
      await t.tap(find.byTooltip('Dismiss'));
      await t.pump();
      expect(find.text('Microphone permission was denied'), findsNothing);
    });
  });
}
