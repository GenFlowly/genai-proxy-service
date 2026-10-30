package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_API_KEY_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE
import com.genflowly.DynamoDBConstants.VENDOR_KEY
import com.genflowly.models.AIVendor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.ScanRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the customer secret-config tables: CustomerVendorApiKeys,
 * CustomerVectorDBConfig and CustomerToolCredentials.
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
            // UpdateItem (not PutItem) so re-saving a key preserves the
            // customer's selectedModel/priority config on the same item.
            val now = java.time.Instant.now().toString()
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CUSTOMER_API_KEY_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()
                    ))
                    .updateExpression(
                        "SET apiKey = :k, isAPIKeyValid = :v, updatedAt = :now, " +
                                "createdAt = if_not_exists(createdAt, :now)"
                    )
                    .expressionAttributeValues(mapOf(
                        ":k" to AttributeValue.builder().s(encryptedKey).build(),
                        ":v" to AttributeValue.builder().bool(true).build(),
                        ":now" to AttributeValue.builder().s(now).build()
                    ))
                    .build()
            )
            logger.info("Saved API key for $customerId to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to save API key to DynamoDB", e)
            throw e
        }
    }

    /**
     * Store the customer's selected model and failover priority (1 = primary)
     * for a vendor. Conditional on a stored key — config for a keyless vendor
     * is meaningless, so the caller gets ConditionalCheckFailedException.
     */
    suspend fun updateCustomerVendorConfig(
        customerId: String,
        aiVendor: String,
        selectedModel: String,
        priority: Int,
        /** Default reasoning effort; null/blank clears back to the vendor default. */
        thinkingLevel: String? = null
    ) = withContext(Dispatchers.IO) {
        val clearThinking = thinkingLevel.isNullOrBlank()
        val values = mutableMapOf(
            ":m" to AttributeValue.builder().s(selectedModel).build(),
            ":p" to AttributeValue.builder().n(priority.toString()).build(),
            ":now" to AttributeValue.builder().s(java.time.Instant.now().toString()).build()
        )
        val update = if (clearThinking) {
            "SET selectedModel = :m, #p = :p, updatedAt = :now REMOVE thinkingLevel"
        } else {
            values[":t"] = AttributeValue.builder().s(thinkingLevel).build()
            "SET selectedModel = :m, #p = :p, thinkingLevel = :t, updatedAt = :now"
        }
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()
                ))
                .updateExpression(update)
                .conditionExpression("attribute_exists($AI_VENDOR_KEY) AND attribute_exists(apiKey)")
                .expressionAttributeNames(mapOf("#p" to "priority"))
                .expressionAttributeValues(values)
                .build()
        )
        logger.info("Saved vendor config for $customerId/$aiVendor: model=$selectedModel priority=$priority thinking=${thinkingLevel ?: "default"}")
    }

    /** Raw CustomerVendorApiKeys items for one customer (encrypted keys included). */
    suspend fun getCustomerVendorItems(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(CUSTOMER_API_KEY_TABLE)
                .keyConditionExpression("#cid = :cid")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                .build()
            dynamoDbClient.query(request).items()
        }

    /**
     * Every stored key row for the given vendors that actually holds a key —
     * across all customers. Used by the weekly embedding-model sweep to find
     * which (customerId, vendor) pairs to re-probe. Scans the whole table (a
     * weekly job, PAY_PER_REQUEST), paging through all segments. Returned items
     * carry customerId, aiVendor and the encrypted apiKey.
     */
    suspend fun scanEmbeddingKeyItems(vendors: Set<String>): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            if (vendors.isEmpty()) return@withContext emptyList()
            val vendorPlaceholders = vendors.mapIndexed { i, _ -> ":v$i" }
            val exprValues = buildMap {
                vendors.forEachIndexed { i, v -> put(":v$i", AttributeValue.builder().s(v).build()) }
            }
            val results = mutableListOf<Map<String, AttributeValue>>()
            var lastKey: Map<String, AttributeValue>? = null
            do {
                val request = ScanRequest.builder()
                    .tableName(CUSTOMER_API_KEY_TABLE)
                    .filterExpression(
                        "#vendor IN (${vendorPlaceholders.joinToString(", ")}) AND attribute_exists(apiKey)"
                    )
                    .expressionAttributeNames(mapOf("#vendor" to AI_VENDOR_KEY))
                    .expressionAttributeValues(exprValues)
                    .apply { if (lastKey != null) exclusiveStartKey(lastKey) }
                    .build()
                val response = dynamoDbClient.scan(request)
                response.items().forEach { if (!it["apiKey"]?.s().isNullOrBlank()) results.add(it) }
                lastKey = response.lastEvaluatedKey().takeIf { it.isNotEmpty() }
            } while (lastKey != null)
            results
        }

    suspend fun deleteCustomerApiKey(customerId: String, aiVendor: String) =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.deleteItem(
                    DeleteItemRequest.builder()
                        .tableName(CUSTOMER_API_KEY_TABLE)
                        .key(mapOf(
                            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                            AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build()
                        ))
                        .build()
                )
                logger.info("Deleted API key for $customerId / $aiVendor")
            } catch (e: Exception) {
                logger.error("Failed to delete API key for $customerId / $aiVendor", e)
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
            getCustomerVendorItems(customerId).mapNotNull { item ->
                val vendorStr = item[AI_VENDOR_KEY]?.s() ?: return@mapNotNull null
                // Skips embedding-only rows (VOYAGE); any other vendor id is valid
                val aiVendor = AIVendor.fromStoredNameOrNull(vendorStr) ?: return@mapNotNull null

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
                    status = status,
                    selectedModel = item["selectedModel"]?.s(),
                    priority = item["priority"]?.n()?.toIntOrNull(),
                    thinkingLevel = item["thinkingLevel"]?.s()
                )
            }
        }

    // ─── Vector DB config ─────────────────────────────────────────────────────

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

    // ─── Tool credentials ─────────────────────────────────────────────────────

    /**
     * Upserts the provided pieces of one tool's item. UpdateItem, not PutItem:
     * a credentials write must not clobber stored settings and a settings
     * write must work on its own — even creating the item when the customer
     * has no stored key at all (platform-key users tuning limits). Null
     * arguments leave their attribute untouched.
     */
    suspend fun saveCustomerToolCredentials(
        customerId: String,
        toolType: String,
        authType: String,
        encryptedCredentials: String?,
        settingsJson: String? = null,
    ) = withContext(Dispatchers.IO) {
        try {
            val now = java.time.Instant.now().toString()
            val sets = mutableListOf(
                "updatedAt = :now",
                "createdAt = if_not_exists(createdAt, :now)",
            )
            val values = mutableMapOf<String, AttributeValue>(
                ":now" to AttributeValue.builder().s(now).build(),
            )
            val names = mutableMapOf<String, String>()
            if (encryptedCredentials != null) {
                sets += "#credentials = :credentials"
                sets += "#authType = :authType"
                names["#credentials"] = DynamoDBConstants.TOOL_CREDENTIALS_KEY
                names["#authType"] = DynamoDBConstants.TOOL_AUTH_TYPE_KEY
                values[":credentials"] = AttributeValue.builder().s(encryptedCredentials).build()
                values[":authType"] = AttributeValue.builder().s(authType).build()
            }
            if (settingsJson != null) {
                sets += "#settings = :settings"
                names["#settings"] = DynamoDBConstants.TOOL_SETTINGS_KEY
                values[":settings"] = AttributeValue.builder().s(settingsJson).build()
            }
            val update = UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    DynamoDBConstants.TOOL_TYPE_KEY to AttributeValue.builder().s(toolType).build(),
                ))
                .updateExpression("SET " + sets.joinToString(", "))
                .expressionAttributeValues(values)
            if (names.isNotEmpty()) update.expressionAttributeNames(names)
            dynamoDbClient.updateItem(update.build())
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
