package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/** Data access for the CustomerDeveloperApiKeys table. */
class DeveloperApiKeyRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun saveDeveloperApiKey(
        keyHash: String,
        keyId: String,
        customerId: String,
        name: String,
        prefix: String,
        encryptedKey: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build(),
                "keyId" to AttributeValue.builder().s(keyId).build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                "name" to AttributeValue.builder().s(name).build(),
                "prefix" to AttributeValue.builder().s(prefix).build(),
                "encryptedKey" to AttributeValue.builder().s(encryptedKey).build(),
                "revoked" to AttributeValue.builder().bool(false).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved developer API key $keyId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to save developer API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun getDeveloperApiKeyByHash(keyHash: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build()
            )
            val response = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                    .key(key)
                    .build()
            )
            if (response.hasItem()) response.item() else null
        }

    suspend fun queryDeveloperApiKeysByCustomer(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            val queryReq = QueryRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                .indexName(DynamoDBConstants.DEVELOPER_API_KEY_CUSTOMER_GSI)
                .keyConditionExpression("customerId = :cid")
                .expressionAttributeValues(
                    mapOf(":cid" to AttributeValue.builder().s(customerId).build())
                )
                .build()
            dynamoDbClient.query(queryReq).items()
        }

    suspend fun deleteDeveloperApiKey(keyHash: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                .key(mapOf(
                    DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build()
                ))
                .build()
        )
    }

    suspend fun updateDeveloperApiKeyLastUsed(keyHash: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE)
                    .key(mapOf(
                        DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY to AttributeValue.builder().s(keyHash).build()
                    ))
                    .updateExpression("SET lastUsedAt = :now")
                    .expressionAttributeValues(
                        mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build())
                    )
                    .build()
            )
        } catch (e: Exception) {
            // Best-effort only; never fail a request because the usage timestamp couldn't be written
            logger.warn("Failed to update lastUsedAt for developer API key", e)
        }
    }
}
