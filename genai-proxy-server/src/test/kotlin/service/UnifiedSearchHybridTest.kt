package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.Message
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.api.SearchResultItem
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.SearchNotConfiguredException
import com.genflowly.providers.SearchSetupReason
import com.genflowly.providers.SearchVectorHit
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.NotesRepository
import com.genflowly.repository.PendingVectorItem
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.assertThrows
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ResourceNotFoundException
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Hybrid search: vector hits plus keyword matches over records not yet in the
 * vector DB, merged keyword-first and deduplicated, with the same visibility
 * rules for both.
 */
class UnifiedSearchHybridTest {

    private val retrieval = mockk<RetrievalServerClient>()
    private val conversations = mockk<ConversationRepository>(relaxed = true)
    private val notes = mockk<NotesRepository>(relaxed = true)
    private val memories = mockk<MemoryRepository>(relaxed = true)
    private val pending = mockk<VectorSyncPendingRepository>()
    private val service = UnifiedSearchService(retrieval, conversations, notes, memories, pending)

    private fun item(type: PendingVectorType, key: String, conversationId: String? = null) = PendingVectorItem(
        customerId = "CU1", type = type, key = key, conversationId = conversationId,
        pendingSince = "t", attempts = 0, dueAt = null
    )

    private fun message(id: String, conversationId: String, text: String, previous: String?, createdAt: String) = Message(
        messageId = id, conversationId = conversationId, text = text, client = "web",
        role = if (previous == null) "user" else "assistant", customerId = "CU1",
        systemPrompt = "", aiConfig = emptyList(), previousMessageId = previous, createdAt = createdAt
    )

    private fun note(key: String, title: String, body: String) = mapOf(
        "noteKey" to AttributeValue.builder().s(key).build(),
        "title" to AttributeValue.builder().s(title).build(),
        "noteValue" to AttributeValue.builder().s(body).build(),
        "noteCreatedAt" to AttributeValue.builder().s("2026-11-05T10:00:00Z").build()
    )

    private fun hit(type: String, key: String, score: Double) = SearchVectorHit(
        type = type, key = key, title = "", score = score, snippet = "vector snippet", matchedChunks = 1, createdAt = ""
    )

    private fun ownConversation(id: String, title: String) {
        coEvery { conversations.getConversationById(id) } returns Conversation(conversationId = id, customerId = "CU1", client = "web")
        coEvery { conversations.isConversationArchived(id, "CU1") } returns false
        coEvery { conversations.getConversationTitle(id, "CU1") } returns title
    }

    private fun nothingPending() {
        coEvery { pending.listPending(any(), any(), any()) } returns emptyList()
    }

    @Test
    fun `a note waiting for its embed is found by keyword, ahead of vector hits`() = runTest {
        nothingPending()
        coEvery { pending.listPending("CU1", PendingVectorType.NOTE, any()) } returns listOf(item(PendingVectorType.NOTE, "N-new"))
        coEvery { notes.getNotesByKeys("CU1", listOf("N-new")) } returns listOf(note("N-new", "Taxes 2026", "Deduct the home office"))
        coEvery { notes.getNote("CU1", "N-old") } returns note("N-old", "Old note", "x")
        coEvery { retrieval.search("CU1", "home office", 10, listOf("notes")) } returns listOf(hit("notes", "N-old", 0.8))

        val results = service.search("CU1", "home office", 10, listOf("notes"))

        assertEquals(listOf("N-new" to "keyword", "N-old" to "semantic"), results.map { it.key to it.match })
        assertEquals("Taxes 2026", results[0].title)
        assertEquals(null, results[0].score)
        assertEquals(0.8, results[1].score)
    }

    @Test
    fun `a pending exchange matches on its prompt or reply and is shown as its conversation`() = runTest {
        nothingPending()
        coEvery { pending.listPending("CU1", PendingVectorType.CONVERSATION, any()) } returns listOf(
            item(PendingVectorType.CONVERSATION, "A1", "C1"),
            item(PendingVectorType.CONVERSATION, "A2", "C1"),
            item(PendingVectorType.CONVERSATION, "A3", "C2")
        )
        coEvery { conversations.getMessages(listOf("C1" to "A1", "C1" to "A2", "C2" to "A3")) } returns listOf(
            message("A1", "C1", "Deduct the home office.", "U1", "2026-11-05T10:00:00Z"),
            message("A2", "C1", "Yes, the home office counts.", "U2", "2026-11-05T11:00:00Z"),
            message("A3", "C2", "Unrelated reply.", "U3", "2026-11-05T12:00:00Z")
        )
        coEvery { conversations.getMessages(listOf("C1" to "U1", "C1" to "U2", "C2" to "U3")) } returns listOf(
            message("U1", "C1", "What can I deduct?", null, "t"),
            message("U2", "C1", "Even rent?", null, "t"),
            message("U3", "C2", "Plan a trip", null, "t")
        )
        ownConversation("C1", "Tax questions")
        coEvery { retrieval.search(any(), any(), any(), any()) } returns emptyList()

        val results = service.search("CU1", "home office", 10, listOf("conversation"))

        assertEquals(listOf("C1"), results.map { it.key })
        assertEquals("Tax questions", results[0].title)
        assertEquals("2026-11-05T11:00:00Z", results[0].createdAt)
        assertEquals(SearchResultItem.MATCH_KEYWORD, results[0].match)
    }

