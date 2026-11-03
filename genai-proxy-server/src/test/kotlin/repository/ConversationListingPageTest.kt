package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The listing GSI's Limit counts rows read before the archived filter, so one read can
 * come back short or empty with more behind it. The repository keeps reading until the
 * page is full or the rows run out.
 */
class ConversationListingPageTest {

    private val cust = "cust-1"
    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(
        client, mockk<KLogger>(relaxed = true), mockk<UsageRollupRepository>(relaxed = true)
    )

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    private fun row(id: String) = mapOf(
        DynamoDBConstants.CUSTOMER_ID_KEY to s(cust),
        DynamoDBConstants.CONVERSATION_ID_KEY to s(id),
        "updatedAt" to s("2026-11-01T00:00:00Z")
    )

    private fun key(id: String) = mapOf(
        DynamoDBConstants.CUSTOMER_ID_KEY to s(cust),
        DynamoDBConstants.CONVERSATION_ID_KEY to s(id),
        "updatedAt" to s("2026-11-01T00:00:00Z")
    )

    private fun read(ids: List<String>, nextKey: String? = null): QueryResponse {
        val builder = QueryResponse.builder().items(ids.map(::row))
        nextKey?.let { builder.lastEvaluatedKey(key(it)) }
        return builder.build()
    }

    /** Serves [reads] to the listing GSI in order and records each listing request. */
    private fun stub(vararg reads: QueryResponse): MutableList<QueryRequest> {
        val requests = mutableListOf<QueryRequest>()
        var next = 0
        every { client.query(any<QueryRequest>()) } answers {
            val request = firstArg<QueryRequest>()
            if (request.indexName() == DynamoDBConstants.CONVERSATION_CUSTOMER_UPDATED_GSI_KEY) {
                requests += request
                reads[minOf(next++, reads.lastIndex)]
            } else {
                QueryResponse.builder().items(emptyList()).build()
            }
        }
        every { client.batchGetItem(any<BatchGetItemRequest>()) } returns
            BatchGetItemResponse.builder().responses(emptyMap()).build()
        return requests
    }

    @Test
    fun `reads past an all-archived read to fill the page`() = runTest {
        val requests = stub(
            read(emptyList(), nextKey = "archived-2"),
            read(listOf("conv-1", "conv-2"), nextKey = "conv-2")
        )

        val page = repository.getConversationsByCustomerPaginated(cust, pageSize = 2)

        assertEquals(listOf("conv-1", "conv-2"), page.conversations.map { it.conversationId })
        assertEquals(2, requests.size)
        assertEquals("archived-2", requests[1].exclusiveStartKey()[DynamoDBConstants.CONVERSATION_ID_KEY]?.s())
    }

    @Test
    fun `asks only for the rows still missing, so the key stays on the last row returned`() = runTest {
        val requests = stub(
            read(listOf("conv-1"), nextKey = "archived-1"),
            read(listOf("conv-2"), nextKey = "conv-2")
        )

        val page = repository.getConversationsByCustomerPaginated(cust, pageSize = 2)

        assertEquals(listOf(2, 1), requests.map { it.limit() })
        val token = Json.decodeFromString<Map<String, String>>(page.lastEvaluatedKey!!)
        assertEquals("conv-2", token[DynamoDBConstants.CONVERSATION_ID_KEY])
    }

    @Test
    fun `stops when the rows run out and reports no next page`() = runTest {
        stub(read(listOf("conv-1"), nextKey = "archived-1"), read(emptyList()))

        val page = repository.getConversationsByCustomerPaginated(cust, pageSize = 5)

        assertEquals(listOf("conv-1"), page.conversations.map { it.conversationId })
        assertNull(page.lastEvaluatedKey)
    }

    @Test
    fun `a long run of archived rows ends in a short page with its key`() = runTest {
        val requests = stub(read(emptyList(), nextKey = "archived"))

        val page = repository.getConversationsByCustomerPaginated(cust, pageSize = 5)

        assertEquals(20, requests.size)
        assertEquals(emptyList(), page.conversations)
        val token = Json.decodeFromString<Map<String, String>>(page.lastEvaluatedKey!!)
        assertEquals("archived", token[DynamoDBConstants.CONVERSATION_ID_KEY])
    }
}
