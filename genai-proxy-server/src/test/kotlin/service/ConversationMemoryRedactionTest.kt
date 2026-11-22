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
import kotlinx.serialization.json.Json
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
 * Memory privacy on shared conversations: the activity log's memory texts,
 * its developer excerpts, subagent traces and the turn's learned facts are
 * visible ONLY to the turn's author. Every other viewer (the owner reading a
 * recipient's turn, a direct share recipient, a signed-in public-link visitor,
 * a logged-out reader) gets the memory counts and nothing else of that kind.
 */
class ConversationMemoryRedactionTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val customerProfileRepo = mockk<CustomerProfileRepository>(relaxed = true)
    private val service = ConversationService(conversationRepo, shareRepo, customerProfileRepo, mockk(relaxed = true), mockk(relaxed = true), ContentFilter(emptyList()))

    private val activityJson = """
        [
          {"v":2,"at":0,"type":"turn.start"},
          {"v":2,"at":0,"type":"step.start","id":"m1:1","kind":"memory","node":"m1","name":"Memory"},
          {"v":2,"at":300,"type":"step.end","id":"m1:1","kind":"memory","node":"m1","name":"Memory","duration_ms":300,
           "counts":{"core":2,"recalled":1},
           "memories":{"core":["Works at Acme","Is vegetarian"],"recalled":["Allergic to penicillin"]}},
          {"v":2,"at":300,"type":"step.start","id":"g1:1","kind":"llm","node":"g1","name":"Agent"},
          {"v":2,"at":1900,"type":"step.end","id":"g1:1","kind":"llm","node":"g1","name":"Agent","duration_ms":1600,
           "outcome":"tool_calls","reasoning":"Checking the menu.",
           "tool_calls":[{"id":"c1","name":"spawn_agent","args":{"purpose":"Find options on the menu.","prompt":"Find options"}}],
           "developer":{"prompt_excerpt":"Is vegetarian. Works at Acme. What can I order?"}},
          {"v":2,"at":1900,"type":"step.start","id":"t1:1","kind":"tools","node":"t1","name":"Tools"},
          {"v":2,"at":4000,"type":"step.end","id":"t1:1","kind":"tools","node":"t1","name":"Tools","duration_ms":2100,
           "calls":[{"id":"c1","seq":1,"name":"spawn_agent","args":{"purpose":"Find options on the menu."},"mode":"run",
                     "sources":[{"index":1,"title":"Menu","url":"https://cafe.example/menu"}],
                     "details":{"subagent":"general","subagent_trace":[{"node":"RESPONSE_GENERATOR","prompt":"vegetarian at Acme"}]}}]},
          {"v":2,"at":5000,"type":"turn.end","duration_ms":5000,"outcome":"completed"}
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
        previousMessageId = prev, activityJson = activityJson, learnedFactsJson = learnedFactsJson
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

    private fun events(resp: com.genflowly.models.GenerateTextResponse): List<JsonObject> =
        resp.activity!!.jsonArray.map { it.jsonObject }

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content

    private fun end(resp: com.genflowly.models.GenerateTextResponse, kind: String): JsonObject =
        events(resp).first { it.str("type") == "step.end" && it.str("kind") == kind }

    private fun firstCall(resp: com.genflowly.models.GenerateTextResponse): JsonObject =
        end(resp, "tools")["calls"]!!.jsonArray[0].jsonObject

    private fun assertAuthorView(resp: com.genflowly.models.GenerateTextResponse) {
        assertTrue("memories" in end(resp, "memory"))
        assertTrue("developer" in end(resp, "llm"))
        assertTrue("details" in firstCall(resp))
        assertNotNull(resp.learnedFacts)
    }

    private fun assertCountsOnly(resp: com.genflowly.models.GenerateTextResponse) {
        val memory = end(resp, "memory")
        assertFalse("memories" in memory)
        assertEquals("""{"core":2,"recalled":1}""", memory["counts"].toString())
        assertFalse(events(resp).any { "developer" in it })
        assertFalse("details" in firstCall(resp))
        assertFalse(resp.activity.toString().contains("vegetarian", ignoreCase = true))
        assertFalse(resp.activity.toString().contains("Acme"))
        // Everything the panel needs for the story and the evidence survives.
        assertEquals("Checking the menu.", end(resp, "llm").str("reasoning"))
        assertEquals(1, firstCall(resp)["sources"]!!.jsonArray.size)
        assertEquals(Json.parseToJsonElement(activityJson).jsonArray.size, events(resp).size)
        assertNull(resp.learnedFacts)
    }

    @Test
    fun `author sees memory texts, developer data and learned facts`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))
        assertAuthorView(fetchResponseAs(owner))
    }

    @Test
    fun `logged-out reader gets counts only`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns ShareRole.VIEW
        assertCountsOnly(fetchResponseAs("PUBLIC"))
    }

    @Test
    fun `signed-in public-link visitor gets counts only`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))
        coEvery { shareRepo.getConversationShare(conv, "PUBLIC") } returns ShareRole.VIEW
        assertCountsOnly(fetchResponseAs("cust-stranger"))
    }

    @Test
    fun `direct share recipient gets counts only`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1")))
        coEvery { shareRepo.getConversationShare(conv, "cust-viewer") } returns ShareRole.EDIT
        assertCountsOnly(fetchResponseAs("cust-viewer"))
    }

    @Test
    fun `owner gets counts only on a turn a share recipient wrote - memories follow the author`() = runTest {
        // An EDIT recipient wrote this turn, so the memory step loaded THEIR
        // memories: the owner must not see those texts either.
        stubConversation(listOf(
            userMsg("u1", 1, author = "cust-editor"),
            assistantMsg("a1", 2, prev = "u1", author = "cust-editor")
        ))
        coEvery { shareRepo.getConversationShare(conv, "cust-editor") } returns ShareRole.EDIT

        assertCountsOnly(fetchResponseAs(owner))
        assertAuthorView(fetchResponseAs("cust-editor"))
    }

    @Test
    fun `a live activity frame is redacted the same way, and garbage is dropped`() {
        val log = Json.parseToJsonElement(activityJson).jsonArray
        val memoryEnd = MemoryRedaction.redactActivityEventJson(log[2].toString())
        assertNotNull(memoryEnd)
        assertFalse(memoryEnd.contains("Acme"))
        assertTrue(memoryEnd.contains("\"counts\":{\"core\":2,\"recalled\":1}"))

        val llmEnd = MemoryRedaction.redactActivityEventJson(log[4].toString())!!
        assertFalse(llmEnd.contains("developer"))
        assertTrue(llmEnd.contains("Checking the menu."))

        val toolsEnd = MemoryRedaction.redactActivityEventJson(log[6].toString())!!
        assertFalse(toolsEnd.contains("subagent_trace"))
        assertTrue(toolsEnd.contains("https://cafe.example/menu"))

        val start = """{"v":2,"at":0,"type":"turn.start"}"""
        assertEquals(start, MemoryRedaction.redactActivityEventJson(start))
        assertNull(MemoryRedaction.redactActivityEventJson("not json {"))
    }
}
