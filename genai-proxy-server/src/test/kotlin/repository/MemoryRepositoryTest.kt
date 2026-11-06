package com.genflowly.repository

import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryChangeType
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.CancellationReason
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsResponse
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Every memory change is one transaction: the memory row and an immutable
 * change-log row. Writes are conditioned so a stale read can't overwrite a
 * newer change, and a memory stored before versions existed gets its
 * version 1 written once, with its first recorded change.
 */
class MemoryRepositoryTest {

    private val client = mockk<DynamoDbClient>()
    private val repo = MemoryRepository(client, KotlinLogging.logger {})
    private val transaction = slot<TransactWriteItemsRequest>()

    private fun acceptTransactions() {
        every { client.transactWriteItems(capture(transaction)) } returns TransactWriteItemsResponse.builder().build()
    }

    private fun s(value: String) = AttributeValue.builder().s(value).build()

    private fun tracked(version: Int = 2, rev: Long = 5) = CustomerMemory(
        memoryId = "MEM#u1", text = "Prefers short answers.", kind = MemoryKind.CORE,
        sourceType = MemorySourceType.CONVERSATION, sourceId = "CONV1", createdAt = "2026-09-19T16:44:00Z",
        updatedAt = "t", placements = listOf(MemoryPlacement(null, MemoryKind.CORE)),
        version = version, tracked = true, rev = rev
    )

    private fun legacy() = tracked().copy(version = 1, tracked = false, rev = 0)

