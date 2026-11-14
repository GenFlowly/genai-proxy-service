package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.ShareRepository
import com.genflowly.utils.MemoryRedaction
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Memory privacy on shared conversations: the MEMORY thinking step's memory
 * texts and the turn's learned facts are visible ONLY to the turn's author.
 * Every other viewer — owner reading a recipient's turn, share recipients,
 * PUBLIC/logged-out — gets the step's count-only detail line and no facts.
 */
class ConversationMemoryRedactionTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val customerProfileRepo = mockk<CustomerProfileRepository>(relaxed = true)
    private val service = ConversationService(conversationRepo, shareRepo, customerProfileRepo, mockk(relaxed = true), mockk(relaxed = true), ContentFilter(emptyList()))

    private val thinkingStepsJson = """
        [
          {"node":"m1","name":"Memory","kind":"MEMORY","status":"running","label":"Memory: loading what is known about you…"},
          {"node":"m1","name":"Memory","kind":"MEMORY","status":"done",
           "detail":"Applied 2 core memori(es); recalled 1 related to this message",
           "memories":{"core":["Works at Acme","Is vegetarian"],"recalled":["Allergic to penicillin"]},
           "items":["Allergic to penicillin","Works at Acme","Is vegetarian"]},
          {"node":"g1","name":"Generate","kind":"LLM","status":"done","detail":"Response generated"}
        ]
    """.trimIndent()

    private val learnedFactsJson = """[{"memoryId":"mem-1","text":"Has a cat named Miso"}]"""

    private fun userMsg(id: String, seq: Int, author: String = owner) = Message(
        messageId = id, conversationId = conv, text = "hello", client = "REACT_APP", role = "user",
        customerId = author, sequence = seq, systemPrompt = "", aiConfig = emptyList(),
        previousMessageId = null
    )

    private fun assistantMsg(id: String, seq: Int, prev: String, author: String = owner) = Message(
        messageId = id, conversationId = conv, text = "hi", client = "REACT_APP", role = "assistant",
        customerId = author, sequence = seq, systemPrompt = "", aiConfig = listOf(AIConfig(AIVendor.OPENAI, "gpt-4o")),
        previousMessageId = prev, thinkingStepsJson = thinkingStepsJson, learnedFactsJson = learnedFactsJson
    )

    private fun stubConversation(messages: List<Message>) {
        coEvery { conversationRepo.getConversationById(conv) } returns
            Conversation(conversationId = conv, customerId = owner, client = "REACT_APP")
        coEvery { conversationRepo.getMessagesForConversation(conv) } returns messages
        coEvery { conversationRepo.getConversationTitle(conv, owner) } returns "My chat"
        coEvery { shareRepo.getConversationShare(any(), any()) } returns null
        coEvery { customerProfileRepo.getCustomerProfileByCustomerId(any()) } returns null
    }

    private suspend fun fetchResponseAs(viewer: String): com.genflowly.models.GenerateTextResponse =
        service.getConversationHistory(conv, viewer).promptAndResponseList[0].responses!![0]

    private fun memoryDoneStep(resp: com.genflowly.models.GenerateTextResponse): JsonObject =
        resp.thinkingSteps!!.jsonArray.map { it.jsonObject }
            .first { it["kind"]?.jsonPrimitive?.content == "MEMORY" && it["status"]?.jsonPrimitive?.content == "done" }

    @Test
    fun `author sees memory texts and learned facts`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))

        val resp = fetchResponseAs(owner)

        val step = memoryDoneStep(resp)
        assertTrue("memories" in step)
        assertTrue("items" in step)
        assertNotNull(resp.learnedFacts)
    }

    @Test
    fun `public viewer gets counts only - no memory texts, no learned facts`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns ShareRole.VIEW

        val resp = fetchResponseAs("PUBLIC")

        val step = memoryDoneStep(resp)
        assertFalse("memories" in step)
        assertFalse("items" in step)
        assertEquals(
            "Applied 2 core memori(es); recalled 1 related to this message",
            step["detail"]?.jsonPrimitive?.content
        )
        assertNull(resp.learnedFacts)
        // Non-MEMORY steps pass through untouched
        val llmStep = resp.thinkingSteps!!.jsonArray.map { it.jsonObject }
            .first { it["kind"]?.jsonPrimitive?.content == "LLM" }
        assertEquals("Response generated", llmStep["detail"]?.jsonPrimitive?.content)
    }

    @Test
    fun `direct share recipient is redacted like any non-author`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))
        coEvery { shareRepo.getConversationShare(conv, "cust-viewer") } returns ShareRole.EDIT

        val resp = fetchResponseAs("cust-viewer")

        val step = memoryDoneStep(resp)
        assertFalse("memories" in step)
        assertFalse("items" in step)
        assertNull(resp.learnedFacts)
    }

    @Test
    fun `owner is redacted on a turn authored by a share recipient - memories follow the author`() = runTest {
        // An EDIT recipient wrote this turn, so the MEMORY step loaded THEIR
        // memories — the owner must not see those texts either.
        stubConversation(listOf(
            userMsg("u1", 1, author = "cust-editor"),
            assistantMsg("a1", 2, prev = "u1", author = "cust-editor")
        ))
        coEvery { shareRepo.getConversationShare(conv, "cust-editor") } returns ShareRole.EDIT

        val ownerView = fetchResponseAs(owner)
        assertFalse("memories" in memoryDoneStep(ownerView))
        assertNull(ownerView.learnedFacts)

        val authorView = fetchResponseAs("cust-editor")
        assertTrue("memories" in memoryDoneStep(authorView))
        assertNotNull(authorView.learnedFacts)
    }

    @Test
    fun `redactThinkingStepJson strips memory content, passes other steps, drops garbage`() {
        val memoryStep = """{"node":"m1","kind":"MEMORY","status":"done","detail":"Applied 1 core memori(es)","memories":{"core":["secret"],"recalled":[]},"items":["secret"]}"""
        val redacted = MemoryRedaction.redactThinkingStepJson(memoryStep)
        assertNotNull(redacted)
        assertFalse(redacted.contains("secret"))
        assertTrue(redacted.contains("Applied 1 core memori(es)"))

        val llmStep = """{"node":"g1","kind":"LLM","status":"done","detail":"Response generated"}"""
        val passedThrough = MemoryRedaction.redactThinkingStepJson(llmStep)
        assertNotNull(passedThrough)
        assertTrue(passedThrough.contains("Response generated"))

        assertNull(MemoryRedaction.redactThinkingStepJson("not json {"))
    }
}
