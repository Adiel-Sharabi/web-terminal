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
// timeout) starts the next RUN while [active] is set. Text is reported as
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
     * Chosen by Dart per start and echoed on every event, so Dart can tell which
     * of ITS sessions a report belongs to.
     */
    private var session = 0

    /**
     * Numbers every startListening. Each run gets its own listener that knows its
     * number and goes silent once a newer run exists. Stamping events with
     * [session] at emit time was not enough: a result the binder had already
     * queued for a cancelled run (a stop, a language switch, a quick restart)
     * would be emitted under the NEW session and append words twice (#292 review).
     */
    private var run = 0

    /** Consecutive restarts that produced nothing; bounds a recognizer that keeps failing. */
    private var failures = 0

    /** Punctuation/capitalisation request (API 33+). Dropped for one start if the service rejects it. */
    private var formatting = FORMATTING_SUPPORTED
    private var heardSomething = false

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { sink = events }
    override fun onCancel(arguments: Any?) { sink = null }

    fun available(): Boolean = SpeechRecognizer.isRecognitionAvailable(activity)

    fun start(lang: String, sessionId: Int) {
        // A new session supersedes whatever was running.
        supersede()
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
        // One offline attempt must not cost punctuation for the rest of the day.
        formatting = FORMATTING_SUPPORTED
        listen()
    }

    /**
     * Switch language mid-dictation. The run in flight is abandoned (Dart keeps
     * what it already showed as partial text) and listening resumes in the new
     * language.
     */
    fun setLanguage(lang: String) {
        language = lang
        if (active) {
            supersede()
            relisten()
        }
    }

    /** Stop and FLUSH: the run in flight still delivers its final text. */
    fun stop() {
        if (!active) {
            // Stopped while the permission prompt is up: nothing is listening,
            // but Dart is still waiting to hear that.
            if (awaitingPermission) {
                awaitingPermission = false
                emitState(false)
            }
            return
        }
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
        supersede()
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

    /** End the current run so nothing it still has queued can speak. */
    private fun supersede() {
        handler.removeCallbacksAndMessages(null)
        run += 1
        recognizer?.cancel()
    }

    private fun listen() {
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(activity).also {
            recognizer = it
        }
        run += 1
        r.setRecognitionListener(RunListener(run))
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

    /** Next run after a pause. The delay avoids ERROR_RECOGNIZER_BUSY on a back-to-back start. */
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

    /** One run's callbacks. Silent the moment a newer run (or a cancel) exists. */
    private inner class RunListener(private val id: Int) : RecognitionListener {
        private val current get() = id == run

        override fun onReadyForSpeech(params: Bundle?) {
            // The mic is actually open now. Dart shows "Listening" from here, not
            // from the tap: words spoken before this are not heard.
            if (current && active) emit(mapOf("type" to "ready"))
        }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            if (!current) return
            // Some services send a blank partial at speech onset; it is not words.
            val text = firstResult(partialResults)
            if (text.isNullOrBlank()) return
            heardSomething = true
            failures = 0
            emit(mapOf("type" to "partial", "text" to text))
        }

        override fun onResults(results: Bundle?) {
            if (!current) return
            val text = firstResult(results)
            if (!text.isNullOrBlank()) {
                heardSomething = true
                failures = 0
                emit(mapOf("type" to "final", "text" to text))
            }
            if (active) relisten() else emitState(false)
        }

        override fun onError(error: Int) {
            if (!current) return
            if (!active) {
                // stop() flushed and the service had nothing more to say.
                emitState(false)
                return
            }
            when (error) {
                // A pause with no words, or a silence timeout: the normal end of a
                // run in continuous dictation, not a failure.
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
        if (failures > MAX_RETRIES) {
            fail(error)
        } else {
            // Silence the failing run first, so a second callback from it inside
            // the delay cannot post another recreate over the fresh recognizer.
            supersede()
            relisten(delayMs = 300L * failures, recreate = true)
        }
    }

    private fun fail(error: Int) {
        active = false
        supersede()
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
        private val FORMATTING_SUPPORTED = Build.VERSION.SDK_INT >= 33
    }
}
