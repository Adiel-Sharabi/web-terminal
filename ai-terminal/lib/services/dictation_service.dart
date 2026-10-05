/// Dictate into the compose bar without opening the keyboard (#291).
///
/// The keyboard's own mic already dictates, but only from inside a keyboard
/// that takes ~330 dp of the screen. This reaches the SAME recognizer (Android's
/// `SpeechRecognizer`, i.e. the device's speech service) through a hand-rolled
/// channel pair implemented in `Dictation.kt`, so recognition quality and where
/// the audio goes are unchanged - only the button moves. #70 dropped building our
/// own speech-to-text; this builds none.
///
/// Native code only reports what it heard (`partial` / `final` / `state` /
/// `error` events). Everything about what to DO with it - where the words land
/// in the field, when a stale report must be ignored - lives here, where it is
/// testable off-device.
///
/// One instance for the whole app: an `EventChannel` has exactly one native
/// sink, so two listeners (split view mounts more than one session screen) would
/// cancel each other. The service is bound to at most one compose field at a
/// time, and starting on another field ends the first.
library;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A dictation language the picker offers, as a BCP-47 tag plus how it is shown.
@immutable
class DictationLanguage {
  const DictationLanguage(this.tag, this.label, this.name);
  final String tag;
  final String label;
  final String name;
}

/// English and Hebrew, both offered so their quality can be compared (#291).
/// The first entry is the default.
const List<DictationLanguage> kDictationLanguages = [
  DictationLanguage('en-US', 'EN', 'English'),
  DictationLanguage('he-IL', 'עב', 'Hebrew'),
];

/// Where dictated words land in a field: at the caret it had when dictation
/// started, or in place of the selection if there was one (as every other
/// dictation UI does), with a space either side where the neighbouring text
/// needs one.
///
/// Pure, so the merge rule is tested without a device. [committed] is the text
/// of every finished utterance this session; [partial] is the utterance still
/// being heard, which the recognizer revises until it ends.
class DictationMerge {
  factory DictationMerge(String text, int start, [int? end]) {
    final s = start.clamp(0, text.length);
    final e = (end ?? s).clamp(s, text.length);
    return DictationMerge._(text, text.substring(0, s), text.substring(e));
  }

  DictationMerge._(this.original, this.prefix, this.suffix);

  /// The field as it was. Shown until a word is actually heard, so a selection
  /// is only replaced by speech, never by silence (or a blank first partial).
  final String original;
  final String prefix;
  final String suffix;
  String committed = '';
  String partial = '';

  static String _join(String a, String b) =>
      a.isEmpty ? b : (b.isEmpty ? a : '$a $b');

  void onPartial(String text) => partial = text.trim();

  void onFinal(String text) {
    committed = _join(committed, text.trim());
    partial = '';
  }

  /// Keeps what was being heard when the utterance is abandoned (a language
  /// switch): the words were on screen, so they must not vanish.
  void commitPartial() {
    committed = _join(committed, partial);
    partial = '';
  }

  TextEditingValue render() {
    final spoken = _join(committed, partial);
    if (spoken.isEmpty) {
      return TextEditingValue(
        text: original,
        selection: TextSelection.collapsed(
          offset: original.length - suffix.length,
        ),
      );
    }
    final lead = prefix.isNotEmpty && !_endsWithSpace(prefix) ? ' ' : '';
    final trail = suffix.isNotEmpty && !_startsWithSpace(suffix) ? ' ' : '';
    final before = '$prefix$lead$spoken';
    return TextEditingValue(
      text: '$before$trail$suffix',
      selection: TextSelection.collapsed(offset: before.length),
    );
  }

  static bool _endsWithSpace(String s) => RegExp(r'\s$').hasMatch(s);
  static bool _startsWithSpace(String s) => RegExp(r'^\s').hasMatch(s);
}

/// What a native error code means to the person holding the phone.
String dictationErrorMessage(String code, DictationLanguage lang) {
  switch (code) {
    case 'permission':
      return 'Microphone permission was denied';
    case 'unavailable':
      return 'This device has no speech service';
    case '1': // ERROR_NETWORK_TIMEOUT
    case '2': // ERROR_NETWORK
      return 'Dictation needs a network connection';
    case '3': // ERROR_AUDIO
      return 'The microphone could not be opened';
    case '12': // ERROR_LANGUAGE_NOT_SUPPORTED
    case '13': // ERROR_LANGUAGE_UNAVAILABLE
      return '${lang.name} dictation is not available on this device';
    default:
      return 'Dictation stopped (error $code)';
  }
}

class DictationService extends ChangeNotifier {
  DictationService._(this._channel, Stream<dynamic> Function() events)
    : _events = events;

  static final DictationService instance = DictationService._(
    const MethodChannel('wt/dictation'),
    () => const EventChannel('wt/dictation/events').receiveBroadcastStream(),
  );

  /// A service on fake channels, for tests.
  @visibleForTesting
  factory DictationService.forTest(
    MethodChannel channel,
    Stream<dynamic> events,
  ) => DictationService._(channel, () => events);

  /// Forces [supported] regardless of the host platform (tests run on Windows).
  @visibleForTesting
  static bool? debugSupportedOverride;

  /// Android only. The desktop build has no native handler, and a hardware
  /// keyboard has no screen to win back.
  static bool get supported =>
      debugSupportedOverride ?? (!kIsWeb && Platform.isAndroid);

  static const String languageKey = 'wt.dictation.lang';

  final MethodChannel _channel;
  final Stream<dynamic> Function() _events;
  StreamSubscription<dynamic>? _sub;

