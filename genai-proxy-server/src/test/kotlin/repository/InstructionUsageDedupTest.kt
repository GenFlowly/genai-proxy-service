package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.paginators.QueryIterable
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Characterization tests for the instruction-usage dedup contract:
 * markInstructionUsageSeenIfNew is a conditional put that returns true only on
 * the first (conversation, instruction) occurrence; incrementInstructionUsage
 * is an atomic ADD counter that callers invoke only after a true. Locked in
 * before the "increment only if first-seen" orchestration ascends to a service.
 */
class InstructionUsageDedupTest {

    private val client = mockk<DynamoDbClient>()
    private val provider = InstructionRepository(client, mockk<KLogger>(relaxed = true))

    @Test
    fun `first occurrence writes conditional put with composite key and returns true`() = runTest {
        val puts = mutableListOf<PutItemRequest>()
        every { client.putItem(capture(puts)) } returns PutItemResponse.builder().build()

        val first = provider.markInstructionUsageSeenIfNew("cust-1", "conv-1", "inst-1")

        assertTrue(first)
        assertEquals(1, puts.size)
        val req = puts[0]
        assertEquals(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE, req.tableName())
        assertEquals("conv-1#inst-1", req.item()[DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY]?.s())
        assertEquals("cust-1", req.item()[DynamoDBConstants.CUSTOMER_ID_KEY]?.s())
        assertTrue(req.conditionExpression()!!.contains("attribute_not_exists"))
        assertTrue(req.item()[DynamoDBConstants.INSTRUCTION_USAGE_SEEN_AT_KEY]?.s()!!.startsWith("20"))
    }

    @Test
    fun `an instruction's conversations are its rows of the caller's usage set`() = runTest {
        fun row(key: String, seenAt: String?) = buildMap {
            put(DynamoDBConstants.CUSTOMER_ID_KEY, AttributeValue.builder().s("cust-1").build())
            put(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY, AttributeValue.builder().s(key).build())
            seenAt?.let { put(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_AT_KEY, AttributeValue.builder().s(it).build()) }
        }
        val queries = mutableListOf<QueryRequest>()
        every { client.queryPaginator(any<QueryRequest>()) } answers { QueryIterable(client, firstArg()) }
        every { client.query(capture(queries)) } returns QueryResponse.builder().items(
            row("conv-1#inst-1", "2026-11-06T00:00:00Z"),
            row("conv-2#inst-2", "2026-11-05T00:00:00Z"),
            row("conv-3#inst-1", null),
            row("conv-4#inst-11", "2026-11-04T00:00:00Z"),
        ).build()

        val uses = provider.getInstructionConversations("cust-1", "inst-1")

        assertEquals(
            listOf(InstructionConversationUse("conv-1", "2026-11-06T00:00:00Z"), InstructionConversationUse("conv-3", null)),
            uses
        )
        assertEquals(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE, queries.single().tableName())
        assertEquals("cust-1", queries.single().expressionAttributeValues()[":cid"]?.s())
    }

    @Test
    fun `repeat occurrence returns false without throwing`() = runTest {
        every { client.putItem(any<PutItemRequest>()) } throws
            ConditionalCheckFailedException.builder().message("already exists").build()

        val first = provider.markInstructionUsageSeenIfNew("cust-1", "conv-1", "inst-1")

        assertFalse(first)
    }

    @Test
    fun `increment uses atomic ADD for the counter and SET for lastUsedAt`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        provider.incrementInstructionUsage("cust-1", "inst-1", "2026-08-20T00:00:00Z")

        assertEquals(1, updates.size)
        val req = updates[0]
        assertEquals(DynamoDBConstants.INSTRUCTION_USAGE_TABLE, req.tableName())
        assertEquals("cust-1", req.key()[DynamoDBConstants.CUSTOMER_ID_KEY]?.s())
        assertEquals("inst-1", req.key()[DynamoDBConstants.INSTRUCTION_ID_KEY]?.s())
        val expr = req.updateExpression()!!
        assertTrue(expr.contains("ADD ${DynamoDBConstants.INSTRUCTION_USAGE_COUNT_KEY}"))
        assertTrue(expr.contains("SET ${DynamoDBConstants.INSTRUCTION_LAST_USED_KEY}"))
        assertEquals("1", req.expressionAttributeValues()[":one"]?.n())
        assertEquals("2026-08-20T00:00:00Z", req.expressionAttributeValues()[":ts"]?.s())
    }

    @Test
    fun `repeat occurrence must not increment when caller honors the contract`() = runTest {
        every { client.putItem(any<PutItemRequest>()) } throws
            ConditionalCheckFailedException.builder().message("already exists").build()
        every { client.updateItem(any<UpdateItemRequest>()) } returns UpdateItemResponse.builder().build()

        // The documented contract: only increment when markInstructionUsageSeenIfNew returns true.
        val first = provider.markInstructionUsageSeenIfNew("cust-1", "conv-1", "inst-1")
        if (first) provider.incrementInstructionUsage("cust-1", "inst-1", "now")

        verify(exactly = 0) { client.updateItem(any<UpdateItemRequest>()) }
    }
}
