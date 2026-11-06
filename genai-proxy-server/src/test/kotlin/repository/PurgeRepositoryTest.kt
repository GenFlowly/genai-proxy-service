package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemRequest
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemResponse
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.DeleteItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.paginators.QueryIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The deletion DynamoDB layer over a mocked client: which keys each delete
 * targets, BatchWriteItem's limit of 25 and its unprocessed items, paginated
 * reads, and the ownership condition on the profile and username.
 */
class PurgeRepositoryTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = PurgeRepository(ddb, KotlinLogging.logger("PurgeRepositoryTest"))
    private val writes = mutableListOf<BatchWriteItemRequest>()
    private val queries = mutableListOf<QueryRequest>()

    /** Query results by "table/index"; a list of pages, each a list of items. */
    private val pages = mutableMapOf<String, List<List<Map<String, AttributeValue>>>>()

    init {
        every { ddb.queryPaginator(any<QueryRequest>()) } answers { QueryIterable(ddb, firstArg()) }
        every { ddb.query(any<QueryRequest>()) } answers {
            val request = firstArg<QueryRequest>()
            queries += request
            val all = pages["${request.tableName()}/${request.indexName() ?: ""}"].orEmpty()
            val index = request.exclusiveStartKey()?.get("page")?.n()?.toInt() ?: 0
            val page = all.getOrElse(index) { emptyList() }
            QueryResponse.builder()
                .items(page)
                .apply { if (index + 1 < all.size) lastEvaluatedKey(mapOf("page" to n(index + 1))) }
                .build()
        }
        every { ddb.batchWriteItem(any<BatchWriteItemRequest>()) } answers {
            writes += firstArg<BatchWriteItemRequest>()
            BatchWriteItemResponse.builder().build()
        }
    }

    private fun s(value: String) = AttributeValue.builder().s(value).build()
    private fun n(value: Int) = AttributeValue.builder().n(value.toString()).build()

    private fun deletedKeys(table: String) =
        writes.flatMap { it.requestItems()[table].orEmpty() }.map { it.deleteRequest().key() }

    @Test
    fun `deleting a conversation removes every share, its messages and its row`() = runTest {
        pages["${DynamoDBConstants.SHARED_CONVERSATIONS_TABLE}/${DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY}"] = listOf(listOf(
            mapOf("sharedWithCustomerId" to s("PUBLIC"), "conversationId" to s("C1")),
            mapOf("sharedWithCustomerId" to s("CU9"), "conversationId" to s("C1")),
        ))
        pages["${DynamoDBConstants.MESSAGE_TABLE}/"] = listOf(
            (1..20).map { mapOf("conversationId" to s("C1"), "messageId" to s("M$it")) },
            (21..30).map { mapOf("conversationId" to s("C1"), "messageId" to s("M$it")) },
        )

        val deleted = repo.deleteConversation("CU1", "C1")

        assertEquals(33, deleted)
        assertEquals(
            listOf("PUBLIC", "CU9"),
            deletedKeys(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE).map { it.getValue("sharedWithCustomerId").s() }
        )
        val messages = writes.filter { it.requestItems().containsKey(DynamoDBConstants.MESSAGE_TABLE) }
        assertEquals(listOf(25, 5), messages.map { it.requestItems().getValue(DynamoDBConstants.MESSAGE_TABLE).size })
        assertEquals(
            listOf(mapOf("customerId" to s("CU1"), "conversationId" to s("C1"))),
            deletedKeys(DynamoDBConstants.CONVERSATION_TABLE)
        )
    }

    @Test
    fun `reads ask only for the key attributes and page through every result`() = runTest {
        pages["${DynamoDBConstants.CONVERSATION_TABLE}/"] = listOf(
            listOf(mapOf("customerId" to s("CU1"), "conversationId" to s("C1"))),
            listOf(mapOf("customerId" to s("CU1"), "conversationId" to s("C2"))),
        )

        assertEquals(listOf("C1", "C2"), repo.ownedConversationIds("CU1"))

        val first = queries.first()
        assertEquals("#a0", first.projectionExpression())
        assertEquals("conversationId", first.expressionAttributeNames()["#a0"])
        assertEquals("CU1", first.expressionAttributeValues()[":v"]?.s())
    }

    @Test
    fun `a customer partition is deleted by its full key`() = runTest {
        pages["${DynamoDBConstants.CUSTOMER_NOTES_TABLE}/"] = listOf(listOf(
            mapOf("customerId" to s("CU1"), "noteKey" to s("N1"), "noteValue" to s("ignored")),
        ))

        repo.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_NOTES_TABLE, DynamoDBConstants.NOTE_KEY)

        assertEquals(
            listOf(mapOf("customerId" to s("CU1"), "noteKey" to s("N1"))),
            deletedKeys(DynamoDBConstants.CUSTOMER_NOTES_TABLE)
        )
    }

    @Test
    fun `items DynamoDB leaves unprocessed are retried`() = runTest {
        pages["${DynamoDBConstants.CUSTOMER_MEMORY_TABLE}/"] = listOf(listOf(
            mapOf("customerId" to s("CU1"), "memoryId" to s("MEM#1")),
        ))
        var calls = 0
        every { ddb.batchWriteItem(any<BatchWriteItemRequest>()) } answers {
            val request = firstArg<BatchWriteItemRequest>()
            writes += request
            calls++
            BatchWriteItemResponse.builder()
                .apply { if (calls == 1) unprocessedItems(request.requestItems()) }
                .build()
        }

        repo.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_MEMORY_TABLE, DynamoDBConstants.MEMORY_ID_KEY)

        assertEquals(2, calls)
    }

    @Test
    fun `deletes that stay unprocessed fail instead of reporting success`() = runTest {
        pages["${DynamoDBConstants.CUSTOMER_MEMORY_TABLE}/"] = listOf(listOf(
            mapOf("customerId" to s("CU1"), "memoryId" to s("MEM#1")),
        ))
        every { ddb.batchWriteItem(any<BatchWriteItemRequest>()) } answers {
            BatchWriteItemResponse.builder().unprocessedItems(firstArg<BatchWriteItemRequest>().requestItems()).build()
        }

        assertFailsWith<IllegalStateException> {
            repo.deleteCustomerPartition("CU1", DynamoDBConstants.CUSTOMER_MEMORY_TABLE, DynamoDBConstants.MEMORY_ID_KEY)
        }
    }

    @Test
    fun `the profile and username are deleted only while they still belong to the customer`() = runTest {
        val request = slot<DeleteItemRequest>()
        every { ddb.deleteItem(capture(request)) } returns DeleteItemResponse.builder().build()

        assertTrue(repo.deleteProfile("auth0|u1", "REACT_APP", "CU1"))
        assertEquals("#cid = :cid", request.captured.conditionExpression())
        assertEquals("CU1", request.captured.expressionAttributeValues()[":cid"]?.s())
        assertEquals(mapOf("sub" to s("auth0|u1"), "client" to s("REACT_APP")), request.captured.key())

        every { ddb.deleteItem(any<DeleteItemRequest>()) } throws ConditionalCheckFailedException.builder().build()
        assertFalse(repo.deleteUsername("neel-abc123", "CU1"))
    }

    @Test
    fun `an instruction goes with every version and every share`() = runTest {
        pages["${DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE}/${DynamoDBConstants.SHARED_INSTRUCTIONS_GSI_KEY}"] = listOf(listOf(
            mapOf("sharedWithCustomerId" to s("PUBLIC"), "instructionId" to s("I1")),
        ))
        pages["${DynamoDBConstants.INSTRUCTION_TABLE}/"] = listOf(listOf(
            mapOf("instructionId" to s("I1"), "version" to n(1)),
            mapOf("instructionId" to s("I1"), "version" to n(2)),
        ))

        assertEquals(3, repo.deleteInstruction("I1"))
        assertEquals(listOf(1, 2), deletedKeys(DynamoDBConstants.INSTRUCTION_TABLE).map { it.getValue("version").n().toInt() })
    }

    @Test
    fun `the files a conversation names come from attachments and tool results`() = runTest {
        pages["${DynamoDBConstants.MESSAGE_TABLE}/"] = listOf(listOf(
            mapOf("attachments" to AttributeValue.builder().l(
                AttributeValue.builder().m(mapOf("s3Key" to s("customers/CU1/attachments/up-1"))).build()
            ).build()),
            mapOf("toolResultsJson" to s("""[{"images":[{"s3Key":"customers/CU1/attachments/pdf-1.pdf"}]}] see customers/CU1/agent-fs/x/y""")),
            mapOf("text" to s("no files")),
        ))

        assertEquals(
            setOf("customers/CU1/attachments/up-1", "customers/CU1/attachments/pdf-1.pdf"),
            repo.messageFileKeys("C1")
        )
    }

    @Test
    fun `only the conversation's own rows waiting for the vector DB are deleted`() = runTest {
        pages["${DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE}/"] = listOf(listOf(
            mapOf("customerId" to s("CU1"), "itemKey" to s("conversation#M1"), "conversationId" to s("C1")),
            mapOf("customerId" to s("CU1"), "itemKey" to s("conversation#M7"), "conversationId" to s("C2")),
        ))

        assertEquals(1, repo.deletePendingVectorRows("CU1", "C1"))

        assertEquals(
            listOf(mapOf("customerId" to s("CU1"), "itemKey" to s("conversation#M1"))),
            deletedKeys(DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE)
        )
        val read = queries.single()
        assertTrue(read.keyConditionExpression().contains("begins_with"))
        assertEquals("conversation#", read.expressionAttributeValues()[":prefix"]?.s())
    }

    @Test
    fun `instruction usage rows are found by the conversation's key prefix`() = runTest {
        pages["${DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE}/"] = listOf(listOf(
            mapOf("customerId" to s("CU1"), "convInstKey" to s("C1#I1")),
        ))

        repo.deleteInstructionUsageSeen("CU1", "C1")

        assertEquals("C1#", queries.single().expressionAttributeValues()[":prefix"]?.s())
        assertEquals(
            listOf(mapOf("customerId" to s("CU1"), "convInstKey" to s("C1#I1"))),
            deletedKeys(DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE)
        )
    }

    @Test
    fun `memory bookkeeping for the conversation is deleted by its two keys`() = runTest {
        repo.deleteMemoryBookkeeping("CU1", "C1")

        assertEquals(
            listOf("META#CONV#C1", "META#PENDING#C1"),
            deletedKeys(DynamoDBConstants.CUSTOMER_MEMORY_TABLE).map { it.getValue("memoryId").s() }
        )
    }

    @Test
    fun `conversation parents map each conversation to the one it was forked from`() = runTest {
        pages["${DynamoDBConstants.CONVERSATION_TABLE}/"] = listOf(listOf(
            mapOf("conversationId" to s("C1")),
            mapOf("conversationId" to s("C2"), "parentConversationId" to s("C1")),
        ))

        assertEquals(mapOf("C1" to null, "C2" to "C1"), repo.conversationParents("CU1"))
    }
}
