package net.hilashnet.ai_terminal

import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsAnimation

// --- #400: the keyboard's height outliving the keyboard ------------------------
// A Flutter ENGINE bug (flutter/flutter#191156, open; Flutter 3.44.4 and 3.47.0),
// worked around here because no SDK release fixes it.
//
// The engine's ImeSyncDeferringInsetsCallback caches the window insets only
// between an IME animation's onPrepare and the next inset delivery, and
// re-dispatches that cache unconditionally in onEnd. Background the app while
// the keyboard is still animating and the cache holds a keyboard-visible
// snapshot; on resume Android reports `ime:null` (forwarded once), then the hide
// the app issues is cancelled at once - onPrepare, onEnd, no delivery between -
// so onEnd re-applies the stale keyboard height. Android sees no further change,
// so every Scaffold stays short by the keyboard until the app is relaunched.
// Measured on Android 17: Home 50 ms after focusing the compose bar.
//
// The repair: watch IME animations from the FlutterView's PARENT and, once one
// ends, ask the platform to dispatch its current insets again. The parent's onEnd
// runs BEFORE the engine's (a parent dispatches to itself, then its subtree), so
// the request is posted to run after the engine has written whatever it writes.
// When the engine was right the same metrics arrive again and no widget that
// depends on them rebuilds.
// Delete this file once the engine fix ships in the SDK we build with.
internal class ImeInsetRepair private constructor(private val flutterView: View) :
    WindowInsetsAnimation.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {

    override fun onProgress(
        insets: WindowInsets,
        runningAnimations: MutableList<WindowInsetsAnimation>,
    ): WindowInsets = insets

    override fun onEnd(animation: WindowInsetsAnimation) {
        if (animation.typeMask and WindowInsets.Type.ime() == 0) return
        // A fresh dispatch down the NORMAL path, not the root insets handed over
        // directly: below API 35 (no enforced edge-to-edge) the DecorView consumes
        // the navigation bar before the FlutterView sees any inset, the keyboard's
        // included, and only the normal path applies that correction. By the time
        // this runs the engine's onEnd has cleared its `animating` flag, so its
        // listener passes the fresh insets straight through.
        flutterView.post { flutterView.requestApplyInsets() }
    }

    companion object {
        // The engine installs its deferring callback only from API 30 (R), so
        // below that there is nothing to repair.
        fun install(flutterView: View) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
            val parent = flutterView.parent as? View ?: return
            parent.setWindowInsetsAnimationCallback(ImeInsetRepair(flutterView))
        }
    }
}
