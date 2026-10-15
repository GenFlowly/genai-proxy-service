package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.utils.LogSanitize
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
import software.amazon.awssdk.services.dynamodb.model.Delete
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.Put
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
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

            // A deleted customer's renamed row must never mint (and reserve) a
            // fresh, searchable handle on read
            if (sub.startsWith(RetentionTables.DELETED_SUB_PREFIX)) return@withContext item

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
                    logger.error("Failed to lazy generate username for ${LogSanitize.sub(sub)}", e)
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
        embeddingModelConversations: String? = null,
        embeddingModelNotes: String? = null,
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

            if (embeddingModelConversations != null) {
                updateParts.add("#embeddingModelConversations = :embeddingModelConversations")
                attrNames["#embeddingModelConversations"] = "embeddingModelConversations"
                attrValues[":embeddingModelConversations"] =
                    AttributeValue.builder().s(embeddingModelConversations).build()
            }

            if (embeddingModelNotes != null) {
                updateParts.add("#embeddingModelNotes = :embeddingModelNotes")
                attrNames["#embeddingModelNotes"] = "embeddingModelNotes"
                attrValues[":embeddingModelNotes"] = AttributeValue.builder().s(embeddingModelNotes).build()
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
                embeddingModelConversations = item["embeddingModelConversations"]?.s(),
                embeddingModelNotes = item["embeddingModelNotes"]?.s(),
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

    // ─── System vendor allowlist ──────────────────────────────────────────────
    // One system-scoped item in the preferences table (the "#" makes the key
    // impossible to collide with real customer ids). null = never configured.

    suspend fun getVendorAllowlist(): List<String>? = withContext(Dispatchers.IO) {
        val request = GetItemRequest.builder()
            .tableName(CUSTOMER_PREFERENCES_TABLE)
            .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(VENDOR_ALLOWLIST_ITEM_ID).build()))
            .build()
        val item = dynamoDbClient.getItem(request).item()?.takeIf { it.isNotEmpty() } ?: return@withContext null
        item["allowedVendors"]?.l()?.mapNotNull { it.s() }
    }

    suspend fun saveVendorAllowlist(allowedVendors: List<String>, updatedBy: String) =
        withContext(Dispatchers.IO) {
            val item = mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(VENDOR_ALLOWLIST_ITEM_ID).build(),
                "allowedVendors" to AttributeValue.builder()
                    .l(allowedVendors.map { AttributeValue.builder().s(it).build() })
                    .build(),
                "updatedBy" to AttributeValue.builder().s(updatedBy).build(),
                "updatedAt" to AttributeValue.builder().s(Instant.now().toString()).build(),
            )
            dynamoDbClient.putItem(
                PutItemRequest.builder().tableName(CUSTOMER_PREFERENCES_TABLE).item(item).build()
            )
            logger.info("Vendor allowlist saved by $updatedBy: ${allowedVendors.size} vendor(s)")
        }

    // ─── Account deletion (plan 3.9, C9) ──────────────────────────────────────

    /** The login a profile row is keyed by, read without the username backfill. */
    data class ProfileLogin(val sub: String, val client: String, val username: String?) {
        val deleted: Boolean get() = sub.startsWith(RetentionTables.DELETED_SUB_PREFIX)
    }

    enum class DeletedRekeyResult { REKEYED, ALREADY_REKEYED, NOT_FOUND }

    /**
     * The customer's profile row through customerIdIndex, raw: unlike
     * [getCustomerProfileByCustomerId] it never backfills a username.
     */
    suspend fun findProfileLogin(customerId: String): ProfileLogin? =
        rawProfileByCustomerId(customerId)?.let { item ->
            ProfileLogin(
                sub = item[SUB_PARTITION_KEY]?.s() ?: return@let null,
                client = item[CLIENT_SORT_KEY]?.s() ?: return@let null,
                username = item["username"]?.s()?.takeIf { it.isNotBlank() }
            )
        }

    /** customerIds of every profile (one per app client) of an Auth0 login. */
    suspend fun customerIdsForSub(sub: String): List<String> = withContext(Dispatchers.IO) {
        dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .keyConditionExpression("#sub = :sub")
                .expressionAttributeNames(mapOf("#sub" to SUB_PARTITION_KEY))
                .expressionAttributeValues(mapOf(":sub" to AttributeValue.builder().s(sub).build()))
                .consistentRead(true)
                .build()
        ).items().mapNotNull { it[CUSTOMER_ID_KEY]?.s() }
    }

    private suspend fun rawProfileByCustomerId(customerId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            val items = dynamoDbClient.query(
                QueryRequest.builder()
                    .tableName(CUSTOMER_PROFILE_TABLE)
                    .indexName(DynamoDBConstants.CUSTOMER_PROFILE_CUSTOMER_ID_GSI)
                    .keyConditionExpression("customerId = :cid")
                    .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                    .build()
            ).items()
            // A stale index entry of the pre-rename row may linger next to the renamed one
            items.firstOrNull { it[SUB_PARTITION_KEY]?.s()?.startsWith(RetentionTables.DELETED_SUB_PREFIX) == true }
                ?: items.firstOrNull()
        }

    /**
     * Keeps a deleted customer's profile row but takes it away from their
     * login: in one TransactWriteItems the row is re-written under
     * sub = "DELETED#{customerId}" (same client and every other attribute,
     * username included) with name "Deleted User" and the original
     * (sub, client) row is deleted; then the customer's UsernameLookup row
     * is deleted. Shared conversations show "Deleted User" through the
     * unchanged customerIdIndex read path, while neither the old sub nor a
     * still-valid token resolves to the account any more. Idempotent.
     */
    suspend fun rekeyDeletedCustomer(customerId: String): DeletedRekeyResult = withContext(Dispatchers.IO) {
        val item = rawProfileByCustomerId(customerId) ?: return@withContext DeletedRekeyResult.NOT_FOUND
        val sub = item[SUB_PARTITION_KEY]?.s() ?: return@withContext DeletedRekeyResult.NOT_FOUND
        val client = item[CLIENT_SORT_KEY]?.s() ?: return@withContext DeletedRekeyResult.NOT_FOUND
        val username = item["username"]?.s()?.takeIf { it.isNotBlank() }
        val deletedSub = RetentionTables.DELETED_SUB_PREFIX + customerId
        val deletedKey = mapOf(
            SUB_PARTITION_KEY to AttributeValue.builder().s(deletedSub).build(),
            CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
        )

        if (sub == deletedSub) {
            finishDeletedRekey(customerId, deletedKey, username)
            return@withContext DeletedRekeyResult.ALREADY_REKEYED
        }

        val renamed = item + mapOf(
            SUB_PARTITION_KEY to AttributeValue.builder().s(deletedSub).build(),
            "name" to AttributeValue.builder().s(RetentionTables.DELETED_USER_NAME).build()
        )
        val writes = mutableListOf(
            TransactWriteItem.builder().put(
                Put.builder()
                    .tableName(CUSTOMER_PROFILE_TABLE)
                    .item(renamed)
                    .conditionExpression("attribute_not_exists(#sub)")
                    .expressionAttributeNames(mapOf("#sub" to SUB_PARTITION_KEY))
                    .build()
            ).build(),
            TransactWriteItem.builder().delete(
                Delete.builder()
                    .tableName(CUSTOMER_PROFILE_TABLE)
                    .key(mapOf(
                        SUB_PARTITION_KEY to AttributeValue.builder().s(sub).build(),
                        CLIENT_SORT_KEY to AttributeValue.builder().s(client).build()
                    ))
                    .conditionExpression("#cid = :cid")
                    .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                    .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                    .build()
            ).build()
        )
        try {
            dynamoDbClient.transactWriteItems(TransactWriteItemsRequest.builder().transactItems(writes).build())
            logger.info { "Re-keyed the profile of deleted customer $customerId" }
            username?.let { deleteUsernameLookup(it, customerId) }
            DeletedRekeyResult.REKEYED
        } catch (e: TransactionCanceledException) {
            // A stale index read of a row an earlier attempt already re-keyed
            val alreadyRekeyed = dynamoDbClient.getItem(
                GetItemRequest.builder().tableName(CUSTOMER_PROFILE_TABLE).key(deletedKey).consistentRead(true).build()
            ).item()?.isNotEmpty() == true
            if (!alreadyRekeyed) throw e
            finishDeletedRekey(customerId, deletedKey, username)
            DeletedRekeyResult.ALREADY_REKEYED
        }
    }

    /** Re-run path: the name is "Deleted User" and the UsernameLookup row is gone. */
    private fun finishDeletedRekey(customerId: String, deletedKey: Map<String, AttributeValue>, username: String?) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(CUSTOMER_PROFILE_TABLE)
                .key(deletedKey)
                .updateExpression("SET #n = :n")
                .conditionExpression("attribute_exists(#sub)")
                .expressionAttributeNames(mapOf("#n" to "name", "#sub" to SUB_PARTITION_KEY))
                .expressionAttributeValues(mapOf(":n" to AttributeValue.builder().s(RetentionTables.DELETED_USER_NAME).build()))
                .build()
        )
        if (username != null) deleteUsernameLookup(username, customerId)
    }

    /**
     * Deletes the handle's UsernameLookup row, so username search no longer
     * offers the deleted customer - only while the row is still this
     * customer's. Outside the re-key transaction: a handle someone else holds
     * must not block the re-key. Idempotent.
     */
    private fun deleteUsernameLookup(username: String, customerId: String) {
        try {
            dynamoDbClient.deleteItem(
                DeleteItemRequest.builder()
                    .tableName(DynamoDBConstants.USERNAME_LOOKUP_TABLE)
                    .key(mapOf(DynamoDBConstants.USERNAME_KEY to AttributeValue.builder().s(username).build()))
                    .conditionExpression("attribute_not_exists(#u) OR #cid = :cid")
                    .expressionAttributeNames(mapOf("#u" to DynamoDBConstants.USERNAME_KEY, "#cid" to CUSTOMER_ID_KEY))
                    .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                    .build()
            )
        } catch (e: ConditionalCheckFailedException) {
            // The handle now belongs to someone else: leave their row alone
        }
    }

    companion object {
        private const val VENDOR_ALLOWLIST_ITEM_ID = "SYSTEM#VENDOR_ALLOWLIST"
    }
}
