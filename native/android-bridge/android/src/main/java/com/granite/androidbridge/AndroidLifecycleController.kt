package com.granite.androidbridge

import android.app.Activity
import android.content.Context
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

internal class AndroidLifecycleController(private val activity: Activity) {
    private val preferences = activity.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private var keepAwakeRequested = preferences.getBoolean(KEY_KEEP_AWAKE, false)
    private var immersiveRequested = preferences.getBoolean(KEY_IMMERSIVE, false)
    @Volatile
    var backEnabled: Boolean = false
        private set

    init {
        activity.runOnUiThread { applyCurrentState() }
    }

    fun setKeepAwake(enabled: Boolean): Boolean {
        activity.runOnUiThread {
            keepAwakeRequested = enabled
            preferences.edit().putBoolean(KEY_KEEP_AWAKE, enabled).apply()
            applyKeepAwake()
        }
        return enabled
    }

    fun setImmersive(enabled: Boolean): Boolean {
        activity.runOnUiThread {
            immersiveRequested = enabled
            preferences.edit().putBoolean(KEY_IMMERSIVE, enabled).apply()
            applyImmersive()
        }
        return enabled
    }

    fun setBackEnabled(enabled: Boolean): Boolean {
        activity.runOnUiThread {
            backEnabled = enabled
            preferences.edit().putBoolean(KEY_BACK_ENABLED, enabled).apply()
        }
        return enabled
    }

    fun restoreBackEnabled(): Boolean {
        backEnabled = preferences.getBoolean(KEY_BACK_ENABLED, false)
        return backEnabled
    }

    fun onResume() {
        activity.runOnUiThread {
            applyCurrentState()
        }
    }

    fun onDestroy() {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun applyCurrentState() {
        applyKeepAwake()
        applyImmersive()
    }

    private fun applyKeepAwake() {
        if (keepAwakeRequested) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun applyImmersive() {
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        WindowCompat.setDecorFitsSystemWindows(activity.window, !immersiveRequested)
        if (immersiveRequested) {
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    companion object {
        private const val PREFERENCES_NAME = "granite.android-bridge.lifecycle"
        private const val KEY_KEEP_AWAKE = "keepAwake"
        private const val KEY_IMMERSIVE = "immersive"
        private const val KEY_BACK_ENABLED = "backEnabled"
    }
}
