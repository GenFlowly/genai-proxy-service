package com.genflowly.repository

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.DeveloperKeyUsage
import com.genflowly.models.Message
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A turn paid for through a developer API key is counted three times in the
 * rollup table: the usual LLM row, the key's dated row (last 30 days) and the
 * key's undated all-time row. App turns write only the LLM row.
 */
class UsageRollupDeveloperKeyTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = UsageRollupRepository(ddb, KotlinLogging.logger("UsageRollupDeveloperKeyTest"))

    private fun message(developerKeyId: String?) = Message(
        conversationId = "conv-1",
        text = "hello",
        client = "API",
        role = "assistant",
        customerId = "CU-1",
        systemPrompt = "",
        aiConfig = listOf(AIConfig(aiVendor = AIVendor.OPENAI, model = "gpt-5.4-nano")),
        previousMessageId = null,
        inputTokens = 10,
        outputTokens = 5,
        totalTokens = 15,
        costUsd = 0.0021,
        developerKeyId = developerKeyId,
        createdAt = "2026-11-17T19:00:00Z"
    )

    private fun captureUpdates(): MutableList<UpdateItemRequest> {
        val updates = mutableListOf<UpdateItemRequest>()
        every { ddb.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()
        return updates
    }

    @Test
    fun `an api key turn adds to the llm row, the key's dated row and its all-time row`() = runTest {
        val updates = captureUpdates()

        repo.incrementLlmUsage(message(developerKeyId = "KEY-1"))

        assertEquals(
            listOf(
                "2026-11-17#llm#OPENAI#gpt-5.4-nano",
                "2026-11-17#developer#apikey#KEY-1",
                "total#developer#apikey#KEY-1"
            ),
            updates.map { it.key().getValue("usageDate").s() }
        )
        updates.drop(1).forEach { update ->
            assertEquals("developer", update.expressionAttributeValues().getValue(":cat").s())
            assertEquals("KEY-1", update.expressionAttributeValues().getValue(":d3").s())
            assertEquals("0.0021", update.expressionAttributeValues().getValue(":cost").n())
            assertTrue(update.updateExpression().contains("ADD requestCount :one, costUsd :cost, totalTokens :tokens"))
        }
    }

    @Test
    fun `an app turn writes only the llm row`() = runTest {
        val updates = captureUpdates()

        repo.incrementLlmUsage(message(developerKeyId = null))

        assertEquals(listOf("2026-11-17#llm#OPENAI#gpt-5.4-nano"), updates.map { it.key().getValue("usageDate").s() })
    }

    @Test
    fun `all-time totals come from one prefix query on the customer's partition`() = runTest {
        val query = slot<QueryRequest>()
        every { ddb.query(capture(query)) } returns QueryResponse.builder().items(
            mapOf(
                "usageDate" to AttributeValue.builder().s("total#developer#apikey#KEY-1").build(),
                "requestCount" to AttributeValue.builder().n("12").build(),
                "costUsd" to AttributeValue.builder().n("1.37").build()
            ),
            mapOf(
                "usageDate" to AttributeValue.builder().s("total#developer#apikey#KEY-2").build(),
                "requestCount" to AttributeValue.builder().n("3").build()
            )
        ).build()

        val totals = repo.queryDeveloperKeyTotals("CU-1")

        assertEquals(
            mapOf("KEY-1" to DeveloperKeyUsage(12, 1.37), "KEY-2" to DeveloperKeyUsage(3, 0.0)),
            totals
        )
        assertEquals("#cid = :cid AND begins_with(#ud, :prefix)", query.captured.keyConditionExpression())
        assertEquals("total#developer#apikey#", query.captured.expressionAttributeValues().getValue(":prefix").s())
    }
}
