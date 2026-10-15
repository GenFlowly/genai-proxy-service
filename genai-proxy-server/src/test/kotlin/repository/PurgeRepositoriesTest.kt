package com.genflowly.repository

import com.genflowly.testsupport.FakeProfileTables
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemRequest
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemResponse
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Request shapes of the PurgeJobs queue and the purge's deletes. */
class PurgeRepositoriesTest {

    private val client = mockk<DynamoDbClient>()
    private val jobs = PurgeJobRepository(client, mockk<KLogger>(relaxed = true))
    private val purge = CustomerDataPurgeRepository(client, mockk<KLogger>(relaxed = true))
    private val now = Instant.parse("2026-10-15T12:00:00Z")

    private fun s(v: String) = AttributeValue.builder().s(v).build()

    @Test
    fun `a job is created once, pending in the sparse index`() = runTest {
        val puts = mutableListOf<PutItemRequest>()
        every { client.putItem(capture(puts)) } returns PutItemResponse.builder().build()

        assertTrue(jobs.createIfAbsent(PurgeJob("ACCOUNT#CU1", PurgeJobType.ACCOUNT, "CU1", authSub = "auth0|x"), now))

        val put = puts.single()
        assertEquals(RetentionTables.PURGE_JOBS_TABLE, put.tableName())
        assertEquals("attribute_not_exists(#k)", put.conditionExpression())
        assertEquals("PENDING", put.item()[RetentionTables.PURGE_PENDING_SHARD_KEY]?.s())
        assertEquals(now.toString(), put.item()[RetentionTables.PURGE_DUE_AT_KEY]?.s())
        assertEquals("auth0|x", put.item()["authSub"]?.s())

        every { client.putItem(any<PutItemRequest>()) } throws ConditionalCheckFailedException.builder().message("x").build()
        assertFalse(jobs.createIfAbsent(PurgeJob("ACCOUNT#CU1", PurgeJobType.ACCOUNT, "CU1"), now))
    }

    @Test
    fun `due jobs come from the pending index up to now`() = runTest {
        val queries = mutableListOf<QueryRequest>()
        every { client.query(capture(queries)) } returns QueryResponse.builder().items(listOf(mapOf(
            "jobKey" to s("conv-1"), "jobType" to s("CONVERSATION"), "customerId" to s("CU1"),
            "conversationId" to s("conv-1"), "attempts" to AttributeValue.builder().n("2").build(),
            "runIds" to AttributeValue.builder().ss("run_1").build()
        ))).build()

        val due = jobs.dueJobs(now, 10)

        assertEquals(RetentionTables.PURGE_PENDING_INDEX, queries.single().indexName())
        assertEquals("#shard = :shard AND #due <= :now", queries.single().keyConditionExpression())
        assertEquals(now.toString(), queries.single().expressionAttributeValues()[":now"]!!.s())
        assertEquals(listOf(PurgeJob("conv-1", PurgeJobType.CONVERSATION, "CU1", "conv-1", attempts = 2, runIds = setOf("run_1"))), due)
    }

    @Test
    fun `the lease is conditional on an unfinished job with no live lease`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        assertTrue(jobs.tryLease("conv-1", now, now.plusSeconds(900)))
        assertEquals(
            "attribute_exists(#shard) AND (attribute_not_exists(#lease) OR #lease < :now)",
            updates.single().conditionExpression()
        )

