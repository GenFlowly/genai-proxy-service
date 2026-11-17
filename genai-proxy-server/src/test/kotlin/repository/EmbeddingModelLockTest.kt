package com.genflowly.repository

import com.genflowly.models.EmbeddingModelLockedException
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.ReturnValuesOnConditionCheckFailure
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * One embedding model for all data, chosen once: the first save writes it to
 * all three attributes and stamps when; saving the same model again is fine;
 * any other model is refused, naming the one already chosen. Every write is a
 * single conditional update, never a read followed by a write.
 */
class EmbeddingModelLockTest {

    private val ddb = mockk<DynamoDbClient>()
    private val repo = CustomerProfileRepository(ddb, KotlinLogging.logger("EmbeddingModelLockTest"))

    private fun s(value: String) = AttributeValue.builder().s(value).build()

    private fun conditionFailed(oldItem: Map<String, AttributeValue> = emptyMap()) =
        ConditionalCheckFailedException.builder().message("The conditional request failed").item(oldItem).build()

    /** DynamoDB rejects any name or value placeholder the expressions don't use. */
    private fun assertNoUnusedPlaceholders(request: UpdateItemRequest) {
        val expressions = request.updateExpression() + " " + (request.conditionExpression() ?: "")
        request.expressionAttributeNames().keys.forEach { assertTrue(it in expressions, "unused name $it") }
        request.expressionAttributeValues().keys.forEach { assertTrue(it in expressions, "unused value $it") }
    }

    @Test
    fun `the first choice writes all three fields, stamps the time and is conditional on nothing chosen`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { ddb.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        repo.savePreferences("CU1", preferredModels = null, otherPreferences = null, embeddingModel = "voyage-4-large")

        val first = updates.single()
        listOf("#embeddingModel", "#embeddingModelConversations", "#embeddingModelNotes").forEach {
            assertTrue(first.updateExpression().contains("$it = :embeddingModel"))
        }
        assertTrue(first.updateExpression().contains("#embeddingModelChosenAt = :chosenAt"))
        assertTrue(first.conditionExpression().startsWith("(attribute_not_exists(#embeddingModel) OR #embeddingModel = :empty) AND"))
        assertEquals("voyage-4-large", first.expressionAttributeValues().getValue(":embeddingModel").s())
        assertEquals(ReturnValuesOnConditionCheckFailure.ALL_OLD, first.returnValuesOnConditionCheckFailure())
        assertNoUnusedPlaceholders(first)
    }

    @Test
    fun `saving the model already chosen succeeds without re-stamping the time`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { ddb.updateItem(capture(updates)) } throws conditionFailed() andThen UpdateItemResponse.builder().build()

        repo.savePreferences("CU1", preferredModels = null, otherPreferences = null, embeddingModel = "voyage-4-large")

        assertEquals(2, updates.size)
        val second = updates[1]
        assertFalse(second.updateExpression().contains("ChosenAt"))
        assertTrue(second.conditionExpression().startsWith("#embeddingModelConversations = :embeddingModel OR"))
        assertNoUnusedPlaceholders(second)
    }

    @Test
    fun `a different model is refused and names the model already chosen`() = runTest {
        every { ddb.updateItem(any<UpdateItemRequest>()) } throws
            conditionFailed() andThenThrows
            conditionFailed(mapOf("embeddingModel" to s("voyage-4"), "embeddingModelConversations" to s("text-embedding-3-large")))

        val refused = assertFailsWith<EmbeddingModelLockedException> {
            repo.savePreferences("CU1", preferredModels = null, otherPreferences = null, embeddingModel = "voyage-4-large")
        }

        assertEquals("text-embedding-3-large", refused.lockedModel)
    }

    @Test
    fun `saves without a model carry no lock condition`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { ddb.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build()

        repo.savePreferences("CU1", preferredModels = null, otherPreferences = null, indexChats = true, embeddingModel = "  ")

        assertNull(updates.single().conditionExpression())
        assertFalse(updates.single().updateExpression().contains("embeddingModel"))
        assertNoUnusedPlaceholders(updates.single())
    }

    @Test
    fun `an unusable chosen model is replaced only if it is still the chosen one`() = runTest {
        val updates = mutableListOf<UpdateItemRequest>()
        every { ddb.updateItem(capture(updates)) } returns UpdateItemResponse.builder().build() andThenThrows
            conditionFailed(mapOf("embeddingModelConversations" to s("voyage-4")))

        repo.replaceUnusableEmbeddingModel("CU1", from = "voyage-multimodal-3.5", to = "voyage-4-large")
        val refused = assertFailsWith<EmbeddingModelLockedException> {
            repo.replaceUnusableEmbeddingModel("CU1", from = "voyage-multimodal-3.5", to = "voyage-4-large")
        }

        val replace = updates.first()
        assertEquals("voyage-multimodal-3.5", replace.expressionAttributeValues().getValue(":embeddingModel").s())
        assertEquals("voyage-4-large", replace.expressionAttributeValues().getValue(":to").s())
        assertTrue(replace.updateExpression().contains("#embeddingModelChosenAt = :chosenAt"))
        assertTrue(replace.conditionExpression().startsWith("#embeddingModelConversations = :embeddingModel OR"))
        assertNoUnusedPlaceholders(replace)
        assertEquals("voyage-4", refused.lockedModel)
    }

    @Test
    fun `the chosen model is read the way the apps show it, blanks skipped`() {
        assertEquals("a", CustomerProfileRepository.chosenEmbeddingModel(mapOf("embeddingModelConversations" to s("a"), "embeddingModel" to s("b"))))
        assertEquals("b", CustomerProfileRepository.chosenEmbeddingModel(mapOf("embeddingModelConversations" to s(""), "embeddingModel" to s("b"))))
        assertEquals("c", CustomerProfileRepository.chosenEmbeddingModel(mapOf("embeddingModelNotes" to s("c"))))
        assertNull(CustomerProfileRepository.chosenEmbeddingModel(emptyMap()))
    }
}
