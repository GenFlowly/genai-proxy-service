package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_API_KEY_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE
import com.genflowly.DynamoDBConstants.VENDOR_KEY
import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest

/**
 * Data access for the customer secret-config tables: CustomerVendorApiKeys,
 * CustomerVectorDBConfig, CustomerSupabaseConfig and CustomerToolCredentials.
 * All secret values arrive already KMS-encrypted — this class never touches
 * plaintext or KMS.
 */
class CustomerCredentialsRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun getCustomerApiKey(aiVendor: String, customerId: String): String? =
        withContext(Dispatchers.IO) {
        val key = mapOf(
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId)
                .build(),
            AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()
        )

        val request =
            GetItemRequest.builder().tableName(CUSTOMER_API_KEY_TABLE).key(key)
                .build()

        val response = dynamoDbClient.getItem(request)
            return@withContext response.item()?.get("apiKey")?.s()
    }

    suspend fun saveCustomerApiKey(
        customerId: String,
        aiVendor: String,
        encryptedKey: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder()
                    .s(customerId).build(),
                AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor)
                    .build(),
                "apiKey" to AttributeValue.builder().s(encryptedKey).build(),
                "isAPIKeyValid" to AttributeValue.builder().bool(true).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved API key for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save API key to DynamoDB", e)
            throw e
        }
    }

    suspend fun initCustomerApiKey(
        customerId: String,
        aiVendor: String
    ) = withContext(Dispatchers.IO) {
        try {
            // Initial state: Valid = false, no apiKey
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build(),
                "isAPIKeyValid" to AttributeValue.builder().bool(false).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Initialized API key status for $customerId vendor $aiVendor")
        } catch (e: Exception) {
            logger.error("Failed to init API key status", e)
            // Non-blocking error for onboarding — logging is safer than throwing.
        }
    }

    suspend fun getCustomerApiKeys(customerId: String): List<com.genflowly.models.AIVendorAPIKeyStatus> =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .keyConditionExpression("#cid = :cid")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()

            val response = dynamoDbClient.query(request)

            response.items().mapNotNull { item ->
                val vendorStr = item[AI_VENDOR_KEY]?.s() ?: return@mapNotNull null
                val aiVendor = try {
                    AIVendor.valueOf(vendorStr)
                } catch (e: Exception) {
                    return@mapNotNull null
                }

                // Check explicitly stored validation status AND presence of actual key
                val isStoredValid = item["isAPIKeyValid"]?.bool() ?: false
                val hasKey = !item["apiKey"]?.s().isNullOrBlank()

                // Legacy items may lack the flag: assume valid when a key exists.
                // A TRUE flag with a MISSING key still reads as invalid.
                val isValid = if (item.containsKey("isAPIKeyValid")) {
                    isStoredValid && hasKey
                } else {
                    hasKey
                }

                val status = if (!hasKey) {
                    com.genflowly.models.APIKeyStatus.NOT_SET
                } else if (isValid) {
                    com.genflowly.models.APIKeyStatus.VALID
                } else {
                    com.genflowly.models.APIKeyStatus.INVALID
                }

                com.genflowly.models.AIVendorAPIKeyStatus(
                    aiVendor = aiVendor,
                    isAPIKeyValid = isValid,
                    status = status
                )
            }
        }

    // ─── Vector DB / Supabase config ──────────────────────────────────────────

    suspend fun saveCustomerVectorDBConfig(
        customerId: String,
        vendor: String,
        encryptedEndpoint: String,
        encryptedToken: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                VENDOR_KEY to AttributeValue.builder().s(vendor).build(),
                "endpoint" to AttributeValue.builder().s(encryptedEndpoint).build(),
                "token" to AttributeValue.builder().s(encryptedToken).build(),
                "isConfigValid" to AttributeValue.builder().bool(true).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(CUSTOMER_VECTOR_DB_CONFIG_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved Vector DB Config for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save Vector DB config to DynamoDB", e)
            throw e
        }
    }

    suspend fun saveCustomerSupabaseConfig(
        customerId: String,
        encryptedEndpoint: String,
        encryptedToken: String,
        encryptedPassword: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                "endpoint" to AttributeValue.builder().s(encryptedEndpoint).build(),
                "token" to AttributeValue.builder().s(encryptedToken).build(),
                "password" to AttributeValue.builder().s(encryptedPassword).build(),
                "isConfigValid" to AttributeValue.builder().bool(true).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_SUPABASE_CONFIG_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Saved Supabase Config for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save Supabase config to DynamoDB", e)
            throw e
        }
    }

    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<com.genflowly.models.VectorDBConfigStatus> = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(CUSTOMER_VECTOR_DB_CONFIG_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
                ))
                .build()

            val response = dynamoDbClient.getItem(getReq)

            if (response.hasItem()) {
                val item = response.item()
                val status = if (item["isConfigValid"]?.bool() == true) {
                    com.genflowly.models.VectorDBConfigStatusValue.PRESENT
                } else {
                    com.genflowly.models.VectorDBConfigStatusValue.NOT_SET
                }

                listOf(
                    com.genflowly.models.VectorDBConfigStatus(
                        vendor = item[VENDOR_KEY]?.s() ?: "Zilliz",
                        isConfigValid = item["isConfigValid"]?.bool() ?: false,
                        status = status,
                        updateSuccessful = true
                    )
                )
            } else {
                emptyList()
            }
        } catch (e: Exception) {
            logger.error("Failed to get Vector DB config status list from DynamoDB", e)
            emptyList()
        }
    }

    suspend fun getCustomerSupabaseConfigStatus(customerId: String): com.genflowly.models.SupabaseConfigStatus? = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_SUPABASE_CONFIG_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
                ))
                .build()

            val response = dynamoDbClient.getItem(getReq)

            if (response.hasItem()) {
                val item = response.item()
                val status = if (item["isConfigValid"]?.bool() == true) {
                    com.genflowly.models.SupabaseConfigStatusValue.PRESENT
                } else {
                    com.genflowly.models.SupabaseConfigStatusValue.NOT_SET
                }

                com.genflowly.models.SupabaseConfigStatus(
                    isConfigValid = item["isConfigValid"]?.bool() ?: false,
                    status = status,
                    updateSuccessful = true
                )
            } else {
                null
            }
        } catch (e: Exception) {
            logger.error("Failed to get Supabase config status from DynamoDB", e)
            null
        }
    }

    // ─── Tool credentials ─────────────────────────────────────────────────────

    suspend fun saveCustomerToolCredentials(
        customerId: String,
        toolType: String,
        authType: String,
        encryptedCredentials: String,
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                DynamoDBConstants.TOOL_AUTH_TYPE_KEY to AttributeValue.builder().s(authType).build(),
                DynamoDBConstants.TOOL_CREDENTIALS_KEY to AttributeValue.builder().s(encryptedCredentials).build(),
            ))
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                    .item(item)
                    .build()
            )
            logger.info("Saved tool credentials for $customerId / $toolType")
        } catch (e: Exception) {
            logger.error("Failed to save tool credentials for $customerId / $toolType", e)
            throw e
        }
    }

    suspend fun getCustomerToolCredentials(
        customerId: String,
        toolType: String,
    ): Map<String, AttributeValue>? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                ))
                .build()
        )
        response.item()?.takeIf { it.isNotEmpty() }
    }

    suspend fun listCustomerToolCredentials(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            val response = dynamoDbClient.query(
                QueryRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                    .keyConditionExpression("#cid = :cid")
                    .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                    .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                    .build()
            )
            response.items()
        }

    suspend fun deleteCustomerToolCredentials(customerId: String, toolType: String) =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.deleteItem(
                    DeleteItemRequest.builder()
                        .tableName(DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                        .key(mapOf(
                            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                            DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                        ))
                        .build()
                )
                logger.info("Deleted tool credentials for $customerId / $toolType")
            } catch (e: Exception) {
                logger.error("Failed to delete tool credentials for $customerId / $toolType", e)
                throw e
            }
        }
}