        every { client.updateItem(any<UpdateItemRequest>()) } throws ConditionalCheckFailedException.builder().message("x").build()
        assertFalse(jobs.tryLease("conv-1", now, now.plusSeconds(900)))
    }

    @Test
    fun `completing a job takes it out of the index and drops the recorded login`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        jobs.complete("ACCOUNT#CU1")

        val expression = updates.single().updateExpression()
        assertTrue(expression.contains("REMOVE #shard, #due, #lease, authSub, authClient"), expression)
        assertEquals("DONE", updates.single().expressionAttributeValues()[":done"]!!.s())
    }

    @Test
    fun `a failed attempt is counted and the lease released`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        jobs.reschedule("conv-1", now, failed = true, rescheduled = false, error = "boom")

        val expression = updates.single().updateExpression()
        assertTrue(expression.contains("REMOVE #lease") && expression.contains("ADD attempts :one"), expression)
        assertEquals("boom", updates.single().expressionAttributeValues()[":err"]!!.s())
    }

    @Test
    fun `a partition delete pages through the keys, batches deletes and verifies none remain`() = runTest {
        val table = CustomerPartitionTable("CustomerNotes", "customerId", "noteKey")
        val notes = (1..30).map { mapOf("customerId" to s("CU1"), "noteKey" to s("n$it")) }
        var deletedAll = false
        val queries = mutableListOf<QueryRequest>()
        every { client.query(capture(queries)) } answers {
            val request = firstArg<QueryRequest>()
            when {
                deletedAll -> QueryResponse.builder().items(emptyList()).build()
                request.exclusiveStartKey().isNullOrEmpty() ->
                    QueryResponse.builder().items(notes.take(20)).lastEvaluatedKey(notes[19]).build()
                else -> QueryResponse.builder().items(notes.drop(20)).build()
            }
        }
        val batches = mutableListOf<BatchWriteItemRequest>()
        every { client.batchWriteItem(capture(batches)) } answers {
            if (batches.size == 2) deletedAll = true
            BatchWriteItemResponse.builder().build()
        }

        assertEquals(30, purge.deletePartition(table, "CU1"))

        assertEquals(listOf(25, 5), batches.map { it.requestItems()["CustomerNotes"]!!.size })
        assertTrue(queries.all { it.consistentRead() && it.projectionExpression() == "#pk, #sk" })
    }

    @Test
    fun `rows that survive the batch delete fail the purge step`() = runTest {
        val table = CustomerPartitionTable("CustomerNotes", "customerId", "noteKey")
        every { client.query(any<QueryRequest>()) } returns QueryResponse.builder()
            .items(listOf(mapOf("customerId" to s("CU1"), "noteKey" to s("n1")))).build()
        every { client.batchWriteItem(any<BatchWriteItemRequest>()) } returns BatchWriteItemResponse.builder().build()

        assertFailsWith<IllegalStateException> { purge.deletePartition(table, "CU1") }
    }

    @Test
    fun `the purge marker is set once and only on an existing conversation`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { client.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        assertTrue(purge.markConversationPurgeStarted("CU1", "conv-1", now))
        assertEquals("SET #ps = if_not_exists(#ps, :now)", updates.single().updateExpression())
        assertEquals("attribute_exists(#conv)", updates.single().conditionExpression())

        every { client.updateItem(any<UpdateItemRequest>()) } throws ConditionalCheckFailedException.builder().message("x").build()
        assertFalse(purge.markConversationPurgeStarted("CU1", "gone", now))
    }

    @Test
    fun `re-keying a deleted profile twice is a no-op the second time`() = runTest {
        val tables = FakeProfileTables().apply { addProfile("auth0|a", "REACT_APP", "CU1", "Ann", "ann-1") }
        val profiles = CustomerProfileRepository(tables.client, mockk<KLogger>(relaxed = true))

        assertEquals(CustomerProfileRepository.DeletedRekeyResult.REKEYED, profiles.rekeyDeletedCustomer("CU1"))
        assertEquals(CustomerProfileRepository.DeletedRekeyResult.ALREADY_REKEYED, profiles.rekeyDeletedCustomer("CU1"))
        assertEquals(CustomerProfileRepository.DeletedRekeyResult.NOT_FOUND, profiles.rekeyDeletedCustomer("CU2"))

        assertEquals(setOf("DELETED#CU1" to "REACT_APP"), tables.profiles.keys)
        assertEquals("ann-1", tables.profiles["DELETED#CU1" to "REACT_APP"]!!["username"]?.s())
        assertTrue(tables.usernames.isEmpty())
    }

    @Test
    fun `a handle someone else took meanwhile is not deleted`() = runTest {
        val tables = FakeProfileTables().apply { addProfile("auth0|a", "REACT_APP", "CU1", "Ann", "ann-1") }
        tables.usernames["ann-1"] = mapOf("username" to tables.s("ann-1"), "customerId" to tables.s("CU9"))
        val profiles = CustomerProfileRepository(tables.client, mockk<KLogger>(relaxed = true))

        assertEquals(CustomerProfileRepository.DeletedRekeyResult.REKEYED, profiles.rekeyDeletedCustomer("CU1"))

        assertEquals("CU9", tables.usernames["ann-1"]!!["customerId"]?.s())
    }
}
