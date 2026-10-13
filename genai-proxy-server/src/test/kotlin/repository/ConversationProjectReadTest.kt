package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.models.Conversation
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemResponse
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * projectId read paths against a mocked DynamoDbClient. The paginated listing
 * queries a GSI whose INCLUDE projection does NOT carry projectId, so the
 * repository backfills it with one BatchGetItem on the base table per page;
 * the pinned query reads the base table and maps it directly.
 */
class ConversationProjectReadTest {

    private val cust = "cust-1"
    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    private fun conversationItem(id: String, projectId: String? = null) = buildMap {
        put(DynamoDBConstants.CUSTOMER_ID_KEY, s(cust))
        put(DynamoDBConstants.CONVERSATION_ID_KEY, s(id))
        put("title", s("t-$id"))
        projectId?.let { put(DynamoDBConstants.PROJECT_ID_KEY, s(it)) }
    }

    @Test
    fun `paginated read merges projectIds fetched from the base table`() = runTest {
        every { client.query(any<QueryRequest>()) } answers {
            val req = firstArg<QueryRequest>()
            when (req.indexName()) {
                // Listing GSI page: no projectId attribute, as in production
                // (the INCLUDE projection omits it)
                DynamoDBConstants.CONVERSATION_CUSTOMER_UPDATED_GSI_KEY ->
                    QueryResponse.builder()
                        .items(listOf(conversationItem("conv-1"), conversationItem("conv-2")))
                        .build()
                // Per-conversation Message-table vendor lookups — empty
                else -> QueryResponse.builder().items(emptyList()).build()
            }
        }
        every { client.batchGetItem(any<BatchGetItemRequest>()) } returns
            BatchGetItemResponse.builder()
                .responses(
                    mapOf(
                        DynamoDBConstants.CONVERSATION_TABLE to listOf(
                            conversationItem("conv-1", projectId = "PRJ1"),
                            conversationItem("conv-2")
                        )
                    )
                )
                .build()

        val page = repository.getConversationsByCustomerPaginated(cust)

        assertEquals("PRJ1", page.conversations.first { it.conversationId == "conv-1" }.projectId)
        assertNull(page.conversations.first { it.conversationId == "conv-2" }.projectId)
    }

    @Test
    fun `pinned read maps projectId straight off the base-table item`() = runTest {
        every { client.query(any<QueryRequest>()) } answers {
            val req = firstArg<QueryRequest>()
            if (req.tableName() == DynamoDBConstants.CONVERSATION_TABLE) {
                QueryResponse.builder()
                    .items(
                        listOf(
                            conversationItem("conv-1", projectId = "PRJ1") +
                                mapOf(DynamoDBConstants.PINNED_AT_KEY to s("2026-01-01T00:00:00Z"))
                        )
                    )
                    .build()
            } else {
                QueryResponse.builder().items(emptyList()).build()
            }
        }

        val pinned = repository.getPinnedConversationsByCustomer(cust)

        assertEquals("PRJ1", pinned.single().projectId)
    }

    @Test
    fun `project membership query follows pagination to the end`() = runTest {
        val page1 = QueryResponse.builder()
            .items(listOf(conversationItem("conv-1", projectId = "PRJ1")))
            .lastEvaluatedKey(
                mapOf(
                    DynamoDBConstants.CUSTOMER_ID_KEY to s(cust),
                    DynamoDBConstants.CONVERSATION_ID_KEY to s("conv-1")
                )
            )
            .build()
        val page2 = QueryResponse.builder()
            .items(listOf(conversationItem("conv-2", projectId = "PRJ1")))
            .build()
        every { client.query(any<QueryRequest>()) } returnsMany listOf(page1, page2)

        val ids = repository.getConversationIdsByProject(cust, "PRJ1")

        assertEquals(listOf("conv-1", "conv-2"), ids)
    }

    @Test
    fun `createConversation stamps projectId only when present`() = runTest {
        val requests = mutableListOf<PutItemRequest>()
        every { client.putItem(capture(requests)) } returns PutItemResponse.builder().build()

        repository.createConversation(Conversation(customerId = cust, client = "REACT_APP", projectId = "PRJ1"))
        repository.createConversation(Conversation(customerId = cust, client = "REACT_APP"))

        assertEquals("PRJ1", requests[0].item()[DynamoDBConstants.PROJECT_ID_KEY]?.s())
        assertFalse(requests[1].item().containsKey(DynamoDBConstants.PROJECT_ID_KEY))
    }
}
