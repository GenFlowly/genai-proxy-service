package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/** Data access for the SystemVendorApiKeys table (admin-managed system keys). */
class SystemApiKeyRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun saveSystemApiKey(
        aiVendor: String,
        encryptedKey: String,
        updatedBy: String
    ) = withContext(Dispatchers.IO) {
        try {
            // Upsert instead of PutItem so rotating a key preserves the
            // vendor's saved model/priority configuration
            val now = Instant.now().toString()
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                    .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                    .updateExpression(
                        "SET apiKey = :key, isAPIKeyValid = :valid, updatedBy = :by, " +
                                "updatedAt = :now, createdAt = if_not_exists(createdAt, :now)"
                    )
                    .expressionAttributeValues(mapOf(
                        ":key" to AttributeValue.builder().s(encryptedKey).build(),
                        ":valid" to AttributeValue.builder().bool(true).build(),
                        ":by" to AttributeValue.builder().s(updatedBy).build(),
                        ":now" to AttributeValue.builder().s(now).build()
                    ))
                    .build()
            )
            logger.info("Saved system API key for vendor $aiVendor to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save system API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun updateSystemApiKeyConfig(
        aiVendor: String,
        selectedModel: String,
        priority: Int
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                    .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                    .updateExpression("SET selectedModel = :m, #p = :p, updatedAt = :now")
                    // Config only makes sense on a vendor that has a stored key
                    .conditionExpression("attribute_exists($AI_VENDOR_KEY) AND attribute_exists(apiKey)")
                    .expressionAttributeNames(mapOf("#p" to "priority"))
                    .expressionAttributeValues(mapOf(
                        ":m" to AttributeValue.builder().s(selectedModel).build(),
                        ":p" to AttributeValue.builder().n(priority.toString()).build(),
                        ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                    ))
                    .build()
            )
            logger.info("Saved system vendor config for $aiVendor: model=$selectedModel priority=$priority")
        } catch (e: Exception) {
            logger.error("Failed to save system vendor config to DynamoDB", e)
            throw e
        }
    }

    suspend fun getSystemApiKeyItem(aiVendor: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                .build()

            val response = dynamoDbClient.getItem(request)
            if (response.hasItem()) response.item() else null
        }

    /**
     * Sets isAPIKeyValid = false, conditional on [encryptedKey] still being the
     * stored key. Returns false when it was replaced in the meantime.
     */
    suspend fun markSystemApiKeyInvalid(aiVendor: String, encryptedKey: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.updateItem(
                    UpdateItemRequest.builder()
                        .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                        .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                        .updateExpression("SET isAPIKeyValid = :invalid")
                        .conditionExpression("apiKey = :key")
                        .expressionAttributeValues(mapOf(
                            ":invalid" to AttributeValue.builder().bool(false).build(),
                            ":key" to AttributeValue.builder().s(encryptedKey).build()
                        ))
                        .build()
                )
                logger.info("Marked system API key for vendor $aiVendor invalid")
                true
            } catch (e: ConditionalCheckFailedException) {
                false
            }
        }

    suspend fun deleteSystemApiKey(aiVendor: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.SYSTEM_VENDOR_API_KEY_TABLE)
                .key(mapOf(AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()))
                .build()
        )
        logger.info("Deleted system API key for vendor $aiVendor from DynamoDB")
    }
}
