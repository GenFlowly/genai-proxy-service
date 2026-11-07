package com.genflowly.repository

import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The chat-indexing switch is stored with the other preferences and read back; unset reads as null. */
class IndexChatsPreferenceTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = CustomerProfileRepository(ddb, KotlinLogging.logger("IndexChatsPreferenceTest"))

    @Test
    fun `the switch is saved only when it is sent`() = runTest {
        val update = slot<UpdateItemRequest>()
        every { ddb.updateItem(capture(update)) } returns UpdateItemResponse.builder().build()

        repo.savePreferences("CU1", preferredModels = null, otherPreferences = null, indexChats = true)
        assertTrue(update.captured.updateExpression().contains("#indexChats = :indexChats"))
        assertEquals(true, update.captured.expressionAttributeValues().getValue(":indexChats").bool())

        repo.savePreferences("CU1", preferredModels = null, otherPreferences = null, memoryUseInReplies = false)
        assertFalse(update.captured.updateExpression().contains("indexChats"))
    }

    @Test
    fun `the switch is read back, and unset reads as null`() = runTest {
        every { ddb.getItem(any<GetItemRequest>()) } returnsMany listOf(
            GetItemResponse.builder().item(mapOf("indexChats" to AttributeValue.builder().bool(true).build())).build(),
            GetItemResponse.builder().item(mapOf("embeddingModel" to AttributeValue.builder().s("voyage-4").build())).build(),
        )

        assertEquals(true, repo.getAIConfigPreferences("CU1")?.indexChats)
        assertNull(repo.getAIConfigPreferences("CU1")?.indexChats)
    }
}
