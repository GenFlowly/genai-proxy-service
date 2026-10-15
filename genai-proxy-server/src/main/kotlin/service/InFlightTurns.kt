package com.genflowly.service

/**
 * The customer's generation turns running in this process (the proxy runs on
 * one machine, so this is all of them). Account deletion (plan 3.9 step 5)
 * cancels them and waits until each has ended and persisted what it
 * persists, before it builds the keep set and sweeps the customer's prefix.
 *
 * The real implementation tracks turns per customerId (service/ActiveTurns.kt,
 * added separately); until it is bound, [NoopInFlightTurns] stands in.
 */
interface InFlightTurns {
    /**
     * Cancels every in-flight turn of [customerId] and waits up to
     * [timeoutMs] for them to finish persisting. Returns how many were
     * cancelled.
     */
    suspend fun cancelAndAwait(customerId: String, timeoutMs: Long): Int
}

/** Default binding: knows of no turns. */
object NoopInFlightTurns : InFlightTurns {
    override suspend fun cancelAndAwait(customerId: String, timeoutMs: Long): Int = 0
}
