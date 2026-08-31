package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the CustomerNotes table.
 *
 * NOTE (Phase 4): the "Untitled" defaulting inside saveNote is domain policy
 * that ascends to NotesService in the service-decomposition phase; the
 * partial-update/resurrection mechanics stay here.
 */
class NotesRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun saveNote(
        customerId: String,
        noteKey: String,
        noteValue: String,
        title: String,
        createdAt: String
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val names = mutableMapOf(
                "#noteValue" to "noteValue",
                "#title" to "title",
                "#noteCreatedAt" to "noteCreatedAt",
                "#createdAt" to "createdAt",
                "#updatedAt" to "updatedAt",
                "#synced" to "is_synced_with_milvus",
                "#milvusIds" to "milvus_ids",
                "#isDelete" to "is_delete"
            )
            val values = mutableMapOf(
                ":noteValue" to AttributeValue.builder().s(noteValue).build(),
                ":noteCreatedAt" to AttributeValue.builder().s(createdAt).build(),
                ":now" to AttributeValue.builder().s(now).build(),
                ":synced" to AttributeValue.builder().bool(false).build(),
                ":milvusIds" to AttributeValue.builder().l(emptyList()).build(),
                ":notDeleted" to AttributeValue.builder().bool(false).build()
            )
            val setParts = mutableListOf(
                "#noteValue = :noteValue",
                "#noteCreatedAt = :noteCreatedAt",
                "#createdAt = if_not_exists(#createdAt, :now)",
                "#updatedAt = :now",
                "#synced = :synced",
                "#milvusIds = :milvusIds",
                // Saving always leaves the note visible (a re-save of a
                // soft-deleted key resurrects it)
                "#isDelete = :notDeleted"
            )
            if (title.isNotBlank() && title != "Untitled") {
                setParts.add("#title = :title")
                values[":title"] = AttributeValue.builder().s(title).build()
            } else {
                // Autosaves carry no real title; keep an existing (possibly
                // generated) one instead of resetting it to the default
                setParts.add("#title = if_not_exists(#title, :defaultTitle)")
                values[":defaultTitle"] = AttributeValue.builder().s("Untitled").build()
            }

            val updateReq = UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                ))
                .updateExpression("SET ${setParts.joinToString(", ")}")
                .expressionAttributeNames(names)
                .expressionAttributeValues(values)
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Saved Note $noteKey for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save note to DynamoDB", e)
            throw e
        }
    }

    /**
     * Flags a note for batch embedding: sets embedding_status=pending plus the
     * model to use. The encoding server's accumulator sweeps these off the
     * sparse embedding-status-index GSI. Replaces the synchronous /encode-notes
     * call for batch-mode customers.
     */
    suspend fun markNotePendingEmbedding(
        customerId: String,
        noteKey: String,
        embeddingModelType: String,
        embeddingModel: String
    ) = withContext(Dispatchers.IO) {
        try {
            val updateReq = UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                ))
                .updateExpression(
                    "SET #status = :status, #modelType = :modelType, #model = :model, #updatedAt = :now"
                )
                .conditionExpression("attribute_exists(${DynamoDBConstants.NOTE_KEY})")
                .expressionAttributeNames(mapOf(
                    "#status" to "embedding_status",
                    "#modelType" to "embedding_model_type",
                    "#model" to "embedding_model",
                    "#updatedAt" to "embedding_updated_at"
                ))
                .expressionAttributeValues(mapOf(
                    ":status" to AttributeValue.builder().s("pending").build(),
                    ":modelType" to AttributeValue.builder().s(embeddingModelType).build(),
                    ":model" to AttributeValue.builder().s(embeddingModel).build(),
                    ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                ))
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Marked note $noteKey of $customerId pending batch embedding ($embeddingModel)")
        } catch (e: Exception) {
            logger.error("Failed to mark note $noteKey pending embedding", e)
            throw e
        }
    }

    suspend fun updateNoteTitle(
        customerId: String,
        noteKey: String,
        title: String
    ) = withContext(Dispatchers.IO) {
        try {
            val updateReq = UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                ))
                .updateExpression("SET #title = :title, #updatedAt = :now")
                .conditionExpression("attribute_exists(${DynamoDBConstants.NOTE_KEY})")
                .expressionAttributeNames(mapOf("#title" to "title", "#updatedAt" to "updatedAt"))
                .expressionAttributeValues(mapOf(
                    ":title" to AttributeValue.builder().s(title).build(),
                    ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                ))
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Updated title for note $noteKey of $customerId")
        } catch (e: ConditionalCheckFailedException) {
            // Note was deleted between the save and the title generation
            logger.warn("Skipped title update for missing note $noteKey of $customerId")
        } catch (e: Exception) {
            logger.error("Failed to update note title in DynamoDB", e)
            throw e
        }
    }

    /**
     * Soft-delete a note: the DDB item is kept but flagged is_delete=true so
     * it disappears from listings. Returns false when the note doesn't exist.
     */
    suspend fun softDeleteNote(
        customerId: String,
        noteKey: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        DynamoDBConstants.NOTE_KEY to AttributeValue.builder().s(noteKey).build()
                    ))
                    .updateExpression("SET #isDelete = :true, #deletedAt = :now, #updatedAt = :now")
                    .conditionExpression("attribute_exists(${DynamoDBConstants.NOTE_KEY})")
                    .expressionAttributeNames(mapOf(
                        "#isDelete" to "is_delete",
                        "#deletedAt" to "deletedAt",
                        "#updatedAt" to "updatedAt"
                    ))
                    .expressionAttributeValues(mapOf(
                        ":true" to AttributeValue.builder().bool(true).build(),
                        ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                    ))
                    .build()
            )
            logger.info("Soft-deleted note $noteKey for customer $customerId")
            true
        } catch (e: ConditionalCheckFailedException) {
            logger.warn("Skipped soft delete for missing note $noteKey of $customerId")
            false
        } catch (e: Exception) {
            logger.error("Failed to soft-delete note $noteKey for $customerId", e)
            throw e
        }
    }

    suspend fun getNotes(customerId: String): List<Map<String, AttributeValue>> = withContext(Dispatchers.IO) {
        try {
            val items = mutableListOf<Map<String, AttributeValue>>()
            var exclusiveStartKey: Map<String, AttributeValue>? = null

            do {
                val queryBuilder = QueryRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_NOTES_TABLE)
                    .keyConditionExpression("$CUSTOMER_ID_KEY = :cid")
                    // Soft-deleted notes stay in the table but never in listings
                    .filterExpression("attribute_not_exists(#isDelete) OR #isDelete = :notDeleted")
                    .expressionAttributeNames(mapOf("#isDelete" to "is_delete"))
                    .expressionAttributeValues(
                        mapOf(
                            ":cid" to AttributeValue.builder().s(customerId).build(),
                            ":notDeleted" to AttributeValue.builder().bool(false).build()
                        )
                    )

                if (!exclusiveStartKey.isNullOrEmpty()) {
                    queryBuilder.exclusiveStartKey(exclusiveStartKey)
                }

                val response = dynamoDbClient.query(queryBuilder.build())
                items.addAll(response.items())
                exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
            } while (!exclusiveStartKey.isNullOrEmpty())

            logger.info("Fetched ${items.size} notes for $customerId from DynamoDB")
            items
        } catch (e: Exception) {
            logger.error("Failed to get notes from DynamoDB", e)
            throw e
        }
    }
}
