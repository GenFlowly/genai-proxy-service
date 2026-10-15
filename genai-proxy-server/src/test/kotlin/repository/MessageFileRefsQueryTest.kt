package com.genflowly.repository

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The retention paths read a conversation's file references with a
 * projection (never text or thinking steps) and follow every Query page.
 */
class MessageFileRefsQueryTest {

    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(client, mockk<KLogger>(relaxed = true))

    private fun s(v: String) = AttributeValue.builder().s(v).build()
    private fun n(v: String) = AttributeValue.builder().n(v).build()

    private fun row(id: String, extra: Map<String, AttributeValue> = emptyMap()) = mapOf(
        "conversationId" to s("conv-1"),
        "messageId" to s(id),
        "customerId" to s("cust-1"),
        "role" to s("assistant")
    ) + extra

    @Test
    fun `every page is read with a projection that aliases reserved words`() = runTest {
        val requests = mutableListOf<QueryRequest>()
        val pageOneEnd = mapOf("conversationId" to s("conv-1"), "messageId" to s("m1"))
        every { client.query(capture(requests)) } answers {
            if (requests.size == 1) {
                QueryResponse.builder()
                    .items(listOf(row("m1", mapOf(
                        "attachments" to AttributeValue.builder().l(
                            AttributeValue.builder().m(mapOf(
                                "attachmentId" to s("pdf-1"),
                                "s3Key" to s("customers/cust-1/attachments/pdf-1"),
                                "mediaType" to s("application/pdf"),
                                "sourceKey" to s("customers/cust-1/attachments/pdf-1.source.md")
                            )).build()
                        ).build(),
                        "runId" to s("run_1"),
                        "fsNamespace" to s("ns-12345678"),
                        "claimPending" to n("1")
                    ))))
                    .lastEvaluatedKey(pageOneEnd)
                    .build()
            } else {
                QueryResponse.builder()
                    .items(listOf(row("m2", mapOf("toolResultsJson" to s("[]")))))
                    .build()
            }
        }

        val refs = repository.getMessageFileRefs("conv-1")

        assertEquals(listOf("m1", "m2"), refs.map { it.messageId })
        assertEquals(2, requests.size)
        assertEquals(pageOneEnd, requests[1].exclusiveStartKey())
        for (request in requests) {
            val projection = request.projectionExpression()
            assertTrue(projection.contains("#role") && !projection.contains(" role"), projection)
            assertEquals("role", request.expressionAttributeNames()["#role"])
            assertFalse(request.expressionAttributeNames().containsValue("text"))
            assertFalse(request.expressionAttributeNames().containsValue("thinkingStepsJson"))
        }

        val first = refs[0]
        assertEquals("customers/cust-1/attachments/pdf-1.source.md", first.attachments.single().sourceKey)
        assertEquals("run_1", first.runId)
        assertEquals("ns-12345678", first.fsNamespace)
        assertTrue(first.claimPending)
        assertFalse(refs[1].claimPending)
        assertEquals("[]", refs[1].toolResultsJson)
        assertNull(refs[1].runId)
    }
}
