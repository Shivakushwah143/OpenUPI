package com.youpi.observer

import android.content.Context
import android.os.Handler
import android.os.Looper

class HeartbeatScheduler(private val context: Context) {
    private val apiClient = ApiClient(context)
    private val handler = Handler(Looper.getMainLooper())
    private var isRunning = false

    private val runnable = object : Runnable {
        override fun run() {
            if (!isRunning) return
            Thread {
                // null means "not paired"; keep the last known status untouched.
                val outcome = apiClient.sendHeartbeat()
                if (outcome != null) {
                    ObserverRuntime.recordHeartbeat(outcome)
                }
            }.start()
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }

    fun start() {
        if (isRunning) return
        isRunning = true
        handler.post(runnable)
    }

    fun stop() {
        isRunning = false
        handler.removeCallbacks(runnable)
    }

    companion object {
        const val HEARTBEAT_INTERVAL_MS = 60_000L
    }
}
