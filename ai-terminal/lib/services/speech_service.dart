/// Read the agent's last answer aloud (#70 Phase 1).
///
/// Speech is spoken by **Android's own TextToSpeech**, reached through a
/// hand-rolled MethodChannel (`wt/speech`, implemented in `MainActivity.kt`).
///
/// Why not the `flutter_tts` package: this project already removed it once
/// because its **Windows** build needs `nuget.exe` (see `pubspec.yaml`), and the
/// companion still ships a Windows desktop build. A plugin would put that
/// breakage back for every platform; Kotlin under `android/` cannot. The
/// constraint is designed out rather than worked around.
///
/// What is spoken is decided by the SERVER (`GET /api/sessions/:id/speech`) —
/// this class only renders it. Nothing leaves the device: the phone's TTS is
/// offline.
library;

import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';

class SpeechService {
  SpeechService._();

  @visibleForTesting
  static const MethodChannel channel = MethodChannel('wt/speech');

  /// Test seam: forces [supported] regardless of the host platform, so the
  /// gating logic is testable off-device (a unit test runs on Windows, where
  /// `Platform.isAndroid` is false and the channel has no handler).
  @visibleForTesting
  static bool? debugSupportedOverride;

  /// Android only. The desktop build has no native handler, so every call would
  /// raise `MissingPluginException`; the UI hides the control instead of
  /// offering a button that cannot work.
  static bool get supported =>
      debugSupportedOverride ?? (!kIsWeb && Platform.isAndroid);

  /// Whether the device's TTS engine finished initialising. Initialisation is
  /// asynchronous, so this can be false for a moment after launch.
  static Future<bool> available() => _boolCall('available');

  /// Whether an utterance is currently playing (drives the stop affordance).
  static Future<bool> speaking() => _boolCall('speaking');

  /// Speaks [text], replacing anything already playing. Returns false when the
  /// engine is not ready or [text] is empty.
  ///
  /// An empty [text] is the NORMAL "nothing worth saying" answer from the
  /// server, so it is silently ignored rather than treated as an error.
  /// Playback rate, 1.0 = the engine's normal pace. Persisted per device, since
  /// the comfortable value depends on the listener and the voice, not the app.
  static const String rateKey = 'wt.speak.rate';
  static const double defaultRate = 1.05;

  static Future<double> loadRate() async {
    try {
      final p = await SharedPreferences.getInstance();
      final v = p.getDouble(rateKey);
      if (v != null && v >= 0.5 && v <= 2.5) return v;
    } catch (_) {}
    return defaultRate;
  }

  static Future<void> saveRate(double v) async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setDouble(rateKey, v.clamp(0.5, 2.5));
    } catch (_) {}
  }

  static Future<bool> speak(String text, {double? rate}) async {
    if (!supported || text.trim().isEmpty) return false;
    try {
      final r = rate ?? await loadRate();
      final ok = await channel.invokeMethod<bool>('speak', {'text': text, 'rate': r});
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Stops playback. Best-effort — never throws.
  static Future<void> stop() async {
    if (!supported) return;
    try {
      await channel.invokeMethod<void>('stop');
    } catch (_) {}
  }

  static Future<bool> _boolCall(String method) async {
    if (!supported) return false;
    try {
      final v = await channel.invokeMethod<bool>(method);
      return v ?? false;
    } catch (_) {
      return false;
    }
  }
}
