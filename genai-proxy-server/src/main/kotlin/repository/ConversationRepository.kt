package com.genflowly.repository

import com.genflowly.DynamoDBConstants.ARCHIVED_AT_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_CUSTOMER_UPDATED_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_ID_SORT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_TABLE
import com.genflowly.DynamoDBConstants.PENDING_RUNS_KEY
import com.genflowly.DynamoDBConstants.PINNED_AT_KEY
import com.genflowly.DynamoDBConstants.PROJECT_ID_KEY
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetCustomerConversationsResponse
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * One durable run generating a conversation's reply, tracked in the pendingRuns
 * String Set. Encoded as a single delimited string (unit-separator (U+001F), absent
 * from UUID ids / vendor enum / model names) so it fits one set element.
 */
data class PendingRun(
    val responseMessageId: String,
    val runId: String,
    val vendor: String,
    val model: String,
) {
    fun encode(): String = listOf(responseMessageId, runId, vendor, model).joinToString(DELIM)

    companion object {
        private const val DELIM = "\u001F"
        fun decode(s: String): PendingRun? {
            val p = s.split(DELIM)
            return if (p.size == 4 && p[0].isNotEmpty() && p[1].isNotEmpty()) PendingRun(p[0], p[1], p[2], p[3]) else null
        }
    }
}

/**
 * Data access for the Conversation and Message tables.
 */
class ConversationRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun createConversation(
        conversation: Conversation
    ) = withContext(Dispatchers.IO) {
        try {
            val base = mutableMapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder()
                    .s(conversation.customerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s
                    (conversation.conversationId)
                    .build(),
                "client" to AttributeValue.builder().s(conversation.client).build(),
            )
            conversation.projectId?.takeIf { it.isNotBlank() }?.let {
                base[PROJECT_ID_KEY] = AttributeValue.builder().s(it).build()
            }
            val item = withTimestamps(base)

            val putReq = PutItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Created Conversation for ${conversation
                .customerId} to DynamoDB")
        } catch (e: Exception) {
            logger.error("Failed to Create Conversation in DynamoDB", e)
            throw e
        }
    }

    /**
     * Bumps the conversation's updatedAt to now, so it surfaces at the top of
     * the last-activity-ordered listing ([CONVERSATION_CUSTOMER_UPDATED_GSI_KEY]).
     *
     * Guarded by attribute_exists so a wrong (customerId, conversationId) pair —
     * e.g. a sender who isn't the owner of a shared conversation — never
     * creates a phantom row. Returns false in that case instead of throwing.
     */
    suspend fun touchConversation(
        customerId: String,
        conversationId: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #ua = :now")
                    .conditionExpression("attribute_exists(#cid)")
                    .expressionAttributeNames(mapOf("#ua" to "updatedAt", "#cid" to CONVERSATION_ID_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        } catch (e: Exception) {
            // Best-effort: a failed touch must not fail the message write
            logger.error("Failed to touch conversation $conversationId", e)
            false
        }
    }

    /**
     * Adds a durable run to the set currently generating this conversation's
     * reply, so a reload can rediscover "assistant is mid-run" and reattach. A
     * multi-vendor turn fans out to N concurrent runs, so this is a String Set —
     * each parallel vendor request ADDs its own entry atomically without clobbering
     * the others. The set lives on the conversation OWNER's row, where reads and
     * the purge look for it, also when the caller is a share recipient.
     * Best-effort: a failure must never fail the generation. Returns false if the
     * conversation row doesn't exist.
     */
    suspend fun addPendingRun(
        callerCustomerId: String,
        conversationId: String,
        run: PendingRun
    ): Boolean = updatePendingRuns(callerCustomerId, conversationId, "ADD #pr :e", run, "add")

    /**
     * Removes one finished run from the pending set on the owner's row
     * (DynamoDB drops the attribute once it's empty). Best-effort. Clears only
     * this run's entry so the other vendors' in-flight runs stay reattachable.
     */
    suspend fun removePendingRun(
        callerCustomerId: String,
        conversationId: String,
        run: PendingRun
    ): Boolean = updatePendingRuns(callerCustomerId, conversationId, "DELETE #pr :e", run, "remove")

    /**
     * Applies [updateExpression] (on #pr with :e = [run]) to the conversation
     * owner's row. The caller's own key is tried first, which is the owner in
     * the common case; when no such row exists the caller is a share recipient
     * and the owner is resolved through the conversationId index. Every write
     * requires the row to exist: an UpdateItem on a missing key would otherwise
     * create a phantom Conversation row under the recipient, which the
     * conversationId index would then return alongside the owner's.
     */
    private suspend fun updatePendingRuns(
        callerCustomerId: String,
        conversationId: String,
        updateExpression: String,
        run: PendingRun,
        action: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            if (updatePendingRunsOn(callerCustomerId, conversationId, updateExpression, run)) return@withContext true
            val ownerCustomerId = getConversationById(conversationId)?.customerId
            ownerCustomerId != null && ownerCustomerId != callerCustomerId &&
                updatePendingRunsOn(ownerCustomerId, conversationId, updateExpression, run)
        } catch (e: Exception) {
            logger.error("Failed to $action pending run on conversation $conversationId", e)
            false
        }
    }

    /** One conditional pendingRuns update on (customerId, conversationId); false when that row doesn't exist. */
    private fun updatePendingRunsOn(
        customerId: String,
        conversationId: String,
        updateExpression: String,
        run: PendingRun
    ): Boolean = try {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .updateExpression(updateExpression)
                .conditionExpression("attribute_exists(#cid)")
                .expressionAttributeNames(mapOf("#pr" to PENDING_RUNS_KEY, "#cid" to CONVERSATION_ID_KEY))
                .expressionAttributeValues(mapOf(":e" to AttributeValue.builder().ss(run.encode()).build()))
                .build()
        )
        true
    } catch (e: ConditionalCheckFailedException) {
        false
    }

    /**
     * The durable runs currently generating this conversation's reply — one per
     * in-flight vendor — or empty. Malformed/legacy entries are skipped.
     */
    suspend fun getPendingRuns(
        customerId: String,
        conversationId: String
    ): List<PendingRun> = withContext(Dispatchers.IO) {
        try {
            val response = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .projectionExpression("#pr")
                    .expressionAttributeNames(mapOf("#pr" to PENDING_RUNS_KEY))
                    .build()
            )
            response.item()?.get(PENDING_RUNS_KEY)?.ss()?.mapNotNull { PendingRun.decode(it) } ?: emptyList()
        } catch (e: Exception) {
            logger.error("Failed to read pending runs for conversation $conversationId", e)
            emptyList()
        }
    }

    suspend fun updateConversationTitle(
        conversationId: String,
        customerId: String,
        title: String
    ) = withContext(Dispatchers.IO) {
        try {
            val updateReq = UpdateItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .updateExpression("SET #t = :title")
                .expressionAttributeNames(mapOf("#t" to "title"))
                .expressionAttributeValues(mapOf(":title" to AttributeValue.builder().s(title).build()))
                .build()

            dynamoDbClient.updateItem(updateReq)
            // Title text is derived from the user's conversation — id only.
            logger.info("Updated title for conversation $conversationId")
        } catch (e: Exception) {
            logger.error("Failed to update conversation title in DynamoDB", e)
        }
    }

    suspend fun archiveConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #aa = :now")
                    .expressionAttributeNames(mapOf("#aa" to ARCHIVED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Archived conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to archive conversation $conversationId", e)
            throw e
        }
    }

    suspend fun unarchiveConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("REMOVE #aa")
                    .expressionAttributeNames(mapOf("#aa" to ARCHIVED_AT_KEY))
                    .build()
            )
            logger.info("Unarchived conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to unarchive conversation $conversationId", e)
            throw e
        }
    }

    suspend fun pinConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #pa = :now")
                    // Guard against creating a phantom row for a conversation that doesn't exist
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pa" to PINNED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Pinned conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to pin conversation $conversationId", e)
            throw e
        }
    }

    suspend fun unpinConversation(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("REMOVE #pa")
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pa" to PINNED_AT_KEY))
                    .build()
            )
            logger.info("Unpinned conversation $conversationId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to unpin conversation $conversationId", e)
            throw e
        }
    }

    /**
     * Puts the conversation into a project. SET overwrites any previous
     * assignment, so this is also the "move between projects" write.
     */
    suspend fun setConversationProject(
        conversationId: String,
        customerId: String,
        projectId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #pid = :pid")
                    // Guard against creating a phantom row for a conversation that doesn't exist
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pid" to PROJECT_ID_KEY))
                    .expressionAttributeValues(mapOf(":pid" to AttributeValue.builder().s(projectId).build()))
                    .build()
            )
            logger.info("Assigned conversation $conversationId to project $projectId for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to assign conversation $conversationId to project $projectId", e)
            throw e
        }
    }

    suspend fun removeConversationProject(
        conversationId: String,
        customerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("REMOVE #pid")
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pid" to PROJECT_ID_KEY))
                    .build()
            )
            logger.info("Unassigned conversation $conversationId from its project for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to unassign conversation $conversationId from its project", e)
            throw e
        }
    }

    suspend fun isConversationArchived(
        conversationId: String,
        customerId: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .projectionExpression(ARCHIVED_AT_KEY)
                .build()
            val response = dynamoDbClient.getItem(getReq)
            response.item()?.containsKey(ARCHIVED_AT_KEY) == true
        } catch (e: Exception) {
            logger.error("Failed to check archive status for conversation $conversationId", e)
            false
        }
    }

    suspend fun getConversationTitle(
        conversationId: String,
        customerId: String
    ): String? = withContext(Dispatchers.IO) {
        try {
            val getReq = GetItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .build()
            val response = dynamoDbClient.getItem(getReq)
            response.item()?.get("title")?.s()
        } catch (e: Exception) {
            logger.error("Failed to get conversation title from DynamoDB", e)
            null
        }
    }

    /**
     * Looks up a Conversation row by conversationId alone via the [CONVERSATION_ID_GSI_KEY] GSI.
     * Needed for users who have a conversation shared with them and therefore don't
     * know the owner's customerId.
     */
    suspend fun getConversationById(conversationId: String): Conversation? = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(CONVERSATION_TABLE)
            .indexName(CONVERSATION_ID_GSI_KEY)
            .keyConditionExpression("$CONVERSATION_ID_KEY = :cid")
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(conversationId).build()
            ))
            .limit(1)
            .build()

        val response = dynamoDbClient.query(request)
        val item = response.items().firstOrNull() ?: return@withContext null
        val ownerCustomerId = item[CUSTOMER_ID_KEY]?.s() ?: return@withContext null
        val client = item["client"]?.s() ?: return@withContext null
        Conversation(
            conversationId = conversationId,
            customerId = ownerCustomerId,
            client = client
        )
    }

    /**
     * Fetches up to [pageSize] conversations for the given customer, most
     * recently updated first, using a GSI on the Conversation table keyed by
     * customerId and sorted by updatedAt (bumped on every message write).
     *
     * @param customerId   Partition value to filter by.
     * @param pageSize     Maximum number of items to return (default 10).
     * @param exclusiveStartKey  Opaque JSON string returned as [GetCustomerConversationsResponse.lastEvaluatedKey]
     *                     from a previous call. Pass null for the first page.
     */
    suspend fun getConversationsByCustomerPaginated(
        customerId: String,
        pageSize: Int = 10,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse = withContext(Dispatchers.IO) {
        val queryBuilder = QueryRequest.builder()
            .tableName(CONVERSATION_TABLE)
            .indexName(CONVERSATION_CUSTOMER_UPDATED_GSI_KEY)
            .keyConditionExpression("#cid = :cid")
            .filterExpression("attribute_not_exists(#aa)")
            .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY, "#aa" to ARCHIVED_AT_KEY))
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(customerId).build()
            ))
            .scanIndexForward(false) // newest first (descending by sort key)
            .limit(pageSize)

        // Resume from prior page if a continuation token was supplied
        if (!exclusiveStartKey.isNullOrBlank()) {
            try {
                val keyMap: Map<String, String> = Json.decodeFromString(exclusiveStartKey)
                val startKey = keyMap.mapValues { (_, v) -> AttributeValue.builder().s(v).build() }
                queryBuilder.exclusiveStartKey(startKey)
            } catch (e: Exception) {
                logger.warn("Failed to parse exclusiveStartKey, starting from beginning: ${e.message}")
            }
        }

        val response = dynamoDbClient.query(queryBuilder.build())

        // The listing GSI's INCLUDE projection doesn't carry projectId (same
        // reason the pinned query reads the base table), and changing a GSI
        // projection means replacing the index. One BatchGetItem on the base
        // table per page (≤50 keys) fills the gap instead.
        val pageConversationIds = response.items().mapNotNull { it[CONVERSATION_ID_KEY]?.s() }
        val projectIdByConversation: Map<String, String> =
            if (pageConversationIds.isEmpty()) emptyMap()
            else dynamoDbClient.batchGetWithRetry(
                tableName = CONVERSATION_TABLE,
                keys = pageConversationIds.map {
                    mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(it).build()
                    )
                },
                projectionExpression = "$CONVERSATION_ID_KEY, #pid",
                expressionAttributeNames = mapOf("#pid" to PROJECT_ID_KEY)
            ).mapNotNull { item ->
                val convId = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null
                item[PROJECT_ID_KEY]?.s()?.let { convId to it }
            }.toMap()

        val conversations = response.items().mapNotNull { item ->
            val convId    = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null
            val title     = item["title"]?.s()
            val createdAt = item["createdAt"]?.s()
            val updatedAt = item["updatedAt"]?.s()

            val vendors = sidebarVendors(convId)

            ConversationSummary(
                conversationId = convId,
                title = title,
                createdAt = createdAt,
                updatedAt = updatedAt,
                vendors = vendors,
                projectId = projectIdByConversation[convId]
            )
        }

        // Serialise LastEvaluatedKey as a simple JSON string so it is safe to round-trip through the API
        val nextPageToken: String? = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
            val encoded = response.lastEvaluatedKey().mapValues { (_, v) -> v.s() ?: "" }
            Json.encodeToString(encoded)
        } else null

        GetCustomerConversationsResponse(conversations = conversations, lastEvaluatedKey = nextPageToken)
    }

    /**
     * Fetches all pinned (and not archived) conversations for the customer,
     * most recently pinned first.
     *
     * Queries the base table (not the customerId GSI) because the GSI projection
     * doesn't include [PINNED_AT_KEY] — the base table returns full items, so the
     * pinned filter can be evaluated without an index change.
     */
    suspend fun getPinnedConversationsByCustomer(
        customerId: String,
        maxItems: Int = 50
    ): List<ConversationSummary> = withContext(Dispatchers.IO) {
        val pinnedItems = mutableListOf<Map<String, AttributeValue>>()
        var startKey: Map<String, AttributeValue>? = null

        // A filtered query can return empty pages with a lastEvaluatedKey, so
        // keep paging until the key is absent (or we have enough items).
        do {
            val queryBuilder = QueryRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .keyConditionExpression("#cid = :cid")
                .filterExpression("attribute_exists(#pa) AND attribute_not_exists(#aa)")
                .expressionAttributeNames(mapOf(
                    "#cid" to CUSTOMER_ID_KEY,
                    "#pa" to PINNED_AT_KEY,
                    "#aa" to ARCHIVED_AT_KEY
                ))
                .expressionAttributeValues(mapOf(
                    ":cid" to AttributeValue.builder().s(customerId).build()
                ))
            startKey?.let { queryBuilder.exclusiveStartKey(it) }

            val response = dynamoDbClient.query(queryBuilder.build())
            pinnedItems += response.items()
            startKey = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
                response.lastEvaluatedKey()
            } else null
        } while (startKey != null && pinnedItems.size < maxItems)

        pinnedItems
            .sortedByDescending { it[PINNED_AT_KEY]?.s() ?: "" }
            .take(maxItems)
            .mapNotNull { item ->
                val convId = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null

                val vendors = sidebarVendors(convId)

                ConversationSummary(
                    conversationId = convId,
                    title = item["title"]?.s(),
                    createdAt = item["createdAt"]?.s(),
                    updatedAt = item["updatedAt"]?.s(),
                    pinnedAt = item[PINNED_AT_KEY]?.s(),
                    vendors = vendors,
                    projectId = item[PROJECT_ID_KEY]?.s()
                )
            }
    }

    /**
     * Ids of every (non-archived or archived alike) conversation currently
     * assigned to the project. Used by project delete to unassign them, so the
     * pagination loop is exhaustive — no early exit, no item cap.
     */
    suspend fun getConversationIdsByProject(
        customerId: String,
        projectId: String
    ): List<String> = withContext(Dispatchers.IO) {
        val ids = mutableListOf<String>()
        var startKey: Map<String, AttributeValue>? = null

        do {
            val queryBuilder = QueryRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .keyConditionExpression("#cid = :cid")
                .filterExpression("#pid = :pid")
                .expressionAttributeNames(mapOf(
                    "#cid" to CUSTOMER_ID_KEY,
                    "#pid" to PROJECT_ID_KEY
                ))
                .expressionAttributeValues(mapOf(
                    ":cid" to AttributeValue.builder().s(customerId).build(),
                    ":pid" to AttributeValue.builder().s(projectId).build()
                ))
                .projectionExpression(CONVERSATION_ID_KEY)
            startKey?.let { queryBuilder.exclusiveStartKey(it) }

            val response = dynamoDbClient.query(queryBuilder.build())
            ids += response.items().mapNotNull { it[CONVERSATION_ID_KEY]?.s() }
            startKey = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
                response.lastEvaluatedKey()
            } else null
        } while (startKey != null)

        ids
    }

    // ─── Messages ─────────────────────────────────────────────────────────────

    /**
     * Writes the async memory-extraction outcome onto a message. "[]" is the
     * terminal "nothing learned" marker that stops client polling.
     */
    suspend fun setMessageLearnedFacts(
        conversationId: String,
        messageId: String,
        factsJson: String
    ) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .key(mapOf(
                    "conversationId" to AttributeValue.builder().s(conversationId).build(),
                    "messageId" to AttributeValue.builder().s(messageId).build()
                ))
                .updateExpression("SET learnedFactsJson = :facts")
                .expressionAttributeValues(mapOf(
                    ":facts" to AttributeValue.builder().s(factsJson).build()
                ))
                .build()
        )
    }

    suspend fun getMessage(
        conversationId: String,
        messageId: String
    ): Message? = withContext(Dispatchers.IO) {

        val key = mapOf(
            "conversationId" to AttributeValue.builder().s(conversationId).build(),
            "messageId" to AttributeValue.builder().s(messageId).build()
        )

        val request = GetItemRequest.builder()
            .tableName(MESSAGE_TABLE)
            .key(key)
            .build()

        val response = dynamoDbClient.getItem(request)
        val item = response.item() ?: return@withContext null
        return@withContext itemToMessage(item)
    }

    /**
     * Every message of the conversation. One Query page stops at 1 MB, which
     * can be only 2-3 messages when thinking steps are large, so this follows
     * LastEvaluatedKey until the partition is exhausted.
     */
    suspend fun getMessagesForConversation(
        conversationId: String
    ): List<Message> = queryMessages(conversationId, maxPages = Int.MAX_VALUE)

    /**
     * Vendor badges for the conversation listings, from the first Query page
     * only (up to 1 MB): the listings run this for every conversation on every
     * page load, and a badge does not justify reading a long conversation in
     * full.
     */
    private suspend fun sidebarVendors(conversationId: String): List<String>? =
        queryMessages(conversationId, maxPages = 1)
            .flatMap { it.aiConfig }.map { it.aiVendor.name }.distinct().takeIf { it.isNotEmpty() }

    private suspend fun queryMessages(
        conversationId: String,
        maxPages: Int
    ): List<Message> = withContext(Dispatchers.IO) {
        val messages = mutableListOf<Message>()
        var startKey: Map<String, AttributeValue>? = null
        var pages = 0

        do {
            val queryBuilder = QueryRequest.builder()
                .tableName(MESSAGE_TABLE)
                .keyConditionExpression("conversationId = :cid")
                .expressionAttributeValues(mapOf(
                    ":cid" to AttributeValue.builder().s(conversationId).build()
                ))
            startKey?.let { queryBuilder.exclusiveStartKey(it) }

            val response = dynamoDbClient.query(queryBuilder.build())
            response.items().mapNotNullTo(messages) { itemToMessage(it) }
            pages++
            startKey = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
                response.lastEvaluatedKey()
            } else null
        } while (startKey != null && pages < maxPages)

        messages
    }

    suspend fun createMessage(
        message: Message
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(
                mutableMapOf(
                    CONVERSATION_ID_KEY to AttributeValue.builder()
                        .s(message.conversationId)
                        .build(),

                    MESSAGE_ID_SORT_KEY to AttributeValue.builder()
                        .s(message.messageId)
                        .build(),

                    CUSTOMER_ID_KEY to AttributeValue.builder()
                        .s(message.customerId)
                        .build(),

                    "sequence" to AttributeValue.builder()
                        .n(message.sequence?.toString() ?: "0")
                        .build(),

                    "client" to AttributeValue.builder()
                        .s(message.client)
                        .build(),

                    "aiConfig" to aiConfigToAttributeValue(message.aiConfig),

                    "role" to AttributeValue.builder()
                        .s(message.role)
                        .build(),

                    "text" to AttributeValue.builder()
                        .s(message.text)
                        .build(),

                    "systemPrompt" to AttributeValue.builder()
                        .s(message.systemPrompt)
                        .build(),

                    "previousMessageId" to AttributeValue.builder()
                        .s(message.previousMessageId ?: "")
                        .build(),

                    "instructionId" to AttributeValue.builder()
                        .s(message.instructionId ?: "")
                        .build(),

                    "instructionVersion" to AttributeValue.builder()
                        .s(message.instructionVersion ?: "")
                        .build()
                ).also { map ->
                    if (message.attachments.isNotEmpty()) {
                        map["attachments"] = attachmentsToAttributeValue(message.attachments)
                    }
                    message.toolCallsJson?.let {
                        map["toolCallsJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.toolResultsJson?.let {
                        map["toolResultsJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.webSourcesJson?.let {
                        map["webSourcesJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.inputTokens?.let {
                        map["inputTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.outputTokens?.let {
                        map["outputTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.totalTokens?.let {
                        map["totalTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.tokensReadFromCache?.let {
                        map["tokensReadFromCache"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.tokensWrittenToCache?.let {
                        map["tokensWrittenToCache"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.reasoningTokens?.let {
                        map["reasoningTokens"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.costUsd?.let {
                        map["costUsd"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.reasoningCostUsd?.let {
                        map["reasoningCostUsd"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.thinkingDurationMs?.let {
                        map["thinkingDurationMs"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    message.thinkingStepsJson?.let {
                        map["thinkingStepsJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.stopReason?.let {
                        map["stopReason"] = AttributeValue.builder().s(it).build()
                    }
                    message.fsNamespace?.takeIf { it.isNotBlank() }?.let {
                        map["fsNamespace"] = AttributeValue.builder().s(it).build()
                    }
                    message.runId?.takeIf { it.isNotBlank() }?.let {
                        map["runId"] = AttributeValue.builder().s(it).build()
                    }
                    // Written only while true, as a Number rather than a BOOL so
                    // the attribute can also key a sparse GSI (BOOL cannot).
                    if (message.claimPending) {
                        map["claimPending"] = AttributeValue.builder().n("1").build()
                    }
                    message.errorMessage?.takeIf { it.isNotBlank() }?.let {
                        map["errorMessage"] = AttributeValue.builder().s(it).build()
                    }
                }
            )

            val putReq = PutItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)

            logger.info(
                "Saved message for conversation {} to DynamoDB",
                message.conversationId
            )
        } catch (e: Exception) {
            logger.error("Failed to create Message in DynamoDB", e)
            throw e
        }
    }

    private fun itemToMessage(item: Map<String, AttributeValue>): Message? {
        val text = item["text"]?.s() ?: return null
        val sequenceStr = item["sequence"]?.n() ?: return null
        val client = item["client"]?.s() ?: return null
        val role = item["role"]?.s() ?: return null
        val customerId = item["customerId"]?.s() ?: return null
        val systemPrompt = item["systemPrompt"]?.s() ?: return null

        val previousMessageId = item["previousMessageId"]?.s()
        val instructionId = item["instructionId"]?.s()?.takeIf { it.isNotBlank() }
        val instructionVersion = item["instructionVersion"]?.s()?.takeIf { it.isNotBlank() }

        val sequence = sequenceStr.toIntOrNull() ?: return null

        val aiConfigAttr = item["aiConfig"] ?: return null
        val aiConfig = attributeValueToAiConfig(aiConfigAttr)

        val inputTokens = item["inputTokens"]?.n()?.toIntOrNull()
        val outputTokens = item["outputTokens"]?.n()?.toIntOrNull()
        val totalTokens = item["totalTokens"]?.n()?.toIntOrNull()
        val tokensReadFromCache = item["tokensReadFromCache"]?.n()?.toIntOrNull()

        return Message(
            messageId = item["messageId"]?.s() ?: return null,
            conversationId = item["conversationId"]?.s() ?: return null,
            text = text,
            attachments = attributeValueToAttachments(item["attachments"]),
            toolCallsJson = item["toolCallsJson"]?.s()?.takeIf { it.isNotBlank() },
            toolResultsJson = item["toolResultsJson"]?.s()?.takeIf { it.isNotBlank() },
            webSourcesJson = item["webSourcesJson"]?.s()?.takeIf { it.isNotBlank() },
            client = client,
            role = role,
            customerId = customerId,
            sequence = sequence,
            systemPrompt = systemPrompt,
            aiConfig = aiConfig,
            previousMessageId = previousMessageId,
            instructionId = instructionId,
            instructionVersion = instructionVersion,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            totalTokens = totalTokens,
            tokensReadFromCache = tokensReadFromCache,
            tokensWrittenToCache = item["tokensWrittenToCache"]?.n()?.toIntOrNull(),
            reasoningTokens = item["reasoningTokens"]?.n()?.toIntOrNull(),
            costUsd = item["costUsd"]?.n()?.toDoubleOrNull(),
            reasoningCostUsd = item["reasoningCostUsd"]?.n()?.toDoubleOrNull(),
            learnedFactsJson = item["learnedFactsJson"]?.s(),
            thinkingDurationMs = item["thinkingDurationMs"]?.n()?.toLongOrNull(),
            thinkingStepsJson = item["thinkingStepsJson"]?.s()?.takeIf { it.isNotBlank() },
            stopReason = item["stopReason"]?.s()?.takeIf { it.isNotBlank() },
            fsNamespace = item["fsNamespace"]?.s()?.takeIf { it.isNotBlank() },
            runId = item["runId"]?.s()?.takeIf { it.isNotBlank() },
            claimPending = isFlagSet(item["claimPending"]),
            errorMessage = item["errorMessage"]?.s()?.takeIf { it.isNotBlank() },
            createdAt = item["createdAt"]?.s()
        )
    }

    /** A flag attribute counts as set when it is a non-zero Number or a BOOL true. */
    private fun isFlagSet(attr: AttributeValue?): Boolean =
        attr?.n()?.toBigDecimalOrNull()?.let { it.signum() != 0 } ?: (attr?.bool() == true)

    /**
     * AttachmentRefs as a DynamoDB list of maps. The optional fields are written
     * only when set, so rows stay readable by code predating them.
     */
    private fun attachmentsToAttributeValue(
        attachments: List<com.genflowly.models.AttachmentRef>
    ): AttributeValue =
        AttributeValue.builder()
            .l(
                attachments.map { attachment ->
                    val fields = mutableMapOf(
                        "attachmentId" to AttributeValue.builder().s(attachment.attachmentId).build(),
                        "s3Key" to AttributeValue.builder().s(attachment.s3Key).build(),
                        "mediaType" to AttributeValue.builder().s(attachment.mediaType).build()
                    )
                    attachment.filename?.takeIf { it.isNotBlank() }?.let {
                        fields["filename"] = AttributeValue.builder().s(it).build()
                    }
                    attachment.sizeBytes?.let {
                        fields["sizeBytes"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    attachment.sourceKey?.takeIf { it.isNotBlank() }?.let {
                        fields["sourceKey"] = AttributeValue.builder().s(it).build()
                    }
                    attachment.pageCount?.let {
                        fields["pageCount"] = AttributeValue.builder().n(it.toString()).build()
                    }
                    AttributeValue.builder().m(fields).build()
                }
            )
            .build()

    private fun attributeValueToAttachments(
        attributeValue: AttributeValue?
    ): List<com.genflowly.models.AttachmentRef> =
        attributeValue?.l()?.mapNotNull { av ->
            val map = av.m()
            val attachmentId = map["attachmentId"]?.s() ?: return@mapNotNull null
            val s3Key = map["s3Key"]?.s() ?: return@mapNotNull null
            val mediaType = map["mediaType"]?.s() ?: return@mapNotNull null
            com.genflowly.models.AttachmentRef(
                attachmentId = attachmentId,
                s3Key = s3Key,
                mediaType = mediaType,
                filename = map["filename"]?.s()?.takeIf { it.isNotBlank() },
                sizeBytes = map["sizeBytes"]?.n()?.toLongOrNull(),
                sourceKey = map["sourceKey"]?.s()?.takeIf { it.isNotBlank() },
                pageCount = map["pageCount"]?.n()?.toIntOrNull()
            )
        } ?: emptyList()
}
