package net.hilashnet.ai_terminal

import android.speech.tts.TextToSpeech
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.util.Locale

// --- #70 Phase 1 (companion): read-aloud on Android ---------------------------
// Speech is driven through a hand-rolled MethodChannel onto Android's own
// TextToSpeech rather than the `flutter_tts` package. That is deliberate: this
// project already REMOVED flutter_tts once because its Windows build needs
// nuget.exe (see pubspec.yaml), and the companion still ships a Windows desktop
// build. Kotlin here lives under android/ only, so the desktop build cannot be
// affected by it — the constraint is designed out rather than worked around.
//
// The engine is owned by the Activity and shut down with it. Nothing is
// synthesised off-device: this is the phone's own offline TTS.
class MainActivity : FlutterActivity() {
    private var tts: TextToSpeech? = null
    private var ready = false

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // TextToSpeech initialises ASYNCHRONOUSLY. `ready` stays false until the
        // engine calls back, so an early `speak` correctly reports failure rather
        // than silently dropping the utterance.
        tts = TextToSpeech(applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            // English only — a decided scope constraint (#70), and it keeps the
            // voice in its best-accuracy configuration.
            if (ready) tts?.language = Locale.US
        }

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "available" -> result.success(ready)
                    "speaking" -> result.success(ready && tts?.isSpeaking == true)
                    "speak" -> {
                        val text = call.argument<String>("text").orEmpty()
                        if (!ready || text.isBlank()) {
                            result.success(false)
                        } else {
                            // Pace is the single biggest listenability lever, and
                            // the right value is personal — so it is a setting,
                            // applied per utterance rather than fixed at init.
                            val rate = (call.argument<Double>("rate") ?: 1.0).toFloat()
                            tts?.setSpeechRate(rate.coerceIn(0.5f, 2.5f))
                            val pitch = (call.argument<Double>("pitch") ?: 1.0).toFloat()
                            tts?.setPitch(pitch.coerceIn(0.5f, 2.0f))
                            // QUEUE_FLUSH: pressing read again replaces what is
                            // playing. Queueing would stack minutes of stale
                            // answers behind the one the user actually wants.
                            tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE_ID)
                            result.success(true)
                        }
                    }
                    "stop" -> { tts?.stop(); result.success(true) }
                    else -> result.notImplemented()
                }
            }
    }

    override fun onDestroy() {
        // Without this the voice keeps talking after the app is gone.
        tts?.stop()
        tts?.shutdown()
        tts = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "wt/speech"
        private const val UTTERANCE_ID = "wt-read-aloud"
    }
}
