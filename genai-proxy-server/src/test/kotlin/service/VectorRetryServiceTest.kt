package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.providers.VectorEncodeException
import com.genflowly.repository.PendingVectorItem
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The vector retry sweep: a due row is claimed before it runs, a stored (or
 * vanished) record's row is deleted, a failure leaves the row for the next
 * backed-off attempt, and permanent failures or the attempts cap stop
 * retrying while keeping the row (so the record stays keyword-findable).
 */
class VectorRetryServiceTest {

    private val pending = mockk<VectorSyncPendingRepository>(relaxed = true)
    private val conversations = mockk<ConversationIndexingService>()
    private val memories = mockk<MemoryExtractionService>()
    private val service = VectorRetryService(pending, conversations, memories, AppScope())

    private val exchange = PendingVectorItem(
        customerId = "CU1", type = PendingVectorType.CONVERSATION, key = "MSG2",
        conversationId = "CONV1", pendingSince = "t0", attempts = 0, dueAt = "t1"
    )
    private val memory = exchange.copy(type = PendingVectorType.MEMORY, key = "MEM#a", conversationId = null)

    private fun due(item: PendingVectorItem, attempt: Int?) {
        coEvery { pending.dueRetries(any(), any()) } returns listOf(item)
        coEvery { pending.startAttempt(item, any()) } returns attempt
    }

    @Test
    fun `a stored exchange drops its row`() = runTest {
        due(exchange, attempt = 1)
        coEvery { conversations.retryExchange("CU1", "CONV1", "MSG2") } returns true

        service.processDueRetries()

        coVerify { pending.clear("CU1", PendingVectorType.CONVERSATION, "MSG2") }
        coVerify(exactly = 0) { pending.stopRetrying(any()) }
    }

    @Test
    fun `a record that no longer exists drops its row`() = runTest {
        due(memory, attempt = 1)
        coEvery { memories.retryMemoryVector("CU1", "MEM#a") } returns false

        service.processDueRetries()

        coVerify { pending.clear("CU1", PendingVectorType.MEMORY, "MEM#a") }
    }

    @Test
    fun `a failed retry keeps the row for the next attempt`() = runTest {
        due(memory, attempt = 3)
        coEvery { memories.retryMemoryVector(any(), any()) } throws VectorEncodeException(500, "zilliz down")

        service.processDueRetries()

        coVerify(exactly = 0) { pending.clear(any(), any(), any()) }
        coVerify(exactly = 0) { pending.stopRetrying(any()) }
    }

    @Test
    fun `a permanent failure stops retrying but keeps the row`() = runTest {
        due(exchange, attempt = 1)
        coEvery { conversations.retryExchange(any(), any(), any()) } throws VectorEncodeException(409, "No vector DB")

        service.processDueRetries()

        coVerify { pending.stopRetrying(exchange) }
        coVerify(exactly = 0) { pending.clear(any(), any(), any()) }
    }

    @Test
    fun `the last attempt's failure stops retrying`() = runTest {
        due(exchange, attempt = VectorRetryService.MAX_ATTEMPTS)
        coEvery { conversations.retryExchange(any(), any(), any()) } throws IllegalStateException("timeout")

        service.processDueRetries()

        coVerify { pending.stopRetrying(exchange) }
    }

    @Test
    fun `a row claimed or stored meanwhile is skipped`() = runTest {
        due(exchange, attempt = null)

        service.processDueRetries()

        coVerify(exactly = 0) { conversations.retryExchange(any(), any(), any()) }
    }

    @Test
    fun `the next attempt is pushed out by the backoff`() = runTest {
        due(exchange.copy(attempts = 2), attempt = 3)
        coEvery { conversations.retryExchange(any(), any(), any()) } returns true

        service.processDueRetries()

        coVerify { pending.startAttempt(any(), 1800L) }
    }

    @Test
    fun `backoff is 1 min, 5 min, 30 min, then 2 h`() {
        assertEquals(listOf(60L, 300L, 1800L, 7200L, 7200L), (1..5).map(VectorRetryService::retryDelaySeconds))
    }
}
