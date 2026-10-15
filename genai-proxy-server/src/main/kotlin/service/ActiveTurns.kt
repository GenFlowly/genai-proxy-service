package com.genflowly.service

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * Process-wide registry of in-flight generation turns, by the customer who
 * sent them. The account purge (plan 3.9 step 5) cancels a deleted customer's
 * turns and waits until each has stored what it stores before it builds the
 * set of objects to keep: a turn writes its assistant message only when its
 * stream ends. Production runs one proxy machine, so tracking turns in memory
 * sees every one of them. Bound as a Koin singleton.
 */
class ActiveTurns {

    private class Turn(val customerId: String, val conversationId: String, val job: Job)

    private val turns: MutableSet<Turn> = ConcurrentHashMap.newKeySet()

    /**
     * Registers [job] as a turn of [customerId] in [conversationId]. Close the
     * returned handle once the turn's persistence is done; the turn also leaves
     * the registry when [job] completes, so a job cancelled before it ever ran
     * cannot stay registered.
     */
    fun register(customerId: String, conversationId: String, job: Job): AutoCloseable {
        val turn = Turn(customerId, conversationId, job)
        turns.add(turn)
        job.invokeOnCompletion { turns.remove(turn) }
        return AutoCloseable { turns.remove(turn) }
    }

    /** How many turns of [customerId] are registered now. */
    fun activeCount(customerId: String): Int = turns.count { it.customerId == customerId }

    /**
     * Cancels every registered turn of [customerId] and waits, for at most
     * [timeoutMs], until each has finished, persistence included: a cancelled
     * streamed turn still stores what it streamed. Returns how many turns it
     * cancelled. A turn still running when the wait times out stays
     * registered, so activeCount(customerId) > 0 afterwards means it did.
     */
    suspend fun cancelAndAwait(customerId: String, timeoutMs: Long): Int {
        val cancelled = turns.filter { it.customerId == customerId }
        cancelled.forEach { it.job.cancel(CancellationException("The customer's account is being deleted")) }
        withTimeoutOrNull(timeoutMs) { cancelled.forEach { it.job.join() } }
        return cancelled.size
    }
}
