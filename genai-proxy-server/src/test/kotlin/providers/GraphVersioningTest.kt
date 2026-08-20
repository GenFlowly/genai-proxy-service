package com.genflowly.providers

import com.genflowly.DynamoDBConstants
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Characterization tests for the graph-node versioning scheme: v0 is the live
 * row, v1..vN are immutable history snapshots. Locks in next-version
 * computation, createdAt preservation, and rollback's field-level fallback
 * merge before the policy ascends from the provider into GraphService.
 */
class GraphVersioningTest {

    private val client = mockk<DynamoDbClient>()
    private val provider = DynamoDBProvider(client, mockk<KLogger>(relaxed = true))
    private val puts = mutableListOf<PutItemRequest>()

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()
    private fun n(v: Int): AttributeValue = AttributeValue.builder().n(v.toString()).build()

    private fun capturePuts() {
        puts.clear()
        every { client.putItem(capture(puts)) } returns PutItemResponse.builder().build()
    }

    @Test
    fun `create writes v1 history snapshot without customerId and v0 live row with latestVersion 1`() = runTest {
        capturePuts()

        provider.createCustomerGraphNode("cust-1", "node-1", "RETRIEVAL", "My node", "{}")

        assertEquals(2, puts.size)

        val history = puts[0].item()
        assertEquals("1", history[DynamoDBConstants.VERSION_KEY]?.n())
        assertEquals("node-1", history[DynamoDBConstants.NODE_ID_KEY]?.s())
        // History rows carry no customerId (sparse GSI exclusion) and no latestVersion
        assertFalse(history.containsKey(DynamoDBConstants.CUSTOMER_ID_KEY))
        assertFalse(history.containsKey(DynamoDBConstants.LATEST_VERSION_KEY))

        val live = puts[1].item()
        assertEquals("0", live[DynamoDBConstants.VERSION_KEY]?.n())
        assertEquals("cust-1", live[DynamoDBConstants.CUSTOMER_ID_KEY]?.s())
        assertEquals("1", live[DynamoDBConstants.LATEST_VERSION_KEY]?.n())
        assertEquals("RETRIEVAL", live[DynamoDBConstants.NODE_TYPE_KEY]?.s())
        assertEquals("My node", live[DynamoDBConstants.NODE_NAME_KEY]?.s())
        assertEquals("{}", live[DynamoDBConstants.NODE_CONFIG_KEY]?.s())
        assertTrue(live.containsKey("createdAt"))
        assertTrue(live.containsKey("updatedAt"))
    }

    private fun liveRow(latestVersion: Int, createdAt: String = "T-original") = mapOf(
        DynamoDBConstants.NODE_ID_KEY to s("node-1"),
        DynamoDBConstants.VERSION_KEY to n(0),
        DynamoDBConstants.CUSTOMER_ID_KEY to s("cust-1"),
        DynamoDBConstants.LATEST_VERSION_KEY to n(latestVersion),
        DynamoDBConstants.NODE_TYPE_KEY to s("OLD_TYPE"),
        DynamoDBConstants.NODE_NAME_KEY to s("Old name"),
        DynamoDBConstants.NODE_CONFIG_KEY to s("{\"old\":true}"),
        "createdAt" to s(createdAt)
    )

    @Test
    fun `update computes next version and preserves original createdAt on the live row`() = runTest {
        capturePuts()
        every { client.getItem(any<GetItemRequest>()) } returns
            GetItemResponse.builder().item(liveRow(latestVersion = 2)).build()

        val updated = provider.updateCustomerGraphNode("node-1", "NEW_TYPE", "New name", "{\"new\":true}")

        assertEquals(2, puts.size)
        val history = puts[0].item()
        assertEquals("3", history[DynamoDBConstants.VERSION_KEY]?.n())
        assertEquals("NEW_TYPE", history[DynamoDBConstants.NODE_TYPE_KEY]?.s())
        assertFalse(history.containsKey(DynamoDBConstants.CUSTOMER_ID_KEY))

        val live = puts[1].item()
        assertEquals("0", live[DynamoDBConstants.VERSION_KEY]?.n())
        assertEquals("3", live[DynamoDBConstants.LATEST_VERSION_KEY]?.n())
        assertEquals("T-original", live["createdAt"]?.s()) // creation time survives updates
        assertEquals("cust-1", live[DynamoDBConstants.CUSTOMER_ID_KEY]?.s())

        assertEquals("3", updated[DynamoDBConstants.LATEST_VERSION_KEY]?.n())
    }

    @Test
    fun `rollback restores target fields with fallback to current for missing attributes`() = runTest {
        capturePuts()
        every { client.getItem(any<GetItemRequest>()) } answers {
            val req = firstArg<GetItemRequest>()
            when (req.key()[DynamoDBConstants.VERSION_KEY]?.n()) {
                "1" -> GetItemResponse.builder().item(mapOf(
                    // Target snapshot lacks NODE_CONFIG_KEY — rollback must fall back to current's config
                    DynamoDBConstants.NODE_ID_KEY to s("node-1"),
                    DynamoDBConstants.VERSION_KEY to n(1),
                    DynamoDBConstants.NODE_TYPE_KEY to s("V1_TYPE"),
                    DynamoDBConstants.NODE_NAME_KEY to s("V1 name")
                )).build()
                "0" -> GetItemResponse.builder().item(liveRow(latestVersion = 2)).build()
                else -> GetItemResponse.builder().item(emptyMap()).build()
            }
        }

        provider.rollbackCustomerGraphNode("node-1", 1)

        assertEquals(2, puts.size)
        val history = puts[0].item()
        // Rollback writes a NEW snapshot (v3), not a rewind of the version counter
        assertEquals("3", history[DynamoDBConstants.VERSION_KEY]?.n())
        assertEquals("V1_TYPE", history[DynamoDBConstants.NODE_TYPE_KEY]?.s())
        assertEquals("V1 name", history[DynamoDBConstants.NODE_NAME_KEY]?.s())
        assertEquals("{\"old\":true}", history[DynamoDBConstants.NODE_CONFIG_KEY]?.s()) // fallback merge

        val live = puts[1].item()
        assertEquals("0", live[DynamoDBConstants.VERSION_KEY]?.n())
        assertEquals("3", live[DynamoDBConstants.LATEST_VERSION_KEY]?.n())
        assertEquals("V1_TYPE", live[DynamoDBConstants.NODE_TYPE_KEY]?.s())
        assertEquals("T-original", live["createdAt"]?.s())
    }

    @Test
    fun `rollback to a nonexistent version throws IllegalArgumentException`() = runTest {
        capturePuts()
        every { client.getItem(any<GetItemRequest>()) } returns
            GetItemResponse.builder().item(emptyMap()).build()

        assertFailsWith<IllegalArgumentException> {
            provider.rollbackCustomerGraphNode("node-1", 99)
        }
        assertEquals(0, puts.size)
    }

    @Test
    fun `soft-deleted live row reads as null`() = runTest {
        every { client.getItem(any<GetItemRequest>()) } returns
            GetItemResponse.builder().item(
                liveRow(latestVersion = 1) + mapOf(DynamoDBConstants.DELETED_AT_KEY to s("T-deleted"))
            ).build()

        assertNull(provider.getCustomerGraphNode("node-1"))
    }
}