  TextEditingController? _target;
  DictationMerge? _merge;

  /// Numbers each start. Native echoes it on every event, and an event from any
  /// other session (one already stopped or cancelled) is ignored, so a late
  /// "stopped" can never end the session that replaced it.
  int _session = 0;

  /// The text this service last wrote into [_target]. Any other text in the
  /// field means the user edited it, and a late report must not overwrite that.
  String? _written;

  /// The mic is actually open (native `onReadyForSpeech`). Until then the bar
  /// says it is starting: words spoken before this are not heard.
  bool _ready = false;
  bool get ready => _ready;

  DictationLanguage _language = kDictationLanguages.first;
  bool _languageLoaded = false;
  String? _error;
  TextEditingController? _errorTarget;

  DictationLanguage get language => _language;

  /// Dictation is running into [controller].
  bool isListeningTo(TextEditingController controller) =>
      identical(_target, controller);

  /// The last failure, if it happened on [controller] and nothing has been done
  /// since.
  String? errorFor(TextEditingController controller) =>
      identical(_errorTarget, controller) ? _error : null;

  void clearError() {
    if (_error == null) return;
    _error = null;
    _errorTarget = null;
    notifyListeners();
  }

  Future<void> _loadLanguage() async {
    if (_languageLoaded) return;
    _languageLoaded = true;
    try {
      final p = await SharedPreferences.getInstance();
      final tag = p.getString(languageKey);
      _language = kDictationLanguages.firstWhere(
        (l) => l.tag == tag,
        orElse: () => kDictationLanguages.first,
      );
    } catch (_) {}
  }

  /// Start dictating into [controller] at its caret. Ends dictation into any
  /// other field first.
  Future<void> start(TextEditingController controller) async {
    if (_target != null) await cancel();
    await _loadLanguage();
    _sub ??= _events().listen(_onEvent);
    _error = null;
    _errorTarget = null;
    final sel = controller.selection;
    final len = controller.text.length;
    final from = sel.isValid ? sel.start : len;
    final to = sel.isValid ? sel.end : len;
    _session += 1;
    _target = controller;
    _merge = DictationMerge(controller.text, from, to);
    _written = controller.text;
    _ready = false;
    notifyListeners();
    try {
      await _channel.invokeMethod<bool>('start', {
        'language': _language.tag,
        'session': _session,
      });
    } catch (e) {
      _fail('unavailable');
    }
  }

  /// Stop listening, keeping the final words of the utterance in flight.
  Future<void> stop() async {
    if (_target == null) return;
    try {
      await _channel.invokeMethod<bool>('stop');
    } catch (_) {
      _close();
    }
  }

  /// Stop listening NOW and accept nothing more: the text already in the field
  /// stays exactly as it is. Used on send, on typing, and on leaving the screen.
  Future<void> cancel() async {
    if (_target == null) return;
    _close();
    try {
      await _channel.invokeMethod<bool>('cancel');
    } catch (_) {}
  }

  /// [cancel], but only when dictation is running into [controller].
  Future<void> cancelFor(TextEditingController controller) async {
    // A failure reported on a field that is going away must not keep it alive.
    if (identical(_errorTarget, controller)) {
      _error = null;
      _errorTarget = null;
      // Without this the error row stays drawn, and its Dismiss then does
      // nothing because there is no error left to clear (#292 re-review).
      if (!isListeningTo(controller)) notifyListeners();
    }
    if (isListeningTo(controller)) await cancel();
  }

  /// Next language in [kDictationLanguages], remembered for next time. Takes
  /// effect at once when dictation is running.
  Future<void> nextLanguage() async {
    await _loadLanguage();
    final i = kDictationLanguages.indexOf(_language);
    _language = kDictationLanguages[(i + 1) % kDictationLanguages.length];
    notifyListeners();
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(languageKey, _language.tag);
    } catch (_) {}
    if (_target != null) {
      _merge?.commitPartial();
      try {
        await _channel.invokeMethod<bool>('language', {'language': _language.tag});
      } catch (_) {}
    }
  }

  void _onEvent(dynamic raw) {
    if (raw is! Map) return;
    if (_target == null || raw['session'] != _session) return;
    final type = raw['type'];
    switch (type) {
      case 'partial':
      case 'final':
        final merge = _merge;
        final target = _target;
        if (merge == null || target == null) return;
        // The user typed, or something else rewrote the field: their edit wins,
        // and a report about words they have already changed is dropped.
        // TEXT only: selection and composing are whatever focus loss left
        // behind, and comparing them cancelled on device-specific noise.
        if (target.text != _written) {
          cancel();
          return;
        }
        final text = (raw['text'] as String?) ?? '';
        // A heard word proves the mic is open, even from a service that never
        // reported ready.
        if (!_ready && text.trim().isNotEmpty) {
          _ready = true;
          notifyListeners();
        }
        if (type == 'partial') {
          merge.onPartial(text);
        } else {
          merge.onFinal(text);
        }
        final next = merge.render();
        _written = next.text;
        target.value = next;
      case 'ready':
        if (!_ready) {
          _ready = true;
          notifyListeners();
        }
      case 'state':
        if (raw['listening'] == false && _target != null) {
          _close();
        }
      case 'error':
        _fail((raw['code'] ?? '?').toString());
    }
  }

  void _fail(String code) {
    final target = _target;
    _close(notify: false);
    _error = dictationErrorMessage(code, _language);
    _errorTarget = target;
    notifyListeners();
  }

  void _close({bool notify = true}) {
    _target = null;
    _merge = null;
    _written = null;
    if (notify) notifyListeners();
  }
}
