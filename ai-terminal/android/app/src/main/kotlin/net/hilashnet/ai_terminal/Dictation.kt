package net.hilashnet.ai_terminal

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import io.flutter.plugin.common.EventChannel

// --- #291: dictate into the compose bar without opening the keyboard ----------
// The keyboard's own mic already dictates, but only from inside a keyboard that
// takes ~330 dp of the screen. This is the same recognizer the keyboard mic
// reaches (Android's SpeechRecognizer, i.e. the device's speech service), so
// recognition quality and where the audio goes are unchanged from today - only
// the button moves. #70 dropped building our OWN speech-to-text; this builds none.
//
// Kotlin under android/ only, for the same reason as read-aloud (MainActivity.kt):
// a Flutter plugin would reach the Windows desktop build, which this cannot.
//
// CONTINUOUS until the user stops it: SpeechRecognizer ends a session at the
// first pause, so every end-of-utterance (a result, or a no-match / silence
// timeout) starts the next session while [active] is set. Text is reported as
// events; what to DO with it (where it lands in the field) is decided in Dart
// (lib/services/dictation_service.dart), which is unit-testable off-device.
class Dictation(private val activity: Activity) : EventChannel.StreamHandler {
    private var sink: EventChannel.EventSink? = null
    private var recognizer: SpeechRecognizer? = null
    private val handler = Handler(Looper.getMainLooper())

    /** The user wants to be listened to. Cleared only by stop/cancel or a hard error. */
    private var active = false
    private var language = "en-US"
    private var awaitingPermission = false

    /**
     * Chosen by Dart per start and echoed on every event, so a late report from
     * a session the user already ended (stop, then a quick restart) can never
     * act on the new one.
     */
    private var session = 0

    /** Consecutive restarts that produced nothing; bounds a recognizer that keeps failing. */
    private var failures = 0

    /** Punctuation/capitalisation request (API 33+). Dropped if the service rejects it. */
    private var formatting = Build.VERSION.SDK_INT >= 33
    private var heardSomething = false

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { sink = events }
    override fun onCancel(arguments: Any?) { sink = null }

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(activity)

    fun start(lang: String, sessionId: Int) {
        // A new session supersedes whatever was running.
        handler.removeCallbacksAndMessages(null)
        recognizer?.cancel()
        session = sessionId
        language = lang
        if (!available()) {
            emitError("unavailable")
            return
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            awaitingPermission = true
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST)
            return
        }
        active = true
        failures = 0
        heardSomething = false
        emitState(true)
        listen()
    }

    /**
     * Switch language mid-dictation. The utterance in flight is abandoned (Dart
     * keeps what it already showed as partial text) and listening resumes in the
     * new language.
     */
    fun setLanguage(lang: String) {
        language = lang
        if (active) {
            handler.removeCallbacksAndMessages(null)
            recognizer?.cancel()
            relisten()
        }
    }

    /** Stop and FLUSH: the utterance in flight still delivers its final text. */
    fun stop() {
        if (!active) return
        active = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.stopListening()
        // A recognizer that never answers must not leave the button stuck on.
        handler.postDelayed({ emitState(false) }, 1500)
    }

    /**
     * Stop and DISCARD (send, leaving the screen, typing). Reports nothing: Dart
     * has already closed its side before asking.
     */
    fun cancel() {
        active = false
        awaitingPermission = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.cancel()
    }

    fun destroy() {
        cancel()
        recognizer?.destroy()
        recognizer = null
    }

    fun onPermissionResult(requestCode: Int, granted: Boolean): Boolean {
        if (requestCode != PERMISSION_REQUEST) return false
        val wanted = awaitingPermission
        awaitingPermission = false
        if (!wanted) return true
        if (granted) start(language, session) else emitError("permission")
        return true
    }

    private fun listen() {
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(activity).also {
            it.setRecognitionListener(listener)
            recognizer = it
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            if (formatting && Build.VERSION.SDK_INT >= 33) {
                putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY)
            }
        }
        r.startListening(intent)
    }

    /** Next session after a pause. The delay avoids ERROR_RECOGNIZER_BUSY on a back-to-back start. */
    private fun relisten(delayMs: Long = RESTART_DELAY_MS, recreate: Boolean = false) {
        handler.postDelayed({
            if (!active) return@postDelayed
            if (recreate) {
                recognizer?.destroy()
                recognizer = null
            }
            listen()
        }, delayMs)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults) ?: return
            heardSomething = true
            failures = 0
            emit(mapOf("type" to "partial", "text" to text))
        }

        override fun onResults(results: Bundle?) {
            val text = firstResult(results)
            if (!text.isNullOrBlank()) {
                heardSomething = true
                failures = 0
                emit(mapOf("type" to "final", "text" to text))
            }
            if (active) relisten() else emitState(false)
        }

        override fun onError(error: Int) {
            if (!active) {
                // stop() flushed and the service had nothing more to say.
                emitState(false)
                return
            }
            when (error) {
                // A pause with no words, or a silence timeout: the normal end of a
                // session in continuous dictation, not a failure.
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> relisten()
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                SpeechRecognizer.ERROR_CLIENT -> retryOrFail(error)
                else -> {
                    // A service that rejects the formatting request fails before it
                    // has produced anything. Retry once without it before giving up.
                    if (formatting && !heardSomething) {
                        formatting = false
                        relisten(recreate = true)
                    } else {
                        fail(error)
                    }
                }
            }
        }
    }

    private fun retryOrFail(error: Int) {
        failures += 1
        if (failures > MAX_RETRIES) fail(error) else relisten(delayMs = 300L * failures, recreate = true)
    }

    private fun fail(error: Int) {
        active = false
        handler.removeCallbacksAndMessages(null)
        emitError(error.toString())
    }

    private fun firstResult(b: Bundle?): String? =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun emitState(listening: Boolean) {
        handler.removeCallbacksAndMessages(null)
        emit(mapOf("type" to "state", "listening" to listening))
    }

    private fun emitError(code: String) {
        emit(mapOf("type" to "error", "code" to code))
        emit(mapOf("type" to "state", "listening" to false))
    }

    private fun emit(event: Map<String, Any?>) {
        sink?.success(event + ("session" to session))
    }

    companion object {
        const val PERMISSION_REQUEST = 2910
        private const val RESTART_DELAY_MS = 150L
        private const val MAX_RETRIES = 3
    }
}
