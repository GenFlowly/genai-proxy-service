package com.genflowly.repository

import com.genflowly.models.CustomerEntitlements
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
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
 * Entitlement flags live on the profile row: a row missing any flag reads as
 * unknown, writes go to the row the customerId index finds and never create
 * one, and every expression names attributes through aliases (`sub` is a
 * reserved word, and mocked DynamoDB can't catch a bare one).
 */
class CustomerProfileEntitlementsTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = CustomerProfileRepository(ddb, KotlinLogging.logger("CustomerProfileEntitlementsTest"))
    private val queries = mutableListOf<QueryRequest>()
    private val updates = mutableListOf<UpdateItemRequest>()

    init {
        every { ddb.updateItem(any<UpdateItemRequest>()) } answers {
            updates += firstArg<UpdateItemRequest>()
            UpdateItemResponse.builder().build()
        }
    }

    private fun s(value: String) = AttributeValue.builder().s(value).build()
    private fun b(value: Boolean) = AttributeValue.builder().bool(value).build()

    private fun profileRows(vararg items: Map<String, AttributeValue>) {
        every { ddb.query(any<QueryRequest>()) } answers {
            queries += firstArg<QueryRequest>()
            QueryResponse.builder().items(items.toList()).build()
        }
    }

    private val profileKeys = mapOf("sub" to s("auth0|1"), "client" to s("REACT_APP"))

    @Test
    fun `stored flags are read from the customer's profile`() = runTest {
        profileRows(
            mapOf(
                "isVectorDbStoringEnabled" to b(true),
                "isEmbeddingCreationEnabled" to b(false),
                "isWebSearchEnabled" to b(true)
            )
        )

        assertEquals(
            CustomerEntitlements(isVectorDbStoringEnabled = true, isEmbeddingCreationEnabled = false, isWebSearchEnabled = true),
            repo.getEntitlements("CU1")
        )
        assertEquals("customerIdIndex", queries.single().indexName())
        assertEquals("CU1", queries.single().expressionAttributeValues().getValue(":cid").s())
    }

    @Test
    fun `a profile missing any flag, or no profile, reads as unknown`() = runTest {
        profileRows(mapOf("isVectorDbStoringEnabled" to b(true), "isEmbeddingCreationEnabled" to b(true)))
        assertNull(repo.getEntitlements("CU1"))

        profileRows()
        assertNull(repo.getEntitlements("CU1"))
    }

    @Test
    fun `flags are written to the row the customerId index finds, guarded by its customerId`() = runTest {
        profileRows(profileKeys)

        assertTrue(
            repo.saveEntitlements("CU1", CustomerEntitlements(isVectorDbStoringEnabled = true, isWebSearchEnabled = true))
        )

        val update = updates.single()
        assertEquals(mapOf("sub" to "auth0|1", "client" to "REACT_APP"), update.key().mapValues { it.value.s() })
        assertEquals("SET #vdb = :vdb, #emb = :emb, #web = :web", update.updateExpression())
        assertEquals("#cid = :cid", update.conditionExpression())
        val values = update.expressionAttributeValues()
        assertEquals(listOf(true, false, true), listOf(":vdb", ":emb", ":web").map { values.getValue(it).bool() })
        assertEquals("CU1", values.getValue(":cid").s())
    }

    @Test
    fun `a deleted account is never recreated`() = runTest {
        profileRows()
        assertFalse(repo.saveEntitlements("CU1", CustomerEntitlements()))
        assertTrue(updates.isEmpty())

        profileRows(profileKeys)
        every { ddb.updateItem(any<UpdateItemRequest>()) } throws
            ConditionalCheckFailedException.builder().message("The conditional request failed").build()
        assertFalse(repo.saveEntitlements("CU1", CustomerEntitlements()))
    }

    @Test
    fun `every expression names attributes through aliases`() = runTest {
        profileRows(profileKeys)
        repo.getEntitlements("CU1")
        repo.saveEntitlements("CU1", CustomerEntitlements())

        val expressions = queries.flatMap { listOfNotNull(it.keyConditionExpression(), it.projectionExpression()) } +
            updates.flatMap { listOfNotNull(it.updateExpression(), it.conditionExpression()) }
        val bareName = Regex("""(?<![#:\w])[A-Za-z_]\w*""")
        expressions.forEach { expression ->
            val bare = bareName.findAll(expression).map { it.value }.filterNot { it == "SET" }.toList()
            assertTrue(bare.isEmpty(), "bare attribute names $bare in '$expression'")
        }
        assertEquals(6, expressions.size)
    }
}