    @Test
    fun `keyword matches follow the conversation visibility rules`() = runTest {
        nothingPending()
        coEvery { pending.listPending("CU1", PendingVectorType.CONVERSATION, any()) } returns
            listOf(item(PendingVectorType.CONVERSATION, "A1", "C1"))
        coEvery { conversations.getMessages(listOf("C1" to "A1")) } returns
            listOf(message("A1", "C1", "home office", null, "t"))
        coEvery { conversations.getConversationById("C1") } returns Conversation(conversationId = "C1", customerId = "CU1", client = "web")
        coEvery { conversations.isConversationArchived("C1", "CU1") } returns true
        coEvery { retrieval.search(any(), any(), any(), any()) } returns emptyList()

        assertEquals(emptyList(), service.search("CU1", "home office", 10, listOf("conversation")))
    }

    @Test
    fun `a pending memory is found by keyword and a forgotten one is not`() = runTest {
        nothingPending()
        coEvery { pending.listPending("CU1", PendingVectorType.MEMORY, any()) } returns
            listOf(item(PendingVectorType.MEMORY, "MEM#a"), item(PendingVectorType.MEMORY, "MEM#gone"))
        coEvery { memories.getMemory("CU1", "MEM#a") } returns CustomerMemory(
            memoryId = "MEM#a", text = "Works from a home office.", kind = MemoryKind.CORE, category = "work",
            sourceType = MemorySourceType.CONVERSATION, createdAt = "t", updatedAt = "t"
        )
        coEvery { memories.getMemory("CU1", "MEM#gone") } returns null
        coEvery { retrieval.search(any(), any(), any(), any()) } returns emptyList()

        val results = service.search("CU1", "home office", 10, null)

        assertEquals(listOf("MEM#a"), results.map { it.key })
        assertEquals("[memory] work", results[0].title)
    }

    @Test
    fun `a record found both ways appears once, as its vector hit`() = runTest {
        nothingPending()
        coEvery { pending.listPending("CU1", PendingVectorType.NOTE, any()) } returns listOf(item(PendingVectorType.NOTE, "N1"))
        coEvery { notes.getNotesByKeys("CU1", listOf("N1")) } returns listOf(note("N1", "Taxes", "home office"))
        coEvery { notes.getNote("CU1", "N1") } returns note("N1", "Taxes", "home office")
        coEvery { retrieval.search(any(), any(), any(), any()) } returns listOf(hit("notes", "N1", 0.9))

        val results = service.search("CU1", "home office", 10, listOf("notes"))

        assertEquals(listOf("N1" to "semantic"), results.map { it.key to it.match })
    }

    @Test
    fun `only the requested types are looked up`() = runTest {
        nothingPending()
        coEvery { retrieval.search(any(), any(), any(), any()) } returns emptyList()

        service.search("CU1", "home office", 10, listOf("notes"))

        coVerify(exactly = 0) { pending.listPending(any(), PendingVectorType.CONVERSATION, any()) }
        coVerify(exactly = 0) { pending.listPending(any(), PendingVectorType.MEMORY, any()) }
    }

    @Test
    fun `a failed keyword lookup only drops keyword results`() = runTest {
        coEvery { pending.listPending(any(), any(), any()) } throws
            ResourceNotFoundException.builder().message("Requested resource not found").build()
        coEvery { notes.getNote("CU1", "N1") } returns note("N1", "Taxes", "x")
        coEvery { retrieval.search(any(), any(), any(), any()) } returns listOf(hit("notes", "N1", 0.9))

        assertEquals(listOf("N1"), service.search("CU1", "home office", 10, listOf("notes")).map { it.key })
    }

    @Test
    fun `a vector search that couldn't run still fails the search`() = runTest {
        nothingPending()
        coEvery { retrieval.search(any(), any(), any(), any()) } throws
            SearchNotConfiguredException(SearchSetupReason.VECTOR_DB, "No vector DB")

        assertThrows<SearchNotConfiguredException> { service.search("CU1", "home office", 10, null) }
    }
}
