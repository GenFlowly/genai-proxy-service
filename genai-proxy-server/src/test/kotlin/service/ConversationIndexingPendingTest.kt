package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.CustomerEntitlements
import com.genflowly.models.Message
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.VectorEncodeException
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.coVerifyOrder
import io.mockk.mockk
import java.time.Instant
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Each indexed exchange is recorded as pending (with a scheduled retry) before
 * it is sent; customers without a vector DB or an embedding key are skipped;
 * a retry rebuilds the exchange from the Message table and embeds it directly.
 */
class ConversationIndexingPendingTest {

    private val conversations = mockk<ConversationRepository>()
    private val profiles = mockk<CustomerProfileRepository>()
    private val pending = mockk<VectorSyncPendingRepository>(relaxed = true)
    private val encoding = mockk<EncodingServerClient>(relaxed = true)
    private val retrieval = mockk<RetrievalServerClient>(relaxed = true)
    private val service = ConversationIndexingService(
        conversations, mockk(relaxed = true), CustomerEntitlementService(profiles, mockk(), mockk()),
        pending, encoding, retrieval, AppScope()
    )

    private fun message(id: String, text: String, previous: String?) = Message(
        messageId = id, conversationId = "C1", text = text, client = "ios",
        role = if (previous == null) "user" else "assistant", customerId = "CU1",
        systemPrompt = "", aiConfig = emptyList(), previousMessageId = previous, createdAt = "2026-11-05T10:00:00Z"
    )

    private fun entitled(vectorDb: Boolean = true, embedding: Boolean = true) {
        coEvery { profiles.getEntitlements("CU1") } returns CustomerEntitlements(
            isVectorDbStoringEnabled = vectorDb, isEmbeddingCreationEnabled = embedding
        )
    }

    private fun index() {
        service.indexExchangeAsync("CU1", "C1", "web", "What can I deduct this year?", "A1", "token")
    }

    @Test
    fun `an exchange is recorded as pending, with a retry, before it is sent`() = runTest {
        coEvery { conversations.getMessage("C1", "A1") } returns message("A1", "Home office costs.", "U1")
        entitled()

        index()

        coVerify(timeout = 2000) { encoding.encodeConversation(any(), "token") }
        coVerifyOrder {
            pending.markPending(
                "CU1", PendingVectorType.CONVERSATION, "A1", "C1",
                match { it.isAfter(Instant.now().plusSeconds(200)) }
            )
            encoding.encodeConversation(any(), "token")
        }
    }

    @Test
    fun `customers without a vector DB are not indexed`() = runTest {
        coEvery { conversations.getMessage("C1", "A1") } returns message("A1", "Home office costs.", "U1")
        entitled(vectorDb = false)

        index()

        coVerify(timeout = 2000) { profiles.getEntitlements("CU1") }
        Thread.sleep(100)
        coVerify(exactly = 0) { pending.markPending(any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { encoding.encodeConversation(any(), any()) }
    }

    @Test
    fun `customers without an embedding key are not indexed`() = runTest {
        coEvery { conversations.getMessage("C1", "A1") } returns message("A1", "Home office costs.", "U1")
        entitled(embedding = false)

        index()

        coVerify(timeout = 2000) { profiles.getEntitlements("CU1") }
        Thread.sleep(100)
        coVerify(exactly = 0) { pending.markPending(any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { encoding.encodeConversation(any(), any()) }
    }

    @Test
    fun `entitlements that can't be read still index the exchange`() = runTest {
        coEvery { conversations.getMessage("C1", "A1") } returns message("A1", "Home office costs.", "U1")
        coEvery { profiles.getEntitlements("CU1") } throws IllegalStateException("throttled")

        index()

        coVerify(timeout = 2000) { encoding.encodeConversation(any(), "token") }
    }

    @Test
    fun `a retry rebuilds the exchange and embeds it directly`() = runTest {
        coEvery { conversations.getMessage("C1", "A1") } returns message("A1", "Home office costs.", "U1")
        coEvery { conversations.getMessage("C1", "U1") } returns message("U1", "What can I deduct?", null)
        entitled()

        assertTrue(service.retryExchange("CU1", "C1", "A1"))

        coVerify {
            retrieval.encodeConversationVector(
                "CU1", "C1", "A1",
                "User: What can I deduct?\nAssistant: Home office costs.",
                "2026-11-05T10:00:00Z", "ios", any(), any()
            )
        }
    }

    @Test
    fun `a retry of a deleted exchange reports it gone`() = runTest {
        coEvery { conversations.getMessage("C1", "A9") } returns null
        entitled()

        assertFalse(service.retryExchange("CU1", "C1", "A9"))
        coVerify(exactly = 0) { retrieval.encodeConversationVector(any(), any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a retry for a customer who can no longer index stops for good`() = runTest {
        entitled(vectorDb = false)

        val error = assertFailsWith<VectorEncodeException> { service.retryExchange("CU1", "C1", "A1") }

        assertTrue(error.permanent)
        coVerify(exactly = 0) { conversations.getMessage(any(), any()) }
        coVerify(exactly = 0) { retrieval.encodeConversationVector(any(), any(), any(), any(), any(), any(), any(), any()) }
    }
}
