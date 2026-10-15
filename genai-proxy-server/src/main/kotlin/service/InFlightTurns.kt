package com.genflowly.service

/**
 * The customer's generation turns running in this process (the proxy runs on
 * one machine, so this is all of them). Account deletion (plan 3.9 step 5)
 * cancels them and waits until each has ended and persisted what it
 * persists, before it builds the keep set and sweeps the customer's prefix.
 *
 * Bound to [ActiveTurns], which tracks every streamed and non-streamed turn
 * per customerId; [NoopInFlightTurns] is for tests that need no turns.
 */
interface InFlightTurns {
    /**
     * Cancels every in-flight turn of [customerId] and waits up to
     * [timeoutMs] for them to finish persisting. Returns how many were
     * cancelled.
     */
    suspend fun cancelAndAwait(customerId: String, timeoutMs: Long): Int
}

/** Knows of no turns (tests). */
object NoopInFlightTurns : InFlightTurns {
    override suspend fun cancelAndAwait(customerId: String, timeoutMs: Long): Int = 0
}
