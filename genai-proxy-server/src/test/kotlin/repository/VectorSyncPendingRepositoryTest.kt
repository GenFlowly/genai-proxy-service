package com.genflowly.repository

import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import java.time.Instant
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The row shapes other code relies on: keys the encoding-server deletes by,
 * the sparse retry index attributes, and the conditional attempt claim.
 */
class VectorSyncPendingRepositoryTest {

    private val dynamo = mockk<DynamoDbClient>()
    private val repository = VectorSyncPendingRepository(dynamo, KotlinLogging.logger("test"))

    @Test
    fun `a pending exchange is keyed for the encoding-server and scheduled for a retry`() = runTest {
        val put = slot<PutItemRequest>()
        every { dynamo.putItem(capture(put)) } returns PutItemResponse.builder().build()
        val retryAt = Instant.parse("2026-11-05T10:05:00Z")

        repository.markPending("CU1", PendingVectorType.CONVERSATION, "A1", conversationId = "C1", retryAt = retryAt)

        val item = put.captured.item()
        assertEquals("VectorSyncPending", put.captured.tableName())
        assertEquals("CU1", item["customerId"]?.s())
        assertEquals("conversation#A1", item["itemKey"]?.s())
        assertEquals("C1", item["conversationId"]?.s())
        assertEquals("RETRY", item["retryShard"]?.s())
        assertEquals("2026-11-05T10:05:00Z", item["dueAt"]?.s())
        assertEquals("0", item["attempts"]?.n())
    }

    @Test
    fun `a pending note without a retry stays out of the retry index`() = runTest {
        val put = slot<PutItemRequest>()
        every { dynamo.putItem(capture(put)) } returns PutItemResponse.builder().build()

        repository.markPending("CU1", PendingVectorType.NOTE, "N1")

        val item = put.captured.item()
        assertEquals("notes#N1", item["itemKey"]?.s())
        assertFalse(item.containsKey("retryShard"))
        assertFalse(item.containsKey("dueAt"))
    }

    @Test
    fun `an attempt is claimed only against the dueAt that was read`() = runTest {
        val update = slot<UpdateItemRequest>()
        every { dynamo.updateItem(capture(update)) } returns UpdateItemResponse.builder()
            .attributes(mapOf("attempts" to AttributeValue.builder().n("2").build()))
            .build()
        val item = PendingVectorItem("CU1", PendingVectorType.MEMORY, "MEM#a", null, "t0", 1, "2026-11-05T10:00:00Z")

        assertEquals(2, repository.startAttempt(item, 300))
        assertTrue(update.captured.conditionExpression().contains("dueAt = :seen"))
        assertEquals("2026-11-05T10:00:00Z", update.captured.expressionAttributeValues()[":seen"]?.s())
    }

    @Test
    fun `a lost claim returns null`() = runTest {
        every { dynamo.updateItem(any<UpdateItemRequest>()) } throws
            ConditionalCheckFailedException.builder().message("no").build()
        val item = PendingVectorItem("CU1", PendingVectorType.MEMORY, "MEM#a", null, "t0", 1, "d")

        assertNull(repository.startAttempt(item, 300))
    }
}
