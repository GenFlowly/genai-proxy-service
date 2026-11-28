package com.genflowly.repository

import com.genflowly.DynamoDBConstants.ARCHIVED_AT_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_CUSTOMER_UPDATED_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_PINNED_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_PROJECT_GSI_KEY
import com.genflowly.DynamoDBConstants.CONVERSATION_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.LAST_READ_AT_KEY
import com.genflowly.DynamoDBConstants.LAST_REPLY_AT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_ID_SORT_KEY
import com.genflowly.DynamoDBConstants.MESSAGE_TABLE
import com.genflowly.DynamoDBConstants.PARENT_CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.PENDING_RUNS_KEY
import com.genflowly.DynamoDBConstants.PINNED_AT_KEY
import com.genflowly.DynamoDBConstants.PROJECT_ID_KEY
import com.genflowly.DynamoDBConstants.VENDORS_KEY
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.models.api.GetPinnedConversationsResponse
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
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
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
 * The display/lifecycle attributes of a Conversation row that live outside the
 * thin [Conversation] data class (raw DynamoDB attributes). Read in one GetItem
 * where several of them are needed together (e.g. forking).
 */
/** What a conditional touch of a conversation row found. */
enum class TouchResult {
    TOUCHED,
    /** No row under that key: the conversation is gone, or the key isn't the owner's. */
    NO_ROW,
    /** The update failed for another reason; the row may well exist. */
    FAILED
}

/** What a message write says about the owner's unread state, beside bumping updatedAt. */
enum class ReadStamp {
    /** An AI reply was saved: the conversation has something new for its owner. */
    REPLIED,
    /** The owner wrote in it: they have read what came before. */
    READ
}

/** A reply saved after the owner's last read. No read stamp counts as read (rows from before). */
internal fun isUnread(item: Map<String, AttributeValue>?): Boolean {
    val replied = item?.get(LAST_REPLY_AT_KEY)?.s()?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
    val read = item[LAST_READ_AT_KEY]?.s()?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return false
    return replied.isAfter(read)
}

data class ConversationAttributes(
    val title: String? = null,
    val pinnedAt: String? = null,
    val archivedAt: String? = null,
    val projectId: String? = null,
    val parentConversationId: String? = null
)

/**
 * Most reads behind one listing page. Past it the page comes back short with its key,
 * so a long run of archived rows can't hold a request open.
 */
private const val MAX_LISTING_QUERIES_PER_PAGE = 20

/**
 * Data access for the Conversation and Message tables.
 */
class ConversationRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger,
    private val usageRollupRepository: UsageRollupRepository
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
     * Creates the Conversation row of a fork in a single put: unlike the
     * create-then-update dance of organic conversations (title generated
     * later, pin set by hand), a fork knows its title, pin state and parent at
     * birth. Returns the stamped createdAt/updatedAt instant.
     */
    suspend fun createForkedConversation(
        conversation: Conversation,
        title: String,
        pinnedAt: String?,
        parentConversationId: String
    ): String = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val item = mutableMapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(conversation.customerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s(conversation.conversationId).build(),
                "client" to AttributeValue.builder().s(conversation.client).build(),
                "title" to AttributeValue.builder().s(title).build(),
                PARENT_CONVERSATION_ID_KEY to AttributeValue.builder().s(parentConversationId).build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build()
            )
            conversation.projectId?.takeIf { it.isNotBlank() }?.let {
                item[PROJECT_ID_KEY] = AttributeValue.builder().s(it).build()
            }
            pinnedAt?.let {
                item[PINNED_AT_KEY] = AttributeValue.builder().s(it).build()
            }

            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .item(item)
                    .build()
            )
            logger.info("Created forked Conversation ${conversation.conversationId} " +
                "from $parentConversationId for ${conversation.customerId}")
            now
        } catch (e: Exception) {
            logger.error("Failed to create forked Conversation in DynamoDB", e)
            throw e
        }
    }

    /**
     * The out-of-data-class attributes of one Conversation row in a single
     * GetItem. Null when the row doesn't exist.
     */
    suspend fun getConversationAttributes(
        conversationId: String,
        customerId: String
    ): ConversationAttributes? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                    CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                ))
                .build()
        )
        val item = response.item()?.takeIf { it.isNotEmpty() } ?: return@withContext null
        ConversationAttributes(
            title = item["title"]?.s(),
            pinnedAt = item[PINNED_AT_KEY]?.s(),
            archivedAt = item[ARCHIVED_AT_KEY]?.s(),
            projectId = item[PROJECT_ID_KEY]?.s(),
            parentConversationId = item[PARENT_CONVERSATION_ID_KEY]?.s()
        )
    }

    /**
     * Bumps the conversation's updatedAt to now, so it surfaces at the top of
     * the last-activity-ordered listing ([CONVERSATION_CUSTOMER_UPDATED_GSI_KEY]),
     * and folds the message's vendors into the row's denormalized [VENDORS_KEY]
     * String Set in the same write — list endpoints render vendor badges from
     * that set instead of reading the Message table.
     *
     * Guarded by attribute_exists so a wrong (customerId, conversationId) pair —
     * e.g. a sender who isn't the owner of a shared conversation — never
     * creates a phantom row. Returns false in that case instead of throwing.
     */
    suspend fun touchConversation(
        customerId: String,
        conversationId: String,
        vendors: Set<String> = emptySet(),
        stamp: ReadStamp? = null
    ): TouchResult = withContext(Dispatchers.IO) {
        try {
            val attrNames = mutableMapOf("#ua" to "updatedAt", "#cid" to CONVERSATION_ID_KEY)
            val attrValues = mutableMapOf<String, AttributeValue>(
                ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
            )
            var updateExpression = "SET #ua = :now"
            when (stamp) {
                ReadStamp.REPLIED -> { updateExpression += ", #lr = :now"; attrNames["#lr"] = LAST_REPLY_AT_KEY }
                ReadStamp.READ -> { updateExpression += ", #rd = :now"; attrNames["#rd"] = LAST_READ_AT_KEY }
                null -> {}
            }
            if (vendors.isNotEmpty()) {
                updateExpression += " ADD #v :vendors"
                attrNames["#v"] = VENDORS_KEY
                attrValues[":vendors"] = AttributeValue.builder().ss(vendors).build()
            }
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression(updateExpression)
                    .conditionExpression("attribute_exists(#cid)")
                    .expressionAttributeNames(attrNames)
                    .expressionAttributeValues(attrValues)
                    .build()
            )
            TouchResult.TOUCHED
        } catch (e: ConditionalCheckFailedException) {
            TouchResult.NO_ROW
        } catch (e: Exception) {
            // Best-effort: a failed touch must not fail the message write
            logger.error("Failed to touch conversation $conversationId", e)
            TouchResult.FAILED
        }
    }

    /**
     * The owner has read the conversation now. Keyed by the caller, so it's a no-op
     * (false) for anyone but the owner: their row doesn't exist under that key.
     */
    suspend fun markConversationRead(customerId: String, conversationId: String): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("SET #rd = :now")
                    .conditionExpression("attribute_exists(#cid)")
                    .expressionAttributeNames(mapOf("#rd" to LAST_READ_AT_KEY, "#cid" to CONVERSATION_ID_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    /**
     * Adds a durable run to the set currently generating this conversation's
     * reply, so a reload can rediscover "assistant is mid-run" and reattach. A
     * multi-vendor turn fans out to N concurrent runs, so this is a String Set —
     * each parallel vendor request ADDs its own entry atomically without clobbering
     * the others. Best-effort: a failure must never fail the generation. Returns
     * false if the conversation row doesn't exist.
     */
    suspend fun addPendingRun(
        customerId: String,
        conversationId: String,
        run: PendingRun
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("ADD #pr :e")
                    .conditionExpression("attribute_exists(#cid)")
                    .expressionAttributeNames(mapOf("#pr" to PENDING_RUNS_KEY, "#cid" to CONVERSATION_ID_KEY))
                    .expressionAttributeValues(mapOf(":e" to AttributeValue.builder().ss(run.encode()).build()))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        } catch (e: Exception) {
            logger.error("Failed to add pending run on conversation $conversationId", e)
            false
        }
    }

    /**
     * Removes one finished run from the pending set (DynamoDB drops the attribute
     * once it's empty). Best-effort. Clears only this run's entry so the other
     * vendors' in-flight runs stay reattachable.
     */
    suspend fun removePendingRun(
        customerId: String,
        conversationId: String,
        run: PendingRun
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("DELETE #pr :e")
                    // An update on a missing item creates it: a run ending after its
                    // conversation was deleted must not bring a bare row back.
                    .conditionExpression("attribute_exists(#cid)")
                    .expressionAttributeNames(mapOf("#pr" to PENDING_RUNS_KEY, "#cid" to CONVERSATION_ID_KEY))
                    .expressionAttributeValues(mapOf(":e" to AttributeValue.builder().ss(run.encode()).build()))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        } catch (e: Exception) {
            logger.error("Failed to remove pending run on conversation $conversationId", e)
            false
        }
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
                // A title generated after the conversation was deleted must not
                // bring its row back.
                .conditionExpression("attribute_exists(#cid)")
                .expressionAttributeNames(mapOf("#t" to "title", "#cid" to CONVERSATION_ID_KEY))
                .expressionAttributeValues(mapOf(":title" to AttributeValue.builder().s(title).build()))
                .build()

            dynamoDbClient.updateItem(updateReq)
            // Title text is derived from the user's conversation — id only.
            logger.info("Updated title for conversation $conversationId")
        } catch (e: ConditionalCheckFailedException) {
            logger.info("Not titling conversation $conversationId: it no longer exists")
        } catch (e: Exception) {
            logger.error("Failed to update conversation title in DynamoDB", e)
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
     *
     * updatedAt is bumped in the same write: it is the projectIndex sort key,
     * so a fresh assignment sorts to the top of its project's list (and
     * surfaces in recents). Unassignment deliberately does NOT bump — the
     * project-delete sweep unassigns in bulk and must not flood recents.
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
                    .updateExpression("SET #pid = :pid, #ua = :now")
                    // Guard against creating a phantom row for a conversation that doesn't exist
                    .conditionExpression("attribute_exists($CONVERSATION_ID_KEY)")
                    .expressionAttributeNames(mapOf("#pid" to PROJECT_ID_KEY, "#ua" to "updatedAt"))
                    .expressionAttributeValues(mapOf(
                        ":pid" to AttributeValue.builder().s(projectId).build(),
                        ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                    ))
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
        // Resume from prior page if a continuation token was supplied
        var startKey: Map<String, AttributeValue>? = null
        if (!exclusiveStartKey.isNullOrBlank()) {
            try {
                val keyMap: Map<String, String> = Json.decodeFromString(exclusiveStartKey)
                startKey = keyMap.mapValues { (_, v) -> AttributeValue.builder().s(v).build() }
            } catch (e: Exception) {
                logger.warn("Failed to parse exclusiveStartKey, starting from beginning: ${e.message}")
            }
        }

        // DynamoDB applies Limit before the archived filter, so one read can come back
        // short or empty with more behind it. Asking only for the rows still missing
        // keeps LastEvaluatedKey on the last row returned.
        val items = mutableListOf<Map<String, AttributeValue>>()
        var queries = 0
        do {
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
                .limit(pageSize - items.size)
            startKey?.let { queryBuilder.exclusiveStartKey(it) }

            val response = dynamoDbClient.query(queryBuilder.build())
            items += response.items()
            startKey = response.lastEvaluatedKey().takeIf { response.hasLastEvaluatedKey() && it.isNotEmpty() }
            queries++
        } while (items.size < pageSize && startKey != null && queries < MAX_LISTING_QUERIES_PER_PAGE)

        // The listing GSI's INCLUDE projection carries neither projectId,
        // parentConversationId, pinnedAt nor vendors, and changing a GSI
        // projection means replacing the index. One BatchGetItem on the base
        // table per page (≤50 keys) fills the gap instead.
        val pageConversationIds = items.mapNotNull { it[CONVERSATION_ID_KEY]?.s() }
        val baseRowByConversation: Map<String, Map<String, AttributeValue>> =
            if (pageConversationIds.isEmpty()) emptyMap()
            else dynamoDbClient.batchGetWithRetry(
                tableName = CONVERSATION_TABLE,
                keys = pageConversationIds.map {
                    mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(it).build()
                    )
                },
                projectionExpression = "$CONVERSATION_ID_KEY, #pid, #parent, #pa, #v, #lr, #rd",
                expressionAttributeNames = mapOf(
                    "#pid" to PROJECT_ID_KEY,
                    "#parent" to PARENT_CONVERSATION_ID_KEY,
                    "#pa" to PINNED_AT_KEY,
                    "#v" to VENDORS_KEY,
                    "#lr" to LAST_REPLY_AT_KEY,
                    "#rd" to LAST_READ_AT_KEY
                )
            ).mapNotNull { item ->
                item[CONVERSATION_ID_KEY]?.s()?.let { it to item }
            }.toMap()

        val conversations = items.mapNotNull { item ->
            val convId    = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null
            val title     = item["title"]?.s()
            val createdAt = item["createdAt"]?.s()
            val updatedAt = item["updatedAt"]?.s()
            val baseRow   = baseRowByConversation[convId]

            ConversationSummary(
                conversationId = convId,
                title = title,
                createdAt = createdAt,
                updatedAt = updatedAt,
                pinnedAt = baseRow?.get(PINNED_AT_KEY)?.s(),
                vendors = resolveVendors(customerId, convId, baseRow?.get(VENDORS_KEY)),
                projectId = baseRow?.get(PROJECT_ID_KEY)?.s(),
                parentConversationId = baseRow?.get(PARENT_CONVERSATION_ID_KEY)?.s(),
                unread = isUnread(baseRow)
            )
        }

        // Serialise LastEvaluatedKey as a simple JSON string so it is safe to round-trip through the API
        val nextPageToken: String? = startKey?.let { key ->
            Json.encodeToString(key.mapValues { (_, v) -> v.s() ?: "" })
        }

        GetCustomerConversationsResponse(conversations = conversations, lastEvaluatedKey = nextPageToken)
    }

    /**
     * One page of the customer's pinned (and not archived) conversations, most
     * recently pinned first.
     *
     * Queries the sparse [CONVERSATION_PINNED_GSI_KEY] index: pinnedAt only
     * exists while a conversation is pinned, so the index holds exactly the
     * pinned set, pre-sorted by the sort key — read cost scales with pinned
     * count, not the customer's total conversations. The index projection
     * carries every ConversationSummary field, so no base-table follow-up.
     */
    suspend fun getPinnedConversationsByCustomer(
        customerId: String,
        pageSize: Int = 50,
        exclusiveStartKey: String? = null
    ): GetPinnedConversationsResponse = withContext(Dispatchers.IO) {
        val queryBuilder = QueryRequest.builder()
            .tableName(CONVERSATION_TABLE)
            .indexName(CONVERSATION_PINNED_GSI_KEY)
            .keyConditionExpression("#cid = :cid")
            .filterExpression("attribute_not_exists(#aa)")
            .expressionAttributeNames(mapOf(
                "#cid" to CUSTOMER_ID_KEY,
                "#aa" to ARCHIVED_AT_KEY
            ))
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(customerId).build()
            ))
            .scanIndexForward(false) // most recently pinned first
            .limit(pageSize)

        if (!exclusiveStartKey.isNullOrBlank()) {
            try {
                val keyMap: Map<String, String> = Json.decodeFromString(exclusiveStartKey)
                queryBuilder.exclusiveStartKey(keyMap.mapValues { (_, v) -> AttributeValue.builder().s(v).build() })
            } catch (e: Exception) {
                logger.warn("Failed to parse pinned exclusiveStartKey, starting from beginning: ${e.message}")
            }
        }

        val response = dynamoDbClient.query(queryBuilder.build())

        // The pinned index's INCLUDE projection lacks the read stamps, and changing
        // it means replacing the index: one BatchGetItem per page fills them in.
        val pinnedIds = response.items().mapNotNull { it[CONVERSATION_ID_KEY]?.s() }
        val stampsByConversation: Map<String, Map<String, AttributeValue>> =
            if (pinnedIds.isEmpty()) emptyMap()
            else dynamoDbClient.batchGetWithRetry(
                tableName = CONVERSATION_TABLE,
                keys = pinnedIds.map {
                    mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(it).build()
                    )
                },
                projectionExpression = "$CONVERSATION_ID_KEY, #lr, #rd",
                expressionAttributeNames = mapOf("#lr" to LAST_REPLY_AT_KEY, "#rd" to LAST_READ_AT_KEY)
            ).mapNotNull { item ->
                item[CONVERSATION_ID_KEY]?.s()?.let { it to item }
            }.toMap()

        val conversations = response.items().mapNotNull { item ->
            val convId = item[CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null
            ConversationSummary(
                conversationId = convId,
                title = item["title"]?.s(),
                createdAt = item["createdAt"]?.s(),
                updatedAt = item["updatedAt"]?.s(),
                pinnedAt = item[PINNED_AT_KEY]?.s(),
                vendors = resolveVendors(customerId, convId, item[VENDORS_KEY]),
                projectId = item[PROJECT_ID_KEY]?.s(),
                parentConversationId = item[PARENT_CONVERSATION_ID_KEY]?.s(),
                unread = isUnread(stampsByConversation[convId])
            )
        }

        val nextPageToken: String? = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
            Json.encodeToString(response.lastEvaluatedKey().mapValues { (_, v) -> v.s() ?: "" })
        } else null

        GetPinnedConversationsResponse(conversations = conversations, lastEvaluatedKey = nextPageToken)
    }

    /**
     * Vendors for a summary row: the denormalized [VENDORS_KEY] set when
     * present, else computed from the messages and written back so the row
     * never pays the Message-table read again. Rows written before
     * denormalization (and conversations with no AI replies yet) take the
     * fallback path.
     */
    private suspend fun resolveVendors(
        customerId: String,
        conversationId: String,
        vendorsAttr: AttributeValue?
    ): List<String>? {
        vendorsAttr?.ss()?.takeIf { it.isNotEmpty() }?.let { return it.sorted() }

        val vendors = getMessagesForConversation(conversationId)
            .flatMap { it.aiConfig }.map { it.aiVendor.name }.distinct().sorted()
        if (vendors.isEmpty()) return null
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CONVERSATION_TABLE)
                    .key(mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    ))
                    .updateExpression("ADD #v :vendors")
                    .conditionExpression("attribute_exists(#cid)")
                    .expressionAttributeNames(mapOf("#v" to VENDORS_KEY, "#cid" to CONVERSATION_ID_KEY))
                    .expressionAttributeValues(mapOf(":vendors" to AttributeValue.builder().ss(vendors).build()))
                    .build()
            )
        } catch (e: Exception) {
            // Best-effort backfill: the read result is correct either way
            logger.warn("Failed to backfill vendors for conversation $conversationId: ${e.message}")
        }
        return vendors
    }

    /**
     * One page of the project's conversations, most recently updated first.
     *
     * Queries the sparse [CONVERSATION_PROJECT_GSI_KEY] index (PK=projectId,
     * SK=updatedAt) — read cost scales with the project's membership, never
     * the customer's whole partition. The index is KEYS_ONLY, so one
     * BatchGetItem on the base table fills in the summary fields; archived
     * rows are dropped at that step (the index carries no archivedAt), which
     * can shrink a page below pageSize without meaning the project is
     * exhausted — callers follow [lastEvaluatedKey], not the page length.
     */
    suspend fun getConversationsByProject(
        customerId: String,
        projectId: String,
        pageSize: Int = 50,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse = withContext(Dispatchers.IO) {
        val queryBuilder = QueryRequest.builder()
            .tableName(CONVERSATION_TABLE)
            .indexName(CONVERSATION_PROJECT_GSI_KEY)
            .keyConditionExpression("#pid = :pid")
            // Ownership guard — projectIds are globally unique, but a crafted
            // id must never read another customer's rows.
            .filterExpression("#cid = :cid")
            .expressionAttributeNames(mapOf(
                "#pid" to PROJECT_ID_KEY,
                "#cid" to CUSTOMER_ID_KEY
            ))
            .expressionAttributeValues(mapOf(
                ":pid" to AttributeValue.builder().s(projectId).build(),
                ":cid" to AttributeValue.builder().s(customerId).build()
            ))
            .scanIndexForward(false) // most recently updated first
            .limit(pageSize)

        if (!exclusiveStartKey.isNullOrBlank()) {
            try {
                val keyMap: Map<String, String> = Json.decodeFromString(exclusiveStartKey)
                queryBuilder.exclusiveStartKey(keyMap.mapValues { (_, v) -> AttributeValue.builder().s(v).build() })
            } catch (e: Exception) {
                logger.warn("Failed to parse project-conversations exclusiveStartKey, starting from beginning: ${e.message}")
            }
        }

        val response = dynamoDbClient.query(queryBuilder.build())

        val pageConversationIds = response.items().mapNotNull { it[CONVERSATION_ID_KEY]?.s() }
        val baseRowByConversation: Map<String, Map<String, AttributeValue>> =
            if (pageConversationIds.isEmpty()) emptyMap()
            else dynamoDbClient.batchGetWithRetry(
                tableName = CONVERSATION_TABLE,
                keys = pageConversationIds.map {
                    mapOf(
                        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(it).build()
                    )
                },
                // "title" is a DynamoDB reserved word — alias it
                projectionExpression = "$CONVERSATION_ID_KEY, #t, createdAt, updatedAt, #aa, #pa, #parent, #v, #lr, #rd",
                expressionAttributeNames = mapOf(
                    "#t" to "title",
                    "#aa" to ARCHIVED_AT_KEY,
                    "#pa" to PINNED_AT_KEY,
                    "#parent" to PARENT_CONVERSATION_ID_KEY,
                    "#v" to VENDORS_KEY,
                    "#lr" to LAST_REPLY_AT_KEY,
                    "#rd" to LAST_READ_AT_KEY
                )
            ).mapNotNull { item ->
                item[CONVERSATION_ID_KEY]?.s()?.let { it to item }
            }.toMap()

        // Iterate the index page (not the batch result) to keep the sort order
        val conversations = pageConversationIds.mapNotNull { convId ->
            val baseRow = baseRowByConversation[convId] ?: return@mapNotNull null
            if (baseRow[ARCHIVED_AT_KEY]?.s() != null) return@mapNotNull null
            ConversationSummary(
                conversationId = convId,
                title = baseRow["title"]?.s(),
                createdAt = baseRow["createdAt"]?.s(),
                updatedAt = baseRow["updatedAt"]?.s(),
                pinnedAt = baseRow[PINNED_AT_KEY]?.s(),
                vendors = resolveVendors(customerId, convId, baseRow[VENDORS_KEY]),
                projectId = projectId,
                parentConversationId = baseRow[PARENT_CONVERSATION_ID_KEY]?.s(),
                unread = isUnread(baseRow)
            )
        }

        val nextPageToken: String? = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
            Json.encodeToString(response.lastEvaluatedKey().mapValues { (_, v) -> v.s() ?: "" })
        } else null

        GetCustomerConversationsResponse(conversations = conversations, lastEvaluatedKey = nextPageToken)
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
            // Sparse projectIndex holds only project-assigned rows, so this
            // reads exactly the project's conversations instead of filtering
            // the customer's whole partition. The customerId filter is an
            // ownership guard — projectIds are globally unique, but a crafted
            // id must never unassign another customer's rows.
            val queryBuilder = QueryRequest.builder()
                .tableName(CONVERSATION_TABLE)
                .indexName(CONVERSATION_PROJECT_GSI_KEY)
                .keyConditionExpression("#pid = :pid")
                .filterExpression("#cid = :cid")
                .expressionAttributeNames(mapOf(
                    "#cid" to CUSTOMER_ID_KEY,
                    "#pid" to PROJECT_ID_KEY
                ))
                .expressionAttributeValues(mapOf(
                    ":cid" to AttributeValue.builder().s(customerId).build(),
                    ":pid" to AttributeValue.builder().s(projectId).build()
                ))
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
    /** Stores the facts learned from a message. Returns false when the message no longer exists. */
    suspend fun setMessageLearnedFacts(
        conversationId: String,
        messageId: String,
        factsJson: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest.builder()
                    .tableName(MESSAGE_TABLE)
                    .key(mapOf(
                        "conversationId" to AttributeValue.builder().s(conversationId).build(),
                        "messageId" to AttributeValue.builder().s(messageId).build()
                    ))
                    .updateExpression("SET learnedFactsJson = :facts")
                    // The message may have been deleted with its conversation.
                    .conditionExpression("attribute_exists(messageId)")
                    .expressionAttributeValues(mapOf(
                        ":facts" to AttributeValue.builder().s(factsJson).build()
                    ))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    suspend fun deleteMessage(conversationId: String, messageId: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .key(mapOf(
                    "conversationId" to AttributeValue.builder().s(conversationId).build(),
                    "messageId" to AttributeValue.builder().s(messageId).build()
                ))
                .build()
        )
        Unit
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

    /** Messages by (conversationId, messageId); missing ones are simply absent. */
    suspend fun getMessages(keys: List<Pair<String, String>>): List<Message> = withContext(Dispatchers.IO) {
        if (keys.isEmpty()) return@withContext emptyList()
        dynamoDbClient.batchGetWithRetry(
            MESSAGE_TABLE,
            keys.distinct().map { (conversationId, messageId) ->
                mapOf(
                    "conversationId" to AttributeValue.builder().s(conversationId).build(),
                    "messageId" to AttributeValue.builder().s(messageId).build()
                )
            }
        ).mapNotNull { itemToMessage(it) }
    }

    suspend fun getMessagesForConversation(
        conversationId: String
    ): List<Message> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(MESSAGE_TABLE)
            .keyConditionExpression("conversationId = :cid")
            .expressionAttributeValues(mapOf(
                ":cid" to AttributeValue.builder().s(conversationId).build()
            ))
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { itemToMessage(it) }
    }

    /**
     * @param preserveCreatedAt keep [Message.createdAt] instead of stamping now —
     * fork copies must keep the original turn's time, not the fork's.
     */
    suspend fun createMessage(
        message: Message,
        preserveCreatedAt: Boolean = false
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
                    message.activityJson?.let {
                        map["activityJson"] = AttributeValue.builder().s(it).build()
                    }
                    message.stopReason?.let {
                        map["stopReason"] = AttributeValue.builder().s(it).build()
                    }
                    message.developerKeyId?.let {
                        map["developerKeyId"] = AttributeValue.builder().s(it).build()
                    }
                    message.learnedFactsJson?.let {
                        map["learnedFactsJson"] = AttributeValue.builder().s(it).build()
                    }
                }
            ).let { stamped ->
                if (preserveCreatedAt && message.createdAt != null) {
                    stamped + ("createdAt" to AttributeValue.builder().s(message.createdAt).build())
                } else stamped
            }

            val putReq = PutItemRequest.builder()
                .tableName(MESSAGE_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)

            logger.info(
                "Saved message for conversation {} to DynamoDB",
                message.conversationId
            )

            // Fans the turn's cost/tokens into the Cost and Usage rollup.
            // Skipped for preserveCreatedAt copies (conversation forks) —
            // those replay an already-counted historical message, so fanning
            // them in again would double-count it. Best-effort: never let a
            // rollup failure fail the message save.
            if (!preserveCreatedAt) {
                try {
                    usageRollupRepository.incrementLlmUsage(message)
                } catch (e: Exception) {
                    logger.warn("Failed to record usage rollup for message {}", message.messageId, e)
                }
            }
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
            activityJson = item["activityJson"]?.s()?.takeIf { it.isNotBlank() },
            stopReason = item["stopReason"]?.s()?.takeIf { it.isNotBlank() },
            developerKeyId = item["developerKeyId"]?.s(),
            createdAt = item["createdAt"]?.s()
        )
    }

    private fun attachmentsToAttributeValue(
        attachments: List<com.genflowly.models.AttachmentRef>
    ): AttributeValue =
        AttributeValue.builder()
            .l(
                attachments.map { attachment ->
                    AttributeValue.builder()
                        .m(
                            buildMap {
                                put("attachmentId", AttributeValue.builder().s(attachment.attachmentId).build())
                                put("s3Key", AttributeValue.builder().s(attachment.s3Key).build())
                                put("mediaType", AttributeValue.builder().s(attachment.mediaType).build())
                                // Persist the display name when set (uploaded PDFs, generated
                                // artifacts) so a reloaded conversation names the document;
                                // rows written before this read back with a null filename.
                                attachment.filename?.let {
                                    put("filename", AttributeValue.builder().s(it).build())
                                }
                            }
                        )
                        .build()
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
                filename = map["filename"]?.s()
            )
        } ?: emptyList()
}
