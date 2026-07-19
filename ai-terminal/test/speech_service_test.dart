// #70 Phase 1 (companion): the read-aloud platform channel.
//
// HONEST SCOPE: these tests prove the CONTRACT with the native side — which
// method names are invoked, with what arguments, and that every failure path is
// swallowed rather than thrown at the UI. They CANNOT prove the phone actually
// speaks: that is Android's TextToSpeech behind a MethodChannel, and only a real
// device can show it. Treat a green run here as "the wiring is right", never as
// "read-aloud works".
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:ai_terminal/services/speech_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final calls = <MethodCall>[];
  // Stands in for MainActivity.kt's handler.
  void mockNative({bool ready = true, bool speaking = false}) {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SpeechService.channel, (call) async {
      calls.add(call);
      switch (call.method) {
        case 'available':
          return ready;
        case 'speaking':
          return speaking;
        case 'speak':
          return ready;
        case 'stop':
          return null;
      }
      return null;
    });
  }

  setUp(() {
    calls.clear();
    SpeechService.debugSupportedOverride = true;
  });

  tearDown(() {
    SpeechService.debugSupportedOverride = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SpeechService.channel, null);
  });

  test('speak forwards the text AND the rate to the native channel', () async {
    mockNative();
    expect(await SpeechService.speak('The build passed.', rate: 1.4), isTrue);
    expect(calls.single.method, 'speak');
    expect(calls.single.arguments, {'text': 'The build passed.', 'rate': 1.4});
  });

  test('the stored rate is used when the caller does not pass one', () async {
    SharedPreferences.setMockInitialValues({SpeechService.rateKey: 1.6});
    mockNative();
    await SpeechService.speak('hello');
    expect((calls.single.arguments as Map)['rate'], 1.6);
  });

  test('an out-of-range stored rate falls back to the default', () async {
    // A corrupt or hand-edited pref must not produce unintelligible speech.
    SharedPreferences.setMockInitialValues({SpeechService.rateKey: 9.0});
    expect(await SpeechService.loadRate(), SpeechService.defaultRate);
  });

  test('saveRate clamps rather than storing an unusable value', () async {
    SharedPreferences.setMockInitialValues({});
    await SpeechService.saveRate(99);
    expect(await SpeechService.loadRate(), 2.5);
  });

  test('an EMPTY utterance never reaches the device', () async {
    // Empty is the server's normal "nothing worth saying" answer. Sending it
    // would make the engine no-op anyway, but the point is that silence is a
    // deliberate outcome, not an accident.
    mockNative();
    expect(await SpeechService.speak(''), isFalse);
    expect(await SpeechService.speak('   '), isFalse);
    expect(calls, isEmpty);
  });

  test('speak reports false when the engine is not ready', () async {
    mockNative(ready: false);
    expect(await SpeechService.speak('hello'), isFalse);
  });

  test('a native exception is swallowed, never thrown at the UI', () async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SpeechService.channel, (call) async {
      throw PlatformException(code: 'boom');
    });
    expect(await SpeechService.speak('hello'), isFalse);
    expect(await SpeechService.available(), isFalse);
    expect(await SpeechService.speaking(), isFalse);
    await SpeechService.stop(); // must not throw
  });

  test('stop and speaking hit the right native methods', () async {
    mockNative(speaking: true);
    expect(await SpeechService.speaking(), isTrue);
    await SpeechService.stop();
    expect(calls.map((c) => c.method), ['speaking', 'stop']);
  });

  test('on an unsupported platform nothing is sent to the channel at all', () async {
    // The desktop build has no handler; a call there would raise
    // MissingPluginException. The gate must short-circuit before that.
    mockNative();
    SpeechService.debugSupportedOverride = false;
    expect(await SpeechService.speak('hello'), isFalse);
    expect(await SpeechService.available(), isFalse);
    expect(await SpeechService.speaking(), isFalse);
    await SpeechService.stop();
    expect(calls, isEmpty);
  });
}
