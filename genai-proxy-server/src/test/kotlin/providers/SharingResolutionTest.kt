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
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Characterization tests for the sharing→users resolution: PUBLIC pseudo-profile
 * synthesis, role propagation onto returned profiles, and dropping shares whose
 * profile no longer exists. Locks in behavior before this logic ascends from the
 * provider into the domain services.
 */
class SharingResolutionTest {

    private val client = mockk<DynamoDbClient>()
    private val provider = DynamoDBProvider(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()
    private fun b(v: Boolean): AttributeValue = AttributeValue.builder().bool(v).build()

    private fun shareRow(sharedWith: String, entityKey: String, entityId: String, role: String?) = buildMap {
        put(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, s(sharedWith))
        put(entityKey, s(entityId))
        role?.let { put(DynamoDBConstants.ENTITY_ROLE_KEY, s(it)) }
    }

    private fun profileRow(customerId: String, name: String) = mapOf(
        "customerId" to s(customerId),
        "sub" to s("auth0|$customerId"),
        "client" to s("REACT_APP"),
        "email" to s("$customerId@example.com"),
        "name" to s(name),
        "username" to s("$name-abc123"),
        "isDiscoverable" to b(true)
    )

    /** Stubs the share-table query plus per-customer profile GSI queries. */
    private fun stubQueries(shareTable: String, shareRows: List<Map<String, AttributeValue>>, profiles: Map<String, Map<String, AttributeValue>>) {
        every { client.query(any<QueryRequest>()) } answers {
            val req = firstArg<QueryRequest>()
            when (req.tableName()) {
                shareTable -> QueryResponse.builder().items(shareRows).build()
                DynamoDBConstants.CUSTOMER_PROFILE_TABLE -> {
                    val cid = req.expressionAttributeValues()[":cid"]?.s()
                    val profile = profiles[cid]
                    QueryResponse.builder().items(listOfNotNull(profile)).build()
                }
                else -> QueryResponse.builder().items(emptyList()).build()
            }
        }
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(emptyMap()).build()
    }

    @Test
    fun `instruction shares - PUBLIC synthesized, roles propagated, missing profiles dropped`() = runTest {
        stubQueries(
            shareTable = DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE,
            shareRows = listOf(
                shareRow("PUBLIC", DynamoDBConstants.INSTRUCTION_ID_KEY, "inst-1", role = "EDIT"),
                shareRow("cust-2", DynamoDBConstants.INSTRUCTION_ID_KEY, "inst-1", role = "VIEW"),
                shareRow("cust-gone", DynamoDBConstants.INSTRUCTION_ID_KEY, "inst-1", role = "VIEW")
            ),
            profiles = mapOf("cust-2" to profileRow("cust-2", "alice"))
        )

        val users = provider.getUsersWithSharedEntity("inst-1")

        assertEquals(2, users.size)

        val public = users[0]
        assertEquals("PUBLIC", public.customerId)
        assertEquals("Public", public.name)
        assertEquals("Public", public.username)
        assertEquals(true, public.isDiscoverable)
        assertEquals("EDIT", public.role)
        assertEquals("", public.sub)

        val alice = users[1]
        assertEquals("cust-2", alice.customerId)
        assertEquals("alice", alice.name)
        assertEquals("VIEW", alice.role)
        assertEquals("cust-2@example.com", alice.email)
    }

    @Test
    fun `conversation shares - same synthesis and role defaulting to VIEW`() = runTest {
        stubQueries(
            shareTable = DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
            shareRows = listOf(
                shareRow("PUBLIC", DynamoDBConstants.CONVERSATION_ID_KEY, "conv-1", role = null), // no role attr
                shareRow("cust-2", DynamoDBConstants.CONVERSATION_ID_KEY, "conv-1", role = "EDIT")
            ),
            profiles = mapOf("cust-2" to profileRow("cust-2", "bob"))
        )

        val users = provider.getUsersWithSharedConversation("conv-1")

        assertEquals(2, users.size)
        assertEquals("PUBLIC", users[0].customerId)
        assertEquals("VIEW", users[0].role) // missing role attribute defaults to VIEW
        assertEquals("EDIT", users[1].role)
        assertEquals("bob", users[1].name)
    }

    @Test
    fun `shared entity ids include role pairs with VIEW default and optional prefix filter`() = runTest {
        stubQueries(
            shareTable = DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE,
            shareRows = listOf(
                shareRow("cust-1", DynamoDBConstants.INSTRUCTION_ID_KEY, "inst-a", role = "EDIT"),
                shareRow("cust-1", DynamoDBConstants.INSTRUCTION_ID_KEY, "inst-b", role = null),
                shareRow("cust-1", DynamoDBConstants.INSTRUCTION_ID_KEY, "note-c", role = "VIEW")
            ),
            profiles = emptyMap()
        )

        val all = provider.getSharedEntityIdsForCustomer("cust-1")
        assertEquals(listOf("inst-a" to "EDIT", "inst-b" to "VIEW", "note-c" to "VIEW"), all)

        val onlyInst = provider.getSharedEntityIdsForCustomer("cust-1", prefix = "inst-")
        assertTrue(onlyInst.all { it.first.startsWith("inst-") })
        assertEquals(2, onlyInst.size)
    }

    @Test
    fun `getConversationShare returns role or null and ignores PUBLIC`() = runTest {
        every { client.getItem(any<GetItemRequest>()) } answers {
            val req = firstArg<GetItemRequest>()
            val cid = req.key()[DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s()
            if (cid == "cust-2") {
                GetItemResponse.builder().item(mapOf(DynamoDBConstants.ENTITY_ROLE_KEY to s("EDIT"))).build()
            } else {
                GetItemResponse.builder().item(emptyMap()).build()
            }
        }

        assertEquals("EDIT", provider.getConversationShare("conv-1", "cust-2"))
        assertEquals(null, provider.getConversationShare("conv-1", "cust-other"))
    }
}
