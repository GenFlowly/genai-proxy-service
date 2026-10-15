package com.genflowly.service

import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** The in-flight turn registry the account purge cancels and awaits (3.9 step 5). */
class ActiveTurnsTest {

    private val turns = ActiveTurns()

    @Test
    fun `a turn counts while registered and stops counting once closed`() {
        val handle = turns.register("cust-1", "conv-1", Job())

        assertEquals(1, turns.activeCount("cust-1"))
        assertEquals(0, turns.activeCount("cust-2"))
        handle.close()
        assertEquals(0, turns.activeCount("cust-1"))
        handle.close() // closing twice is harmless
    }

    @Test
    fun `a turn whose job completes leaves the registry even if never closed`() {
        val job = Job()
        turns.register("cust-1", "conv-1", job)

        job.cancel()

        assertEquals(0, turns.activeCount("cust-1"))
    }

    @Test
    fun `cancelAndAwait cancels the customer's turns and waits for their persistence`() = runTest {
        val persisted = mutableListOf<String>()
        fun turn(customerId: String, conversationId: String) {
            lateinit var handle: AutoCloseable
            val job = launch {
                try {
                    awaitCancellation()
                } finally {
                    withContext(NonCancellable) {
                        delay(1_000) // storing the partial message
                        persisted += conversationId
                        handle.close()
                    }
                }
            }
            handle = turns.register(customerId, conversationId, job)
        }
        turn("cust-1", "conv-a")
        turn("cust-1", "conv-b")
        turn("cust-2", "conv-c")
        runCurrent() // every turn is running

        val cancelled = turns.cancelAndAwait("cust-1", timeoutMs = 60_000)

        assertEquals(2, cancelled)
        assertEquals(setOf("conv-a", "conv-b"), persisted.toSet(), "both stored before cancelAndAwait returned")
        assertEquals(0, turns.activeCount("cust-1"))
        assertEquals(1, turns.activeCount("cust-2"), "another customer's turn is untouched")
        turns.cancelAndAwait("cust-2", timeoutMs = 60_000)
    }

    @Test
    fun `a turn still persisting at the timeout stays registered`() = runTest {
        lateinit var handle: AutoCloseable
        val job = launch {
            try {
                awaitCancellation()
            } finally {
                withContext(NonCancellable) {
                    delay(10_000)
                    handle.close()
                }
            }
        }
        handle = turns.register("cust-1", "conv-1", job)
        delay(1)

        assertEquals(1, turns.cancelAndAwait("cust-1", timeoutMs = 500))
        assertEquals(1, turns.activeCount("cust-1"), "activeCount tells the caller the wait timed out")
        assertTrue(job.isCancelled)
        job.join()
        assertEquals(0, turns.activeCount("cust-1"))
    }

    @Test
    fun `a customer without turns returns at once`() = runTest {
        assertEquals(0, turns.cancelAndAwait("nobody", timeoutMs = 1_000))
        assertFalse(turns.activeCount("nobody") > 0)
    }
}
