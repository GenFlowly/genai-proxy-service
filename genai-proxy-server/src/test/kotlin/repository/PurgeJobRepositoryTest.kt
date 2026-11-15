package com.genflowly.repository

import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import java.time.Instant
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Deletion jobs in PurgeJobs: one job per account, conversation or note,
 * claims that only one instance can win, and a finished job that drops out
 * of the pending index and forgets the login.
 */
class PurgeJobRepositoryTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = PurgeJobRepository(ddb)
    private val requestedAt = Instant.parse("2026-11-05T12:00:00Z")

    private fun s(value: String) = AttributeValue.builder().s(value).build()
    private fun n(value: Int) = AttributeValue.builder().n(value.toString()).build()

    private val account = PurgeJob(
        type = PurgeJobType.ACCOUNT, customerId = "CU1", requestedAt = requestedAt,
        sub = "auth0|u1", client = "REACT_APP", username = "alex-abc123"
    )
    private val conversation = PurgeJob(
        type = PurgeJobType.CONVERSATION, customerId = "CU1", itemId = "C1", requestedAt = requestedAt, parentId = "C0"
    )

    @Test
    fun `each kind of job has its own key`() {
        assertEquals("ACCOUNT#CU1", account.jobKey)
        assertEquals("CONVERSATION#CU1#C1", conversation.jobKey)
        assertEquals("NOTE#CU1#N1", PurgeJob(PurgeJobType.NOTE, "CU1", "N1", requestedAt).jobKey)
    }

    @Test
    fun `a job is created once, pending and due`() = runTest {
        val put = slot<PutItemRequest>()
        every { ddb.putItem(capture(put)) } returns PutItemResponse.builder().build()

        assertTrue(repo.createIfAbsent(account, dueAt = requestedAt.plusSeconds(1800)))

        val item = put.captured.item()
        assertEquals("ACCOUNT#CU1", item["jobKey"]?.s())
        assertEquals("ACCOUNT", item["type"]?.s())
        assertEquals("PENDING", item["pendingShard"]?.s())
        assertEquals("2026-11-05T12:30:00Z", item["dueAt"]?.s())
        assertEquals("auth0|u1", item["sub"]?.s())
        assertEquals("attribute_not_exists(jobKey)", put.captured.conditionExpression())

        every { ddb.putItem(any<PutItemRequest>()) } throws ConditionalCheckFailedException.builder().build()
        assertFalse(repo.createIfAbsent(account, dueAt = requestedAt))
    }

    @Test
    fun `a conversation job records the item and where it was forked from`() = runTest {
        val put = slot<PutItemRequest>()
        every { ddb.putItem(capture(put)) } returns PutItemResponse.builder().build()

        repo.createIfAbsent(conversation, dueAt = requestedAt)

        val item = put.captured.item()
        assertEquals("CONVERSATION", item["type"]?.s())
        assertEquals("C1", item["itemId"]?.s())
        assertEquals("C0", item["parentId"]?.s())
    }

    @Test
    fun `due jobs of every type come from the pending index`() = runTest {
        val query = slot<QueryRequest>()
        every { ddb.query(capture(query)) } returns QueryResponse.builder().items(
            mapOf(
                "jobKey" to s("ACCOUNT#CU1"), "type" to s("ACCOUNT"), "customerId" to s("CU1"),
                "requestedAt" to s(requestedAt.toString()), "stage" to n(3), "attempts" to n(2),
                "dueAt" to s("2026-11-05T12:01:00Z"), "sub" to s("auth0|u1")
            ),
            mapOf(
                "jobKey" to s("NOTE#CU1#N1"), "type" to s("NOTE"), "customerId" to s("CU1"), "itemId" to s("N1"),
                "requestedAt" to s(requestedAt.toString()), "dueAt" to s("2026-11-05T12:01:00Z")
            ),
            mapOf("jobKey" to s("LEGACY#1"), "type" to s("SOMETHING_ELSE"), "customerId" to s("CU1"))
        ).build()

        val due = repo.dueJobs(requestedAt.plusSeconds(120), limit = 10)

        assertEquals(
            listOf(
                account.copy(client = null, username = null, stage = 3, attempts = 2, dueAt = "2026-11-05T12:01:00Z"),
                PurgeJob(PurgeJobType.NOTE, "CU1", "N1", requestedAt, dueAt = "2026-11-05T12:01:00Z")
            ),
            due
        )
        assertEquals("pending-purge-index", query.captured.indexName())
        assertNull(query.captured.filterExpression())
        assertEquals("2026-11-05T12:02:00Z", query.captured.expressionAttributeValues()[":now"]?.s())
    }

    @Test
    fun `only the instance that read the current dueAt wins the claim`() = runTest {
        val update = slot<UpdateItemRequest>()
        every { ddb.updateItem(capture(update)) } returns UpdateItemResponse.builder().attributes(
            mapOf(
                "type" to s("ACCOUNT"), "customerId" to s("CU1"), "requestedAt" to s(requestedAt.toString()),
                "stage" to n(1), "attempts" to n(3), "dueAt" to s("2026-11-05T13:00:00Z")
            )
        ).build()
        val due = account.copy(dueAt = "2026-11-05T12:00:00Z")

        val claimed = repo.claim(due, leaseUntil = Instant.parse("2026-11-05T13:00:00Z"))

        assertEquals(3, claimed?.attempts)
        assertEquals("attribute_exists(pendingShard) AND dueAt = :seen", update.captured.conditionExpression())
        assertEquals("2026-11-05T12:00:00Z", update.captured.expressionAttributeValues()[":seen"]?.s())

        every { ddb.updateItem(any<UpdateItemRequest>()) } throws ConditionalCheckFailedException.builder().build()
        assertNull(repo.claim(due, leaseUntil = requestedAt))
    }

    @Test
    fun `kept files are added and forgotten as a set, and an empty set is not written`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { ddb.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        repo.recordKeptFiles(conversation, setOf("customers/CU1/attachments/a"))
        repo.forgetKeptFiles(conversation, setOf("customers/CU1/attachments/a"))
        repo.recordKeptFiles(conversation, emptySet())

        assertEquals(listOf("ADD keptFileKeys :k", "DELETE keptFileKeys :k"), updates.map { it.updateExpression() })
        assertTrue(updates.all { it.key() == mapOf("jobKey" to s("CONVERSATION#CU1#C1")) })
    }

    @Test
    fun `a finished job leaves the pending index and forgets the login`() = runTest {
        val update = slot<UpdateItemRequest>()
        every { ddb.updateItem(capture(update)) } returns UpdateItemResponse.builder().build()

        repo.complete(account, requestedAt)

        val expression = update.captured.updateExpression()
        val removed = expression.substringAfter("REMOVE ").split(",").map { it.trim() }.toSet()
        assertEquals(setOf("pendingShard", "dueAt", "sub", "client", "username", "lastError"), removed)
        assertEquals("DONE", update.captured.expressionAttributeValues()[":done"]?.s())
        assertEquals(mapOf("jobKey" to s("ACCOUNT#CU1")), update.captured.key())
    }
}
