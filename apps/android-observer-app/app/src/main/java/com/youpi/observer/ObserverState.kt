package com.youpi.observer

/**
 * Outcome of the most recent signed heartbeat.
 *
 * Held in memory only: it describes the current connection, not a credential,
 * and must never be persisted or logged with request details.
 */
enum class HeartbeatOutcome {
    /** Paired and listener enabled, but no heartbeat has completed yet. */
    PENDING,
    OK,
    /** The gateway rejected our device signature (revoked/invalid device). */
    UNAUTHORIZED,
    SERVER_ERROR,
    NETWORK_ERROR
}

/**
 * The four states the setup screen is allowed to display.
 *
 * ACTIVE is only ever shown when this phone is paired AND Android has granted
 * notification-listener access. A paired phone with the listener switched off
 * is PAIRED / NOT LISTENING, never "CONNECTED".
 */
enum class ObserverState(val label: String) {
    NOT_PAIRED("NOT PAIRED"),
    PAIRED_NOT_LISTENING("PAIRED / NOT LISTENING"),
    ACTIVE("ACTIVE"),
    ERROR("ERROR")
}

data class ObserverStatus(val state: ObserverState, val detail: String)

object ObserverStateResolver {
    /**
     * Derives the displayed state from the three facts the app can actually
     * verify locally. Precedence matters:
     *  1. not paired             -> NOT PAIRED
     *  2. device rejected (401)  -> ERROR (re-pair required even if the listener is off)
     *  3. listener not granted   -> PAIRED / NOT LISTENING
     *  4. gateway unreachable    -> ERROR
     *  5. otherwise              -> ACTIVE
     */
    fun resolve(
        paired: Boolean,
        listenerEnabled: Boolean,
        heartbeat: HeartbeatOutcome
    ): ObserverStatus {
        if (!paired) {
            return ObserverStatus(
                ObserverState.NOT_PAIRED,
                "This phone is not paired. Pair it with the merchant gateway below."
            )
        }

        if (heartbeat == HeartbeatOutcome.UNAUTHORIZED) {
            return ObserverStatus(
                ObserverState.ERROR,
                "The gateway rejected this device. Re-pair with a fresh enrollment token."
            )
        }

        if (!listenerEnabled) {
            return ObserverStatus(
                ObserverState.PAIRED_NOT_LISTENING,
                "Paired, but Android notification access is off. No payments can be observed."
            )
        }

        if (heartbeat == HeartbeatOutcome.NETWORK_ERROR) {
            return ObserverStatus(
                ObserverState.ERROR,
                "Cannot reach the gateway. Check the URL and this phone's connection."
            )
        }

        if (heartbeat == HeartbeatOutcome.SERVER_ERROR) {
            return ObserverStatus(
                ObserverState.ERROR,
                "The gateway returned an error to the last heartbeat. Retry shortly or re-pair."
            )
        }

        val detail = if (heartbeat == HeartbeatOutcome.OK) {
            "Listening for bank and UPI credit notifications. Gateway heartbeats are acknowledged."
        } else {
            "Listening for bank and UPI credit notifications. Waiting for the first gateway heartbeat."
        }
        return ObserverStatus(ObserverState.ACTIVE, detail)
    }
}

/**
 * Process-wide, non-sensitive runtime status shared by the activity, the
 * heartbeat scheduler and the foreground service. It resets naturally when the
 * process restarts, so a stale "ACTIVE" can never survive an app restart.
 */
object ObserverRuntime {
    @Volatile
    var lastHeartbeat: HeartbeatOutcome = HeartbeatOutcome.PENDING
        private set

    @Volatile
    var lastHeartbeatAtMillis: Long = 0L
        private set

    @Volatile
    var lastHeartbeatSuccessAtMillis: Long = 0L
        private set

    fun recordHeartbeat(outcome: HeartbeatOutcome, atMillis: Long = System.currentTimeMillis()) {
        lastHeartbeat = outcome
        lastHeartbeatAtMillis = atMillis
        if (outcome == HeartbeatOutcome.OK) {
            lastHeartbeatSuccessAtMillis = atMillis
        }
    }

    fun reset() {
        lastHeartbeat = HeartbeatOutcome.PENDING
        lastHeartbeatAtMillis = 0L
        lastHeartbeatSuccessAtMillis = 0L
    }
}
