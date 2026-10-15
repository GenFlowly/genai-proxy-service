package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * getMessagesForConversation reads the whole Message partition. One Query page
 * stops at 1 MB (2-3 messages with large thinking steps), so it must follow
 * LastEvaluatedKey with exclusiveStartKey until no key comes back.
 */
class ConversationMessagesPaginationTest {

    private val conv = "conv-1"
    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    private fun messageItem(id: String, seq: Int) = mapOf(
        DynamoDBConstants.CONVERSATION_ID_KEY to s(conv),
        DynamoDBConstants.MESSAGE_ID_SORT_KEY to s(id),
        DynamoDBConstants.CUSTOMER_ID_KEY to s("cust-1"),
        "sequence" to AttributeValue.builder().n(seq.toString()).build(),
        "client" to s("REACT_APP"),
        "role" to s(if (seq % 2 == 1) "user" else "assistant"),
        "text" to s("text $id"),
        "systemPrompt" to s(""),
        "aiConfig" to AttributeValue.builder().l(emptyList()).build()
    )

    private fun lastKey(id: String) = mapOf(
        DynamoDBConstants.CONVERSATION_ID_KEY to s(conv),
        DynamoDBConstants.MESSAGE_ID_SORT_KEY to s(id)
    )

    @Test
    fun `all three Query pages are read, each resuming from the previous LastEvaluatedKey`() = runTest {
        val requests = mutableListOf<QueryRequest>()
        every { client.query(capture(requests)) } returnsMany listOf(
            QueryResponse.builder()
                .items(listOf(messageItem("m1", 1), messageItem("m2", 2)))
                .lastEvaluatedKey(lastKey("m2"))
                .build(),
            QueryResponse.builder()
                .items(listOf(messageItem("m3", 3)))
                .lastEvaluatedKey(lastKey("m3"))
                .build(),
            QueryResponse.builder()
                .items(listOf(messageItem("m4", 4), messageItem("m5", 5)))
                .build()
        )

        val messages = repository.getMessagesForConversation(conv)

        assertEquals(listOf("m1", "m2", "m3", "m4", "m5"), messages.map { it.messageId })
        verify(exactly = 3) { client.query(any<QueryRequest>()) }
        assertFalse(requests[0].hasExclusiveStartKey())
        assertEquals(lastKey("m2"), requests[1].exclusiveStartKey())
        assertEquals(lastKey("m3"), requests[2].exclusiveStartKey())
        requests.forEach {
            assertEquals(DynamoDBConstants.MESSAGE_TABLE, it.tableName())
            assertEquals(conv, it.expressionAttributeValues()[":cid"]?.s())
        }
    }

    @Test
    fun `an empty LastEvaluatedKey ends the read`() = runTest {
        every { client.query(any<QueryRequest>()) } returns QueryResponse.builder()
            .items(listOf(messageItem("m1", 1)))
            .lastEvaluatedKey(emptyMap())
            .build()

        val messages = repository.getMessagesForConversation(conv)

        assertEquals(listOf("m1"), messages.map { it.messageId })
        verify(exactly = 1) { client.query(any<QueryRequest>()) }
    }
}
