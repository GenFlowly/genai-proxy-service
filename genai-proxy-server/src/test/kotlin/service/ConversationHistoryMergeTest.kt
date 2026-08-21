package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import com.genflowly.models.AIConfig
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * Characterization tests for ConversationService.getConversationHistory and
 * getConversationRole. Locks in the turn-merging behavior (parallel per-vendor
 * user-message copies collapse into one prompt/response pair) before the logic
 * is relocated during the refactor. Assertions must not change when the code moves.
 */
class ConversationHistoryMergeTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val service = ConversationService(
        conversationRepo, shareRepo,
        mockk<SharedUsersResolver>(relaxed = true),
        mockk<UtilityGenerationService>(relaxed = true)
    )

    private fun userMsg(id: String, text: String, seq: Int, prev: String? = null, createdAt: String? = null) = Message(
        messageId = id, conversationId = conv, text = text, client = "REACT_APP", role = "user",
        customerId = owner, sequence = seq, systemPrompt = "", aiConfig = emptyList(),
        previousMessageId = prev, instructionId = "inst-1", instructionVersion = "1", createdAt = createdAt
    )

    private fun assistantMsg(id: String, text: String, seq: Int, vendor: AIVendor, model: String, prev: String?) = Message(
        messageId = id, conversationId = conv, text = text, client = "REACT_APP", role = "assistant",
        customerId = owner, sequence = seq, systemPrompt = "", aiConfig = listOf(AIConfig(vendor, model)),
        previousMessageId = prev, inputTokens = 10, outputTokens = 20, totalTokens = 30
    )

    private fun stubConversation(messages: List<Message>) {
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conversationId = conv, customerId = owner, client = "REACT_APP")
        coEvery { conversationRepo.getMessagesForConversation(conv) } returns messages
        coEvery { conversationRepo.getConversationTitle(conv, owner) } returns "My chat"
        coEvery { shareRepo.getConversationShare(any(), any()) } returns null
    }

    @Test
    fun `single turn maps to one pair with response metadata`() = runTest {
        stubConversation(listOf(
            userMsg("u1", "hello", seq = 1, createdAt = "2026-01-01T00:00:00Z"),
            assistantMsg("a1", "hi there", seq = 2, AIVendor.OPENAI, "gpt-4o", prev = "u1")
        ))

        val result = service.getConversationHistory(conv, owner)

        assertEquals("OWNER", result.role)
        assertEquals("My chat", result.title)
        assertEquals(1, result.promptAndResponseList.size)
        val pair = result.promptAndResponseList[0]
        assertEquals("hello", pair.prompt.prompt)
        assertEquals("inst-1", pair.prompt.instructionId)
        assertEquals("2026-01-01T00:00:00Z", pair.promptCreatedAt)
        assertEquals(1, pair.responses?.size)
        val resp = pair.responses!![0]
        assertEquals("hi there", resp.text)
        assertEquals("OPENAI", resp.aiVendor)
        assertEquals("gpt-4o", resp.model)
        assertEquals("a1", resp.messageId)
        assertEquals(10, resp.inputTokens)
        assertEquals(20, resp.outputTokens)
        assertEquals(30, resp.totalTokens)
    }

    @Test
    fun `parallel per-vendor duplicate user messages merge into one pair keeping first createdAt`() = runTest {
        stubConversation(listOf(
            userMsg("u1", "same prompt", seq = 1, createdAt = "T-first"),
            assistantMsg("a1", "openai answer", seq = 2, AIVendor.OPENAI, "gpt-4o", prev = "u1"),
            // Second copy of the same turn: same text, chained off u1 — a raced parallel stream.
            userMsg("u2", "same prompt", seq = 3, prev = "u1", createdAt = "T-second"),
            assistantMsg("a2", "claude answer", seq = 4, AIVendor.CLAUDE, "claude-sonnet", prev = "u2")
        ))

        val result = service.getConversationHistory(conv, owner)

        assertEquals(1, result.promptAndResponseList.size)
        val pair = result.promptAndResponseList[0]
        assertEquals("T-first", pair.promptCreatedAt)
        assertEquals(listOf("openai answer", "claude answer"), pair.responses?.map { it.text })
    }

    @Test
    fun `chained duplicates keep merging into the same turn`() = runTest {
        stubConversation(listOf(
            userMsg("u1", "p", seq = 1, createdAt = "T0"),
            assistantMsg("a1", "r1", seq = 2, AIVendor.OPENAI, "m1", prev = "u1"),
            userMsg("u2", "p", seq = 3, prev = "u1"),
            assistantMsg("a2", "r2", seq = 4, AIVendor.CLAUDE, "m2", prev = "u2"),
            // Third copy chains off the SECOND copy's id, which joined the turn's id set.
            userMsg("u3", "p", seq = 5, prev = "u2"),
            assistantMsg("a3", "r3", seq = 6, AIVendor.GEMINI, "m3", prev = "u3")
        ))

        val result = service.getConversationHistory(conv, owner)

        assertEquals(1, result.promptAndResponseList.size)
        assertEquals(listOf("r1", "r2", "r3"), result.promptAndResponseList[0].responses?.map { it.text })
    }

    @Test
    fun `distinct prompts stay separate pairs`() = runTest {
        stubConversation(listOf(
            userMsg("u1", "first question", seq = 1),
            assistantMsg("a1", "first answer", seq = 2, AIVendor.OPENAI, "m", prev = "u1"),
            userMsg("u2", "second question", seq = 3, prev = "a1"),
            assistantMsg("a2", "second answer", seq = 4, AIVendor.OPENAI, "m", prev = "u2")
        ))

        val result = service.getConversationHistory(conv, owner)

        assertEquals(2, result.promptAndResponseList.size)
        assertEquals("first question", result.promptAndResponseList[0].prompt.prompt)
        assertEquals("second question", result.promptAndResponseList[1].prompt.prompt)
    }

    @Test
    fun `same prompt text without id chain is NOT merged`() = runTest {
        // Same text but previousMessageId does not point into the current turn's ids:
        // a user genuinely re-asking the same thing later must stay a separate pair.
        stubConversation(listOf(
            userMsg("u1", "again", seq = 1),
            assistantMsg("a1", "r1", seq = 2, AIVendor.OPENAI, "m", prev = "u1"),
            userMsg("u2", "again", seq = 3, prev = "a1"),
            assistantMsg("a2", "r2", seq = 4, AIVendor.OPENAI, "m", prev = "u2")
        ))

        val result = service.getConversationHistory(conv, owner)

        assertEquals(2, result.promptAndResponseList.size)
    }

    @Test
    fun `consecutive assistant messages after one user all join that turn`() = runTest {
        stubConversation(listOf(
            userMsg("u1", "p", seq = 1),
            assistantMsg("a1", "r1", seq = 2, AIVendor.OPENAI, "m1", prev = "u1"),
            assistantMsg("a2", "r2", seq = 3, AIVendor.CLAUDE, "m2", prev = "u1")
        ))

        val result = service.getConversationHistory(conv, owner)

        assertEquals(1, result.promptAndResponseList.size)
        assertEquals(listOf("r1", "r2"), result.promptAndResponseList[0].responses?.map { it.text })
    }

    @Test
    fun `no access throws ConversationAccessDeniedException`() = runTest {
        stubConversation(emptyList())

        assertFailsWith<ConversationAccessDeniedException> {
            service.getConversationHistory(conv, "someone-else")
        }
    }

    @Test
    fun `role resolution - owner wins, then direct share, then PUBLIC, else null`() = runTest {
        stubConversation(emptyList())

        assertEquals("OWNER", service.getConversationRole(conv, owner))

        coEvery { shareRepo.getConversationShare(conv, "cust-viewer") } returns "VIEW"
        assertEquals("VIEW", service.getConversationRole(conv, "cust-viewer"))

        coEvery { shareRepo.getConversationShare(conv, "cust-anon") } returns null
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns "VIEW"
        assertEquals("VIEW", service.getConversationRole(conv, "cust-anon"))

        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns null
        assertNull(service.getConversationRole(conv, "cust-anon"))
    }

    @Test
    fun `shared viewer sees role from direct share in history response`() = runTest {
        stubConversation(listOf(
            userMsg("u1", "q", seq = 1),
            assistantMsg("a1", "r", seq = 2, AIVendor.OPENAI, "m", prev = "u1")
        ))
        coEvery { shareRepo.getConversationShare(conv, "cust-viewer") } returns "EDIT"

        val result = service.getConversationHistory(conv, "cust-viewer")

        assertEquals("EDIT", result.role)
        assertEquals(1, result.promptAndResponseList.size)
    }
}
