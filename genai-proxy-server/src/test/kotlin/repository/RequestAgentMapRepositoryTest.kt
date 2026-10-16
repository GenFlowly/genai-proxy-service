package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RequestAgentMapRepositoryTest {

    private val client = mockk<DynamoDbClient>()
    private val repository = RequestAgentMapRepository(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    @Test
    fun `getMapEntry maps the item and keys the lookup by scope and requestType`() = runTest {
        val gets = mutableListOf<GetItemRequest>()
        every { client.getItem(capture(gets)) } returns GetItemResponse.builder()
            .item(mapOf(
                DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY to s(SYSTEM_SCOPE),
                DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY to s("INSTRUCTION_PERSONA"),
                DynamoDBConstants.REQUEST_AGENT_MAP_KEY to s("InstructionRequestDefault"),
                DynamoDBConstants.REQUEST_AGENT_GRAPH_ID_KEY to s("GRP1"),
                DynamoDBConstants.REQUEST_AGENT_ENABLED_KEY to AttributeValue.builder().bool(true).build(),
                DynamoDBConstants.REQUEST_AGENT_UPDATED_BY_KEY to s("CUADMIN"),
                "updatedAt" to s("2026-08-22T00:00:00Z")
            ))
            .build()

        val entry = repository.getMapEntry(SYSTEM_SCOPE, "INSTRUCTION_PERSONA")!!

        assertEquals("InstructionRequestDefault", entry.mapKey)
        assertEquals("GRP1", entry.graphId)
        assertTrue(entry.enabled)
        assertEquals("CUADMIN", entry.updatedBy)

        val key = gets.single().key()
        assertEquals(SYSTEM_SCOPE, key[DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY]?.s())
        assertEquals("INSTRUCTION_PERSONA", key[DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY]?.s())
    }

    @Test
    fun `getMapEntry returns null when the item is absent`() = runTest {
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().build()
        assertNull(repository.getMapEntry(SYSTEM_SCOPE, "NOTE_TITLE"))
    }

    @Test
    fun `listMapEntries aliases the reserved keyword scope in the query`() = runTest {
        val queries = mutableListOf<software.amazon.awssdk.services.dynamodb.model.QueryRequest>()
        every { client.query(capture(queries)) } returns
            software.amazon.awssdk.services.dynamodb.model.QueryResponse.builder()
                .items(
                    mapOf(
                        DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY to s(SYSTEM_SCOPE),
                        DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY to s("NOTE_TITLE"),
                        DynamoDBConstants.REQUEST_AGENT_GRAPH_ID_KEY to s("GRP1")
                    )
                )
                .build()

        val entries = repository.listMapEntries(SYSTEM_SCOPE)

        assertTrue(entries.single().graphId == "GRP1")
        val query = queries.single()
        // "scope" is a DynamoDB reserved keyword — the raw name in the
        // expression is rejected by DynamoDB with a 400
        assertEquals("#scope = :scope", query.keyConditionExpression())
        assertEquals(
            DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY,
            query.expressionAttributeNames()["#scope"]
        )
    }

    @Test
    fun `putMapEntry upserts all fields and preserves createdAt`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        repository.putMapEntry(
            RequestAgentMapEntry(
                scope = SYSTEM_SCOPE,
                requestType = "NOTE_TITLE",
                mapKey = "NoteTitleCustom",
                graphId = "GRP9",
                enabled = false,
                updatedBy = "CUADMIN"
            )
        )

        val request = updates.single()
        assertEquals(DynamoDBConstants.REQUEST_AGENT_MAP_TABLE, request.tableName())
        assertEquals("NOTE_TITLE", request.key()[DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY]?.s())
        val values = request.expressionAttributeValues()
        assertEquals("NoteTitleCustom", values[":mapKey"]?.s())
        assertEquals("GRP9", values[":graphId"]?.s())
        assertEquals(false, values[":enabled"]?.bool())
        // createdAt only set when absent, so a re-point keeps the original
        assertTrue(request.updateExpression().contains("if_not_exists(createdAt"))
    }

    private fun seedEntry() = RequestAgentMapEntry(
        scope = SYSTEM_SCOPE,
        requestType = "MEMORY_EXTRACTION",
        mapKey = "MemoryExtractionDefault",
        graphId = "GRP7",
        enabled = true,
        updatedBy = "system-bootstrap"
    )

    @Test
    fun `putMapEntryIfAbsent aliases the reserved keyword scope in its condition`() = runTest {
        val puts = mutableListOf<software.amazon.awssdk.services.dynamodb.model.PutItemRequest>()
        every { client.putItem(capture(puts)) } returns
            software.amazon.awssdk.services.dynamodb.model.PutItemResponse.builder().build()

        assertTrue(repository.putMapEntryIfAbsent(seedEntry()))

        val request = puts.single()
        // A raw "scope" in the ConditionExpression is a DynamoDB 400 (reserved
        // keyword) — this exact miss kept MEMORY_EXTRACTION from ever seeding.
        assertEquals("attribute_not_exists(#scope)", request.conditionExpression())
        assertEquals(
            DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY,
            request.expressionAttributeNames()["#scope"]
        )
        assertEquals("MEMORY_EXTRACTION", request.item()[DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY]?.s())
    }

    @Test
    fun `putMapEntryIfAbsent returns false when the row already exists`() = runTest {
        every { client.putItem(any<software.amazon.awssdk.services.dynamodb.model.PutItemRequest>()) } throws
            software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException.builder().build()

        assertFalse(repository.putMapEntryIfAbsent(seedEntry()))
    }
}
