package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CLIENT_SORT_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_PROFILE_TABLE
import com.genflowly.DynamoDBConstants.SUB_PARTITION_KEY
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.genflowly.models.AIConfig
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the CustomerProfile, UsernameLookup and CustomerPreferences
 * tables.
 *
 * Username generation/reservation (conditional-put uniqueness with retry) and
 * the lazy backfill-on-read stay here deliberately: they are storage-level
 * uniqueness/consistency invariants of the UsernameLookup table, exercised on
 * both write and read paths. Profile domain policy lives in
 * CustomerProfileService.
 */
class CustomerProfileRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    private suspend fun generateAndReserveUsername(sub: String, client: String, customerId: String, name: String?): String {
        var attempt = 0
        val baseUsername = name?.lowercase()?.replace(Regex("[^a-z0-9]"), "")?.takeIf { it.isNotBlank() } ?: "user"

        while(attempt < 3) {
            val hash = java.util.UUID.randomUUID().toString().substring(0, 6)
            val generatedUsername = "$baseUsername-$hash"

            try {
                val putUsernameReq = PutItemRequest.builder()
                    .tableName(DynamoDBConstants.USERNAME_LOOKUP_TABLE)
                    .item(mapOf(
                        "username" to AttributeValue.builder().s(generatedUsername).build(),
                        "recordType" to AttributeValue.builder().s("USER").build(),
                        "customerId" to AttributeValue.builder().s(customerId).build()
                    ))
                    .conditionExpression("attribute_not_exists(username)")
                    .build()
                dynamoDbClient.putItem(putUsernameReq)
                return generatedUsername
            } catch (e: ConditionalCheckFailedException) {
                attempt++
            }
        }
        throw IllegalStateException("Failed to generate unique username after 3 attempts")
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?,
        picture: String?
    ): String = withContext(Dispatchers.IO) {
        val generatedUsername = generateAndReserveUsername(sub, client, customerId, name)

        val baseItem = buildMap {
            put(SUB_PARTITION_KEY, AttributeValue.builder().s(sub).build())
            put(CLIENT_SORT_KEY, AttributeValue.builder().s(client).build())
            put("customerId", AttributeValue.builder().s(customerId).build())

            email?.let { put("email", AttributeValue.builder().s(it).build()) }
            name?.let { put("name", AttributeValue.builder().s(it).build()) }
            picture?.let { put("picture", AttributeValue.builder().s(it).build()) }

            put("username", AttributeValue.builder().s(generatedUsername).build())
            put("isDiscoverable", AttributeValue.builder().bool(false).build())
        }

        val item = withTimestamps(baseItem)

        val putReq = PutItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .item(item)
            .build()

        dynamoDbClient.putItem(putReq)
        logger.info { "Onboarded user $sub in DynamoDB with customerId: $customerId" }
        generatedUsername
    }

    suspend fun getCustomerProfileByCustomerId(customerId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val queryReq = QueryRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .indexName(DynamoDBConstants.CUSTOMER_PROFILE_CUSTOMER_ID_GSI)
                .keyConditionExpression("customerId = :cid")
                .expressionAttributeValues(
                    mapOf(":cid" to AttributeValue.builder().s(customerId).build())
                )
                .limit(1)
                .build()

            val response = dynamoDbClient.query(queryReq)
            val item = response.items().firstOrNull() ?: return@withContext null

            // Defer to getCustomerProfile for username backfill when missing —
            // the item carries sub and client, so the keyed lookup can run.
            if (!item.containsKey("username") || item["username"]?.s().isNullOrBlank()) {
                val sub = item["sub"]?.s()
                val client = item["client"]?.s()
                if (sub != null && client != null) {
                    return@withContext getCustomerProfile(sub, client)
                }
            }
            item
        }

    suspend fun getCustomerProfile(sub: String, client: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .key(
                    mapOf(
                        SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                        CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
                    )
                )
                .build()

            val response = dynamoDbClient.getItem(request)
            var item = response.item().takeIf { it.isNotEmpty() } ?: return@withContext null

            if (!item.containsKey("username") || item["username"]?.s().isNullOrBlank()) {
                val customerId = item["customerId"]?.s() ?: return@withContext item
                val name = item["name"]?.s()

                try {
                    val generatedUsername = generateAndReserveUsername(sub, client, customerId, name)
                    val updateReq = UpdateItemRequest.builder()
                        .tableName(CUSTOMER_PROFILE_TABLE)
                        .key(mapOf(
                            SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                            CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
                        ))
                        .updateExpression("SET username = :u, isDiscoverable = if_not_exists(isDiscoverable, :d)")
                        .expressionAttributeValues(mapOf(
                            ":u" to AttributeValue.builder().s(generatedUsername).build(),
                            ":d" to AttributeValue.builder().bool(false).build()
                        ))
                        .build()
                    dynamoDbClient.updateItem(updateReq)

                    val updatedItem = item.toMutableMap()
                    updatedItem["username"] = AttributeValue.builder().s(generatedUsername).build()
                    if (!updatedItem.containsKey("isDiscoverable")) {
                        updatedItem["isDiscoverable"] = AttributeValue.builder().bool(false).build()
                    }
                    item = updatedItem
                } catch (e: Exception) {
                    logger.error("Failed to lazy generate username for $sub", e)
                }
            }

            return@withContext item
        }

    suspend fun updateUsername(
        sub: String,
        client: String,
        customerId: String,
        oldUsername: String?,
        newUsername: String
    ) = withContext(Dispatchers.IO) {
        // Reserve new username
        val putUsernameReq = PutItemRequest.builder()
            .tableName(DynamoDBConstants.USERNAME_LOOKUP_TABLE)
            .item(mapOf(
                "username" to AttributeValue.builder().s(newUsername).build(),
                "recordType" to AttributeValue.builder().s("USER").build(),
                "customerId" to AttributeValue.builder().s(customerId).build()
            ))
            .conditionExpression("attribute_not_exists(username)")
            .build()

        try {
            dynamoDbClient.putItem(putUsernameReq)
        } catch (e: ConditionalCheckFailedException) {
            throw IllegalArgumentException("Username is already taken")
        }

        // Update profile
        val updateReq = UpdateItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .key(mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
            ))
            .updateExpression("SET username = :u")
            .expressionAttributeValues(mapOf(":u" to AttributeValue.builder().s(newUsername).build()))
            .build()
        dynamoDbClient.updateItem(updateReq)

        // Cleanup old
        if (!oldUsername.isNullOrBlank()) {
            val delReq = DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.USERNAME_LOOKUP_TABLE)
                .key(mapOf("username" to AttributeValue.builder().s(oldUsername).build()))
                .build()
            dynamoDbClient.deleteItem(delReq)
        }
    }

    suspend fun updateDiscoverability(
        sub: String,
        client: String,
        isDiscoverable: Boolean
    ) = withContext(Dispatchers.IO) {
        val updateReq = UpdateItemRequest.builder()
            .tableName(CUSTOMER_PROFILE_TABLE)
            .key(mapOf(
                SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
            ))
            .updateExpression("SET isDiscoverable = :d")
            .expressionAttributeValues(mapOf(":d" to AttributeValue.builder().bool(isDiscoverable).build()))
            .build()
        dynamoDbClient.updateItem(updateReq)
    }

    suspend fun searchByUsername(usernamePrefix: String): List<com.genflowly.models.api.SearchCustomerResponse> = withContext(Dispatchers.IO) {
        val queryReq = QueryRequest.builder()
            .tableName(DynamoDBConstants.USERNAME_LOOKUP_TABLE)
            .indexName(DynamoDBConstants.USERNAME_RECORD_TYPE_GSI)
            .keyConditionExpression("recordType = :type AND begins_with(username, :prefix)")
            .expressionAttributeValues(mapOf(
                ":type" to AttributeValue.builder().s("USER").build(),
                ":prefix" to AttributeValue.builder().s(usernamePrefix).build()
            ))
            .limit(5)
            .build()

        val response = dynamoDbClient.query(queryReq)
        val results = mutableListOf<com.genflowly.models.api.SearchCustomerResponse>()

        for (item in response.items()) {
            val customerId = item["customerId"]?.s() ?: continue
            val username = item["username"]?.s() ?: continue

            val profileItem = getCustomerProfileByCustomerId(customerId) ?: continue
            val isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false
            if (!isDiscoverable) continue

            results.add(
                com.genflowly.models.api.SearchCustomerResponse(
                    customerId = profileItem["customerId"]?.s() ?: "",
                    name = profileItem["name"]?.s(),
                    username = username,
                    picture = profileItem["picture"]?.s()
                )
            )
        }

        results
    }

    /**
     * Query customer profile by sub only (partition key)
     * Returns the first matching profile if multiple clients exist for the same sub
     */
    suspend fun queryCustomerProfileBySub(sub: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val request = QueryRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .keyConditionExpression("#sub = :sub")
                .expressionAttributeNames(
                    mapOf("#sub" to SUB_PARTITION_KEY)
                )
                .expressionAttributeValues(
                    mapOf(":sub" to AttributeValue.builder().s(sub).build())
                )
                .build()

            val response = dynamoDbClient.query(request)
            // A sub can hold one profile per app (client sort key). Sub-only
            // resolution is a legacy fallback — prefer the web-app profile so an
            // additionally-created ADMIN_PANEL row (which sorts first) can't
            // hijack web-app requests.
            val items = response.items()
            return@withContext items.firstOrNull { it[CLIENT_SORT_KEY]?.s() == "REACT_APP" }
                ?: items.firstOrNull()
        }

    // ─── Preferences ──────────────────────────────────────────────────────────

    suspend fun savePreferences(
        customerId: String,
        preferredModels: List<AIConfig>?,
        preferredGenerativeMode: AIMode?,
        otherPreferences: Map<String, String>?,
        embeddingMode: String? = null,
        embeddingModel: String? = null,
        preferredInstructionId: String? = null,
        instructionFallbackMode: String? = null,
        preferredAgentId: String? = null
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val updateParts = mutableListOf<String>()
            val attrNames = mutableMapOf<String, String>()
            val attrValues = mutableMapOf<String, AttributeValue>()

            // Always update updatedAt
            updateParts.add("#updatedAt = :updatedAt")
            attrNames["#updatedAt"] = "updatedAt"
            attrValues[":updatedAt"] = AttributeValue.builder().s(now).build()

            // set createdAt if not exists
            updateParts.add("#createdAt = if_not_exists(#createdAt, :createdAt)")
            attrNames["#createdAt"] = "createdAt"
            attrValues[":createdAt"] = AttributeValue.builder().s(now).build()

            if (preferredGenerativeMode != null) {
                updateParts.add("#preferredGenerativeMode = :preferredGenerativeMode")
                attrNames["#preferredGenerativeMode"] = "preferredGenerativeMode"
                attrValues[":preferredGenerativeMode"] = AttributeValue.builder().s(preferredGenerativeMode.name).build()
            }

            if (preferredModels != null) {
                updateParts.add("#preferredModels = :preferredModels")
                attrNames["#preferredModels"] = "preferredModels"
                attrValues[":preferredModels"] = aiConfigToAttributeValue(preferredModels)
            }

            if (!otherPreferences.isNullOrEmpty()) {
                updateParts.add("#otherPreferences = :otherPreferences")
                attrNames["#otherPreferences"] = "otherPreferences"
                attrValues[":otherPreferences"] = AttributeValue.builder().m(
                    otherPreferences.mapValues { AttributeValue.builder().s(it.value).build() }
                ).build()
            }

            if (embeddingMode != null) {
                updateParts.add("#embeddingMode = :embeddingMode")
                attrNames["#embeddingMode"] = "embeddingMode"
                attrValues[":embeddingMode"] = AttributeValue.builder().s(embeddingMode).build()
            }

            if (embeddingModel != null) {
                updateParts.add("#embeddingModel = :embeddingModel")
                attrNames["#embeddingModel"] = "embeddingModel"
                attrValues[":embeddingModel"] = AttributeValue.builder().s(embeddingModel).build()
            }

            if (preferredInstructionId != null) {
                updateParts.add("#preferredInstructionId = :preferredInstructionId")
                attrNames["#preferredInstructionId"] = "preferredInstructionId"
                attrValues[":preferredInstructionId"] = AttributeValue.builder().s(preferredInstructionId).build()
            }

            if (instructionFallbackMode != null) {
                updateParts.add("#instructionFallbackMode = :instructionFallbackMode")
                attrNames["#instructionFallbackMode"] = "instructionFallbackMode"
                attrValues[":instructionFallbackMode"] = AttributeValue.builder().s(instructionFallbackMode).build()
            }

            // Blank = clear (revert to the default agent), non-blank = set.
            val removeParts = mutableListOf<String>()
            if (preferredAgentId != null) {
                attrNames["#preferredAgentId"] = "preferredAgentId"
                if (preferredAgentId.isBlank()) {
                    removeParts.add("#preferredAgentId")
                } else {
                    updateParts.add("#preferredAgentId = :preferredAgentId")
                    attrValues[":preferredAgentId"] = AttributeValue.builder().s(preferredAgentId).build()
                }
            }

            val updateReq = UpdateItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()))
                .updateExpression(
                    "SET " + updateParts.joinToString(", ") +
                        (if (removeParts.isNotEmpty()) " REMOVE " + removeParts.joinToString(", ") else "")
                )
                .expressionAttributeNames(attrNames)
                .expressionAttributeValues(attrValues)
                .build()

            dynamoDbClient.updateItem(updateReq)
            logger.info("Saved preferences for customer $customerId to DynamoDB (Upsert)")
        } catch (e: Exception) {
            logger.error("Failed to save Customer Preferences to DynamoDB", e)
            throw e
        }
    }

    suspend fun getAIConfigPreferences(customerId: String): AIConfigPreferences? =
        withContext(Dispatchers.IO) {
            val key = mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
            )

            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(key)
                .build()

            val response = dynamoDbClient.getItem(request)
            val item = response.item() ?: return@withContext null

            val modelsAttr = item["preferredModels"]
            val preferredModels = modelsAttr?.let { attributeValueToAiConfig(it) }

            val modeAttr = item["preferredGenerativeMode"]?.s()
            val preferredGenerativeMode = modeAttr?.let { AIMode.valueOf(it) }

            AIConfigPreferences(
                preferredModels = preferredModels,
                preferredGenerativeMode = preferredGenerativeMode,
                embeddingMode = item["embeddingMode"]?.s(),
                embeddingModel = item["embeddingModel"]?.s(),
                preferredInstructionId = item["preferredInstructionId"]?.s(),
                instructionFallbackMode = item["instructionFallbackMode"]?.s(),
                preferredAgentId = item["preferredAgentId"]?.s()
            )
        }

    /** Free-form key/value preferences (e.g. memoryEnabled) — empty map when none stored. */
    suspend fun getOtherPreferences(customerId: String): Map<String, String> =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(CUSTOMER_PREFERENCES_TABLE)
                .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()))
                .build()

            val item = dynamoDbClient.getItem(request).item() ?: return@withContext emptyMap()
            item["otherPreferences"]?.m()?.mapValues { it.value.s() ?: "" } ?: emptyMap()
        }
}
