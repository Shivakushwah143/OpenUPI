package com.youpi.observer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * State-transition contract for the setup screen. These tests run on the JVM
 * (no device or emulator) because the resolver is a pure function.
 */
class ObserverStateTest {

    private fun resolve(
        paired: Boolean = true,
        listenerEnabled: Boolean = true,
        heartbeat: HeartbeatOutcome = HeartbeatOutcome.PENDING
    ) = ObserverStateResolver.resolve(paired, listenerEnabled, heartbeat)

    @Test
    fun `unpaired phone is NOT PAIRED even if the listener is enabled`() {
        val status = resolve(paired = false, listenerEnabled = true, heartbeat = HeartbeatOutcome.OK)
        assertEquals(ObserverState.NOT_PAIRED, status.state)
        assertTrue(status.detail.isNotBlank())
    }

    @Test
    fun `paired phone with listener disabled is PAIRED but NOT LISTENING`() {
        val status = resolve(listenerEnabled = false, heartbeat = HeartbeatOutcome.OK)
        assertEquals(ObserverState.PAIRED_NOT_LISTENING, status.state)
    }

    @Test
    fun `paired phone with listener enabled is ACTIVE regardless of prior heartbeat`() {
        // Guard against the original bug: the UI used to show CONNECTED even with
        // the listener off. With the listener on, ACTIVE is correct.
        assertEquals(ObserverState.ACTIVE, resolve(heartbeat = HeartbeatOutcome.PENDING).state)
        assertEquals(ObserverState.ACTIVE, resolve(heartbeat = HeartbeatOutcome.OK).state)
    }

    @Test
    fun `listener toggling off immediately degrades ACTIVE to PAIRED NOT LISTENING`() {
        assertEquals(ObserverState.ACTIVE, resolve(listenerEnabled = true, heartbeat = HeartbeatOutcome.OK).state)
        assertEquals(
            ObserverState.PAIRED_NOT_LISTENING,
            resolve(listenerEnabled = false, heartbeat = HeartbeatOutcome.OK).state
        )
    }

    @Test
    fun `rejected device signature is ERROR even when the listener is off`() {
        assertEquals(
            ObserverState.ERROR,
            resolve(listenerEnabled = true, heartbeat = HeartbeatOutcome.UNAUTHORIZED).state
        )
        assertEquals(
            ObserverState.ERROR,
            resolve(listenerEnabled = false, heartbeat = HeartbeatOutcome.UNAUTHORIZED).state
        )
    }

    @Test
    fun `unreachable gateway with listener enabled is ERROR`() {
        assertEquals(
            ObserverState.ERROR,
            resolve(listenerEnabled = true, heartbeat = HeartbeatOutcome.NETWORK_ERROR).state
        )
    }

    @Test
    fun `unreachable gateway with listener disabled reports the permission problem first`() {
        assertEquals(
            ObserverState.PAIRED_NOT_LISTENING,
            resolve(listenerEnabled = false, heartbeat = HeartbeatOutcome.NETWORK_ERROR).state
        )
    }

    @Test
    fun `gateway server error is ERROR`() {
        assertEquals(
            ObserverState.ERROR,
            resolve(listenerEnabled = true, heartbeat = HeartbeatOutcome.SERVER_ERROR).state
        )
    }

    @Test
    fun `heartbeat runtime starts pending and records outcomes`() {
        ObserverRuntime.reset()
        assertEquals(HeartbeatOutcome.PENDING, ObserverRuntime.lastHeartbeat)
        assertEquals(0L, ObserverRuntime.lastHeartbeatAtMillis)

        ObserverRuntime.recordHeartbeat(HeartbeatOutcome.OK, atMillis = 1_000L)
        assertEquals(HeartbeatOutcome.OK, ObserverRuntime.lastHeartbeat)
        assertEquals(1_000L, ObserverRuntime.lastHeartbeatAtMillis)
        assertEquals(1_000L, ObserverRuntime.lastHeartbeatSuccessAtMillis)

        ObserverRuntime.recordHeartbeat(HeartbeatOutcome.NETWORK_ERROR, atMillis = 2_000L)
        assertEquals(HeartbeatOutcome.NETWORK_ERROR, ObserverRuntime.lastHeartbeat)
        assertEquals(2_000L, ObserverRuntime.lastHeartbeatAtMillis)
        // The last successful contact is retained for diagnostics.
        assertEquals(1_000L, ObserverRuntime.lastHeartbeatSuccessAtMillis)

        ObserverRuntime.reset()
        assertEquals(HeartbeatOutcome.PENDING, ObserverRuntime.lastHeartbeat)
        assertEquals(0L, ObserverRuntime.lastHeartbeatSuccessAtMillis)
    }
}
