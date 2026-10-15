package com.genflowly.repository

import com.genflowly.models.AttachmentRef
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.ScanRequest
import software.amazon.awssdk.services.dynamodb.model.ScanResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Request shapes of the ConversationRepository reads and writes the retention paths use. */
class RetentionRepositoryQueriesTest {

    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String) = AttributeValue.builder().s(v).build()

    @Test
    fun `the write guard reads the owner's row strongly consistent`() = runTest {
        val gets = mutableListOf<GetItemRequest>()
        every { client.getItem(capture(gets)) } returns GetItemResponse.builder().item(mapOf(
            "customerId" to s("owner"), "conversationId" to s("conv-1"),
            "purgeStartedAt" to s("2026-10-15T00:00:00Z")
        )).build()

        val state = repository.getConversationWriteState("owner", "conv-1")!!

        assertTrue(gets.single().consistentRead())
        assertEquals("owner", state.ownerCustomerId)
        assertEquals("2026-10-15T00:00:00Z", state.purgeStartedAt)
        assertFalse(state.archived)
    }

    @Test
    fun `a share recipient's write finds the owner through the conversation index`() = runTest {
        val gets = mutableListOf<GetItemRequest>()
        every { client.getItem(capture(gets)) } answers {
            val owner = firstArg<GetItemRequest>().key()["customerId"]!!.s()
            if (owner == "owner") {
                GetItemResponse.builder().item(mapOf(
                    "customerId" to s("owner"), "conversationId" to s("conv-1"), "archivedAt" to s("x")
                )).build()
            } else GetItemResponse.builder().build()
        }
        every { client.query(any<QueryRequest>()) } returns QueryResponse.builder()
            .items(listOf(mapOf("customerId" to s("owner"), "conversationId" to s("conv-1")))).build()

        val state = repository.getConversationWriteState("recipient", "conv-1")!!

        assertEquals("owner", state.ownerCustomerId)
        assertTrue(state.archived)
        assertEquals(listOf("recipient", "owner"), gets.map { it.key()["customerId"]!!.s() })
    }

    @Test
    fun `a missing conversation reads as null`() = runTest {
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().build()
        every { client.query(any<QueryRequest>()) } returns QueryResponse.builder().items(emptyList()).build()

        assertNull(repository.getConversationWriteState("someone", "conv-x"))
    }

    @Test
    fun `pending claims come oldest first from the sparse index`() = runTest {
        val queries = mutableListOf<QueryRequest>()
        every { client.query(capture(queries)) } returns QueryResponse.builder().items(listOf(mapOf(
            "conversationId" to s("conv-1"), "messageId" to s("m1"),
            "claimPending" to AttributeValue.builder().n("1").build(), "createdAt" to s("2026-10-01T00:00:00Z")
        ))).build()

        val pending = repository.getClaimPendingMessageKeys(50)

        val request = queries.single()
        assertEquals(RetentionTables.MESSAGE_CLAIM_PENDING_GSI, request.indexName())
        assertEquals("1", request.expressionAttributeValues()[":one"]!!.n())
        assertTrue(request.scanIndexForward())
        assertEquals(50, request.limit())
        assertEquals(listOf(MessageKey("conv-1", "m1") to "2026-10-01T00:00:00Z"), pending)
    }

    @Test
    fun `a reconciled claim rewrites refs and removes the flag, never re-creating the row`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        assertTrue(repository.updateMessageRetention(
            "conv-1", "m1",
            attachments = listOf(AttachmentRef("a", "customers/c/attachments/b", "image/png")),
            toolResultsJson = null,
            clearClaimPending = true
        ))

        val update = updates.single()
        assertEquals("SET #att = :att REMOVE #cp", update.updateExpression())
        assertEquals("attribute_exists(#mid)", update.conditionExpression())
        assertEquals("claimPending", update.expressionAttributeNames()["#cp"])
        assertEquals(
            "customers/c/attachments/b",
            update.expressionAttributeValues()[":att"]!!.l().single().m()["s3Key"]!!.s()
        )

        every { client.updateItem(any<UpdateItemRequest>()) } throws
            ConditionalCheckFailedException.builder().message("gone").build()
        assertFalse(repository.updateMessageRetention("conv-1", "gone", null, null, true))
    }

    @Test
    fun `the backfill scan pages with an opaque token`() = runTest {
        val scans = mutableListOf<ScanRequest>()
        val lastKey = mapOf("conversationId" to s("conv-1"), "messageId" to s("m9"))
        every { client.scan(capture(scans)) } answers {
            if (scans.size == 1) {
                ScanResponse.builder().items(emptyList()).lastEvaluatedKey(lastKey).build()
            } else {
                ScanResponse.builder().items(emptyList()).build()
            }
        }

        val first = repository.scanMessageFileRefs(pageToken = null, limit = 100)
        val token = first.nextPageToken!!
        val second = repository.scanMessageFileRefs(token, limit = 100)

        assertEquals(lastKey, scans[1].exclusiveStartKey())
        assertNull(second.nextPageToken)
        assertEquals(100, scans[0].limit())
        assertFailsWith<IllegalArgumentException> { repository.scanMessageFileRefs("not-a-token", 10) }
    }
}
