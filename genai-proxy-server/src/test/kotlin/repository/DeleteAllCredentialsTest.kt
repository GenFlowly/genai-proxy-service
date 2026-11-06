package com.genflowly.repository

import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.DeleteItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * "Delete all API keys": every key row goes, the vector DB connection goes,
 * and tool rows lose their credentials but keep non-secret settings.
 */
class DeleteAllCredentialsTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = CustomerCredentialsRepository(ddb, KotlinLogging.logger("DeleteAllCredentialsTest"))
    private val deletes = mutableListOf<DeleteItemRequest>()
    private val updates = mutableListOf<UpdateItemRequest>()

    init {
        every { ddb.deleteItem(any<DeleteItemRequest>()) } answers {
            deletes += firstArg<DeleteItemRequest>()
            DeleteItemResponse.builder().build()
        }
        every { ddb.updateItem(any<UpdateItemRequest>()) } answers {
            updates += firstArg<UpdateItemRequest>()
            UpdateItemResponse.builder().build()
        }
    }

    private fun s(value: String) = AttributeValue.builder().s(value).build()

    private fun rows(vararg items: Map<String, AttributeValue>) {
        every { ddb.query(any<QueryRequest>()) } returns QueryResponse.builder().items(items.toList()).build()
    }

    @Test
    fun `every key row is deleted, and only rows holding a key count`() = runTest {
        rows(
            mapOf("customerId" to s("CU1"), "aiVendor" to s("OPENAI"), "apiKey" to s("enc-1")),
            mapOf("customerId" to s("CU1"), "aiVendor" to s("CLAUDE")),
            mapOf("customerId" to s("CU1"), "aiVendor" to s("VOYAGE"), "apiKey" to s("enc-2")),
        )

        assertEquals(2, repo.deleteAllCustomerApiKeys("CU1"))
        assertEquals(listOf("OPENAI", "CLAUDE", "VOYAGE"), deletes.map { it.key().getValue("aiVendor").s() })
        assertTrue(deletes.all { it.key().getValue("customerId").s() == "CU1" })
    }

    @Test
    fun `tool rows lose their credentials but keep their settings`() = runTest {
        rows(
            mapOf("customerId" to s("CU1"), "toolType" to s("WEB_SEARCH"), "credentials" to s("enc"), "settings" to s("""{"max_searches_per_turn":5}""")),
            mapOf("customerId" to s("CU1"), "toolType" to s("connector:github"), "credentials" to s("enc")),
            mapOf("customerId" to s("CU1"), "toolType" to s("SETTINGS_ONLY"), "settings" to s("{}")),
        )

        assertEquals(2, repo.removeAllToolCredentials("CU1"))

        assertEquals(listOf("WEB_SEARCH"), updates.map { it.key().getValue("toolType").s() })
        assertEquals("REMOVE #credentials, #authType", updates.single().updateExpression())
        assertEquals(listOf("connector:github"), deletes.map { it.key().getValue("toolType").s() })
    }

    @Test
    fun `the vector DB connection is deleted, and reports whether there was one`() = runTest {
        every { ddb.deleteItem(any<DeleteItemRequest>()) } returns DeleteItemResponse.builder()
            .attributes(mapOf("customerId" to s("CU1"), "vendor" to s("ZILLIZ"))).build()
        assertTrue(repo.deleteCustomerVectorDBConfig("CU1"))

        every { ddb.deleteItem(any<DeleteItemRequest>()) } returns DeleteItemResponse.builder().build()
        assertFalse(repo.deleteCustomerVectorDBConfig("CU1"))
    }
}