    @Test
    fun `creating a memory writes it and its first change together`() = runTest {
        acceptTransactions()

        val memory = repo.createMemory(
            "CU1", "Report is due Dec 12.", listOf(MemoryPlacement("PRJa", MemoryKind.EPISODIC)), "project",
            MemorySourceType.CONVERSATION, "CONV1",
            MemoryChangeCause(MemoryChangeType.LEARNED, MemorySourceType.CONVERSATION, "CONV1", "M2", reason = "States the deadline")
        )

        val (row, change) = transaction.captured.transactItems().map { it.put() }
        assertEquals("attribute_not_exists(memoryId)", row.conditionExpression())
        assertEquals(mapOf("PRJa" to s("EPISODIC")), row.item()["placements"]!!.m())
        assertEquals("1", row.item()["version"]!!.n())
        assertEquals("EPISODIC", row.item()["kind"]!!.s())
        assertTrue(change.item()["memoryId"]!!.s().startsWith("MEMCHG#${memory.memoryId.removePrefix("MEM#")}#"))
        assertEquals("LEARNED", change.item()["changeType"]!!.s())
        assertEquals("1", change.item()["version"]!!.n())
        assertEquals("M2", change.item()["messageId"]!!.s())
        assertEquals("States the deadline", change.item()["reason"]!!.s())
        assertEquals("attribute_not_exists(memoryId)", change.conditionExpression())
    }

    @Test
    fun `an edit saves the next version only if no newer one exists`() = runTest {
        acceptTransactions()

        assertTrue(repo.updateMemoryText("CU1", tracked(version = 2), "Prefers concise answers.", MemoryChangeCause(MemoryChangeType.EDITED_BY_YOU)))

        val items = transaction.captured.transactItems()
        assertEquals(2, items.size)
        val update = items[0].update()
        assertEquals("#version = :base", update.conditionExpression())
        assertEquals("2", update.expressionAttributeValues()[":base"]!!.n())
        assertEquals("3", update.expressionAttributeValues()[":nv"]!!.n())
        val change = items[1].put().item()
        assertEquals("3", change["version"]!!.n())
        assertEquals("Prefers concise answers.", change["text"]!!.s())
        assertEquals("Prefers short answers.", change["previousText"]!!.s())
    }

    @Test
    fun `the first change to an old memory records its starting text as version 1, once`() = runTest {
        acceptTransactions()

        assertTrue(repo.updateMemoryText("CU1", legacy(), "Prefers concise answers.", MemoryChangeCause(MemoryChangeType.EDITED_BY_YOU)))

        val (baseline, update, change) = transaction.captured.transactItems()
        val base = baseline.put().item()
        assertEquals("MEMCHG#u1#2026-09-19T16:44:00Z#base", base["memoryId"]!!.s())
        assertEquals("LEGACY", base["changeType"]!!.s())
        assertEquals("1", base["version"]!!.n())
        assertEquals("Prefers short answers.", base["text"]!!.s())
        assertEquals("CONV1", base["conversationId"]!!.s())
        assertEquals("attribute_exists(memoryId) AND attribute_not_exists(#version)", update.update().conditionExpression())
        assertEquals("2", change.put().item()["version"]!!.n())
    }

    @Test
    fun `a refused condition reports false instead of throwing`() = runTest {
        every { client.transactWriteItems(any<TransactWriteItemsRequest>()) } throws TransactionCanceledException.builder()
            .message("cancelled")
            .cancellationReasons(CancellationReason.builder().code("None").build(), CancellationReason.builder().code("ConditionalCheckFailed").build())
            .build()

        assertFalse(repo.updateMemoryText("CU1", tracked(), "x", MemoryChangeCause(MemoryChangeType.EDITED_BY_YOU)))
    }

    @Test
    fun `moving checks the write counter and logs from and to without a version`() = runTest {
        acceptTransactions()

        assertTrue(
            repo.setPlacements(
                "CU1", tracked(rev = 5), listOf(MemoryPlacement("PRJb", MemoryKind.CORE)),
                MemoryChangeCause(MemoryChangeType.MOVED),
                from = listOf(MemoryPlacement(null, MemoryKind.CORE)), to = listOf(MemoryPlacement("PRJb", MemoryKind.CORE))
            )
        )

        val (update, change) = transaction.captured.transactItems()
        assertEquals("attribute_exists(memoryId) AND #rev = :rev", update.update().conditionExpression())
        assertEquals("5", update.update().expressionAttributeValues()[":rev"]!!.n())
        assertEquals("6", update.update().expressionAttributeValues()[":nrev"]!!.n())
        assertEquals(mapOf("PRJb" to s("CORE")), update.update().expressionAttributeValues()[":p"]!!.m())
        val item = change.put().item()
        assertEquals("MOVED", item["changeType"]!!.s())
        assertNull(item["version"])
        assertEquals(mapOf("PROFILE" to s("CORE")), item["fromPlacements"]!!.m())
        assertEquals(mapOf("PRJb" to s("CORE")), item["toPlacements"]!!.m())
    }

    @Test
    fun `an old memory without placements reads as Profile with its kind, untracked`() = runTest {
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(
            mapOf(
                "customerId" to s("CU1"), "memoryId" to s("MEM#u1"), "text" to s("Lives in Lisbon."),
                "kind" to s("CORE"), "sourceType" to s("CONVERSATION"), "createdAt" to s("t"), "updatedAt" to s("t")
            )
        ).build()

        val memory = repo.getMemory("CU1", "MEM#u1")!!

        assertEquals(listOf(MemoryPlacement(null, MemoryKind.CORE)), memory.placements)
        assertEquals(1, memory.version)
        assertFalse(memory.tracked)
        assertEquals(0L, memory.rev)
    }

    @Test
    fun `placements read Profile first, then projects by id`() = runTest {
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(
            mapOf(
                "customerId" to s("CU1"), "memoryId" to s("MEM#u1"), "text" to s("x"), "kind" to s("CORE"),
                "sourceType" to s("USER"), "createdAt" to s("t"), "updatedAt" to s("t"),
                "placements" to AttributeValue.builder().m(mapOf("PRJz" to s("CORE"), "PRJa" to s("EPISODIC"))).build(),
                "version" to AttributeValue.builder().n("4").build(),
                "hitCount" to AttributeValue.builder().n("31").build(),
            )
        ).build()

        val memory = repo.getMemory("CU1", "MEM#u1")!!

        assertEquals(listOf(MemoryPlacement("PRJa", MemoryKind.EPISODIC), MemoryPlacement("PRJz", MemoryKind.CORE)), memory.placements)
        assertEquals(MemoryKind.EPISODIC, memory.kind)
        assertEquals(MemorySourceType.USER, memory.sourceType)
        assertEquals(4, memory.version)
        assertEquals(31L, memory.hitCount)
    }

    @Test
    fun `usage pages run newest first and resume from the cursor`() = runTest {
        val queries = mutableListOf<QueryRequest>()
        every { client.query(capture(queries)) } returnsMany listOf(
            QueryResponse.builder()
                .items(
                    mapOf(
                        "memoryId" to s("MEMUSE#u1#2026-11-05T10:42:00Z#m2"), "conversationId" to s("C1"),
                        "messageId" to s("m2"), "usedAt" to s("2026-11-05T10:42:00Z"), "how" to s("core")
                    )
                )
                .lastEvaluatedKey(mapOf("customerId" to s("CU1"), "memoryId" to s("MEMUSE#u1#2026-11-05T10:42:00Z#m2")))
                .build(),
            QueryResponse.builder().items(emptyList()).build(),
        )

        val (first, cursor) = repo.getUsagePage("CU1", "MEM#u1", 1, null)
        val (_, end) = repo.getUsagePage("CU1", "MEM#u1", 1, cursor)

        assertEquals("C1", first.single().conversationId)
        assertEquals("core", first.single().how)
        assertFalse(queries[0].scanIndexForward())
        assertEquals("MEMUSE#u1#", queries[0].expressionAttributeValues()[":prefix"]!!.s())
        assertEquals("MEMUSE#u1#2026-11-05T10:42:00Z#m2", queries[1].exclusiveStartKey()["memoryId"]!!.s())
        assertNull(end)
    }

    @Test
    fun `a cursor for another memory is ignored`() = runTest {
        val queries = mutableListOf<QueryRequest>()
        every { client.query(capture(queries)) } returns QueryResponse.builder().items(emptyList()).build()
        val otherCursor = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("MEMUSE#other#t#m".toByteArray())

        repo.getUsagePage("CU1", "MEM#u1", 10, otherCursor)

        assertFalse(queries.single().hasExclusiveStartKey())
    }
}
