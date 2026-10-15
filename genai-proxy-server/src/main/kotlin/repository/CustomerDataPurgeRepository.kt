package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.DeleteRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.WriteRequest

/** A table whose partition key is a customer id; every row in that partition is the customer's. */
data class CustomerPartitionTable(val name: String, val partitionKey: String, val sortKey: String?)

/**
 * Hard deletes for the customer purge (plan 3.9): customer-keyed partitions,
 * shares, instructions, agent graphs, and a purged conversation's Message,
 * share, bookkeeping and Conversation rows. Every delete is idempotent, and
 * batch deletes are verified by re-reading, because batchWriteWithRetry
 * gives up silently on items still unprocessed after its retries.
 */
class CustomerDataPurgeRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    // ── generic ──────────────────────────────────────────────────────────────

    /**
     * Deletes every row of [table] in partition [partitionValue] (optionally
     * only sort keys starting with [sortKeyPrefix]) and returns how many.
     * Throws when rows remain after the delete.
     */
    suspend fun deletePartition(
        table: CustomerPartitionTable,
        partitionValue: String,
        sortKeyPrefix: String? = null
    ): Int {
        val keys = queryKeys(table, partitionValue, sortKeyPrefix, limit = null)
        deleteKeys(table.name, keys)
        if (queryKeys(table, partitionValue, sortKeyPrefix, limit = 1).isNotEmpty()) {
            throw IllegalStateException("Rows remain in ${table.name} after the purge delete")
        }
        return keys.size
    }

    private suspend fun queryKeys(
        table: CustomerPartitionTable,
        partitionValue: String,
        sortKeyPrefix: String?,
        limit: Int?
    ): List<Map<String, AttributeValue>> = withContext(Dispatchers.IO) {
        val names = mutableMapOf("#pk" to table.partitionKey)
        table.sortKey?.let { names["#sk"] = it }
        val values = mutableMapOf(":pk" to s(partitionValue))
        val condition = if (sortKeyPrefix != null && table.sortKey != null) {
            values[":prefix"] = s(sortKeyPrefix)
            "#pk = :pk AND begins_with(#sk, :prefix)"
        } else "#pk = :pk"
        val keys = mutableListOf<Map<String, AttributeValue>>()
        var startKey: Map<String, AttributeValue>? = null
        do {
            val builder = QueryRequest.builder()
                .tableName(table.name)
                .keyConditionExpression(condition)
                .projectionExpression(if (table.sortKey != null) "#pk, #sk" else "#pk")
                .expressionAttributeNames(names)
                .expressionAttributeValues(values)
                .consistentRead(true)
            limit?.let { builder.limit(it) }
            startKey?.let { builder.exclusiveStartKey(it) }
            val response = dynamoDbClient.query(builder.build())
            keys += response.items()
            startKey = response.lastEvaluatedKey().takeIf { response.hasLastEvaluatedKey() && it.isNotEmpty() }
        } while (startKey != null && (limit == null || keys.size < limit))
        keys
    }

    /** Batch-deletes [keys] (full primary keys) from [table], 25 per BatchWriteItem. */
    suspend fun deleteKeys(table: String, keys: List<Map<String, AttributeValue>>) {
        for (chunk in keys.chunked(25)) {
            withContext(Dispatchers.IO) {
                dynamoDbClient.batchWriteWithRetry(
                    mapOf(table to chunk.map { key ->
                        WriteRequest.builder().deleteRequest(DeleteRequest.builder().key(key).build()).build()
                    })
                )
            }
        }
    }

    suspend fun deleteItem(table: String, key: Map<String, AttributeValue>) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(DeleteItemRequest.builder().tableName(table).key(key).build())
        Unit
    }

    /** Full primary keys of the items an index query returns ([keyAttributes] picked from each item). */
    private suspend fun queryIndexKeys(
        table: String,
        index: String,
        partitionKey: String,
        partitionValue: String,
        keyAttributes: List<String>
    ): List<Map<String, AttributeValue>> = withContext(Dispatchers.IO) {
        val keys = mutableListOf<Map<String, AttributeValue>>()
        var startKey: Map<String, AttributeValue>? = null
        do {
            val builder = QueryRequest.builder()
                .tableName(table)
                .indexName(index)
                .keyConditionExpression("#pk = :pk")
                .expressionAttributeNames(mapOf("#pk" to partitionKey))
                .expressionAttributeValues(mapOf(":pk" to s(partitionValue)))
            startKey?.let { builder.exclusiveStartKey(it) }
            val response = dynamoDbClient.query(builder.build())
            response.items().mapNotNullTo(keys) { item ->
                keyAttributes.associateWith { item[it] ?: return@mapNotNullTo null }
            }
            startKey = response.lastEvaluatedKey().takeIf { response.hasLastEvaluatedKey() && it.isNotEmpty() }
        } while (startKey != null)
        keys
    }

    // ── step 1: developer API keys ───────────────────────────────────────────

    /** Deletes every developer API key of the customer (they authenticate requests on their own). */
    suspend fun deleteDeveloperApiKeys(customerId: String): Int {
        val keys = queryIndexKeys(
            DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE, DynamoDBConstants.DEVELOPER_API_KEY_CUSTOMER_GSI,
            DynamoDBConstants.CUSTOMER_ID_KEY, customerId, listOf(DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY)
        )
        keys.forEach { deleteItem(DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE, it) }
        return keys.size
    }

    // ── shares ───────────────────────────────────────────────────────────────

    /** Conversations shared WITH the customer (their recipient rows). */
    suspend fun recipientConversationIds(customerId: String): List<String> =
        queryKeys(SHARED_CONVERSATIONS, customerId, null, null)
            .mapNotNull { it[DynamoDBConstants.CONVERSATION_ID_KEY]?.s() }

    suspend fun deleteConversationShare(sharedWithCustomerId: String, conversationId: String) =
        deleteItem(
            DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
            mapOf(
                DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to s(sharedWithCustomerId),
                DynamoDBConstants.CONVERSATION_ID_KEY to s(conversationId)
            )
        )

    /** Recipients (PUBLIC included) of every share row of the conversation. */
    suspend fun conversationShareRecipients(conversationId: String): List<String> =
        queryIndexKeys(
            DynamoDBConstants.SHARED_CONVERSATIONS_TABLE, DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY,
            DynamoDBConstants.CONVERSATION_ID_KEY, conversationId,
            listOf(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, DynamoDBConstants.CONVERSATION_ID_KEY)
        ).mapNotNull { it[DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s() }

    suspend fun deleteAllConversationShares(conversationId: String): Int {
        val recipients = conversationShareRecipients(conversationId)
        recipients.forEach { deleteConversationShare(it, conversationId) }
        return recipients.size
    }

    /** Share rows of the given instructions/agents (the customer's own entities), any recipient. */
    suspend fun deleteEntityShares(entityIds: Collection<String>): Int {
        var deleted = 0
        for (entityId in entityIds) {
            val keys = queryIndexKeys(
                DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE, DynamoDBConstants.SHARED_INSTRUCTIONS_GSI_KEY,
                DynamoDBConstants.INSTRUCTION_ID_KEY, entityId,
                listOf(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, DynamoDBConstants.INSTRUCTION_ID_KEY)
            )
            keys.forEach { deleteItem(DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE, it) }
            deleted += keys.size
        }
        return deleted
    }

    // ── instructions and agent graphs ────────────────────────────────────────

    /** Ids of every instruction the customer created (all versions share one id). */
    suspend fun instructionIdsByCreator(customerId: String): Set<String> =
        queryIndexKeys(
            DynamoDBConstants.INSTRUCTION_TABLE, DynamoDBConstants.INSTRUCTION_CREATOR_GSI_KEY,
            DynamoDBConstants.INSTRUCTION_CREATOR_KEY, customerId, listOf(DynamoDBConstants.INSTRUCTION_ID_KEY)
        ).mapNotNull { it[DynamoDBConstants.INSTRUCTION_ID_KEY]?.s() }.toSet()

    /** Agent graphs (or graph nodes) the customer owns, soft-deleted ones included. */
    suspend fun ownedGraphIds(customerId: String): Set<String> =
        queryIndexKeys(
            DynamoDBConstants.CUSTOMER_GRAPHS_TABLE, DynamoDBConstants.CUSTOMER_GRAPHS_GSI_KEY,
            DynamoDBConstants.CUSTOMER_ID_KEY, customerId, listOf(DynamoDBConstants.GRAPH_ID_KEY)
        ).mapNotNull { it[DynamoDBConstants.GRAPH_ID_KEY]?.s() }.toSet()

    suspend fun ownedNodeIds(customerId: String): Set<String> =
        queryIndexKeys(
            DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE, DynamoDBConstants.CUSTOMER_GRAPH_NODES_GSI_KEY,
            DynamoDBConstants.CUSTOMER_ID_KEY, customerId, listOf(DynamoDBConstants.NODE_ID_KEY)
        ).mapNotNull { it[DynamoDBConstants.NODE_ID_KEY]?.s() }.toSet()

    /**
     * The config JSON of every current graph node [customerId] owns
     * (soft-deleted ones included). Reads every page and lets a failed read
     * throw: the purge decides from it what it must not delete.
     */
    suspend fun nodeConfigs(customerId: String): List<String> = withContext(Dispatchers.IO) {
        val configs = mutableListOf<String>()
        var startKey: Map<String, AttributeValue>? = null
        do {
            val builder = QueryRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE)
                .indexName(DynamoDBConstants.CUSTOMER_GRAPH_NODES_GSI_KEY)
                .keyConditionExpression("#pk = :pk")
                .projectionExpression("#cfg")
                .expressionAttributeNames(mapOf(
                    "#pk" to DynamoDBConstants.CUSTOMER_ID_KEY,
                    "#cfg" to DynamoDBConstants.NODE_CONFIG_KEY
                ))
                .expressionAttributeValues(mapOf(":pk" to s(customerId)))
            startKey?.let { builder.exclusiveStartKey(it) }
            val response = dynamoDbClient.query(builder.build())
            response.items().mapNotNullTo(configs) { it[DynamoDBConstants.NODE_CONFIG_KEY]?.s() }
            startKey = response.lastEvaluatedKey().takeIf { response.hasLastEvaluatedKey() && it.isNotEmpty() }
        } while (startKey != null)
        configs
    }

    /** Every version of an instruction, graph or graph node (the history rows carry no owner). */
    suspend fun deleteAllVersions(table: CustomerPartitionTable, id: String): Int = deletePartition(table, id)

    // ── conversation purge ───────────────────────────────────────────────────

    /**
     * Stamps purgeStartedAt on the Conversation row (kept from the first
     * attempt): from then on the message-write guard refuses new messages.
     * False when the row no longer exists.
     */
    suspend fun markConversationPurgeStarted(ownerCustomerId: String, conversationId: String, now: Instant): Boolean =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.updateItem(
                    UpdateItemRequest.builder()
                        .tableName(DynamoDBConstants.CONVERSATION_TABLE)
                        .key(conversationKey(ownerCustomerId, conversationId))
                        .updateExpression("SET #ps = if_not_exists(#ps, :now)")
                        .conditionExpression("attribute_exists(#conv)")
                        .expressionAttributeNames(mapOf(
                            "#ps" to RetentionTables.PURGE_STARTED_AT_KEY,
                            "#conv" to DynamoDBConstants.CONVERSATION_ID_KEY
                        ))
                        .expressionAttributeValues(mapOf(":now" to s(now.toString())))
                        .build()
                )
                true
            } catch (e: ConditionalCheckFailedException) {
                false
            }
        }

    suspend fun deleteMessages(conversationId: String, messageIds: Collection<String>) =
        deleteKeys(DynamoDBConstants.MESSAGE_TABLE, messageIds.map { messageId ->
            mapOf(
                DynamoDBConstants.CONVERSATION_ID_KEY to s(conversationId),
                DynamoDBConstants.MESSAGE_ID_SORT_KEY to s(messageId)
            )
        })

    /** True while any Message row of the conversation exists (strongly consistent). */
    suspend fun hasMessages(conversationId: String): Boolean =
        queryKeys(MESSAGES, conversationId, null, limit = 1).isNotEmpty()

    suspend fun deleteConversationRow(ownerCustomerId: String, conversationId: String) =
        deleteItem(DynamoDBConstants.CONVERSATION_TABLE, conversationKey(ownerCustomerId, conversationId))

    /** The memory-extraction bookkeeping rows a participant has for the conversation. */
    suspend fun deleteMemoryConversationMeta(customerId: String, conversationId: String) {
        for (prefix in listOf(DynamoDBConstants.MEMORY_CONV_META_PREFIX, DynamoDBConstants.MEMORY_PENDING_PREFIX)) {
            deleteItem(
                DynamoDBConstants.CUSTOMER_MEMORY_TABLE,
                mapOf(
                    DynamoDBConstants.CUSTOMER_ID_KEY to s(customerId),
                    DynamoDBConstants.MEMORY_ID_KEY to s("$prefix$conversationId")
                )
            )
        }
    }

    /** A participant's InstructionUsageSeen rows for the conversation ("<conversationId>#<instructionId>"). */
    suspend fun deleteInstructionUsageSeen(customerId: String, conversationId: String): Int =
        deletePartition(INSTRUCTION_USAGE_SEEN, customerId, sortKeyPrefix = "$conversationId#")

    private fun conversationKey(ownerCustomerId: String, conversationId: String) = mapOf(
        DynamoDBConstants.CUSTOMER_ID_KEY to s(ownerCustomerId),
        DynamoDBConstants.CONVERSATION_ID_KEY to s(conversationId)
    )

    private fun s(v: String) = AttributeValue.builder().s(v).build()

    companion object {
        val SHARED_CONVERSATIONS = CustomerPartitionTable(
            DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
            DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, DynamoDBConstants.CONVERSATION_ID_KEY
        )
        val SHARED_INSTRUCTIONS = CustomerPartitionTable(
            DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE,
            DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, DynamoDBConstants.INSTRUCTION_ID_KEY
        )
        val MESSAGES = CustomerPartitionTable(
            DynamoDBConstants.MESSAGE_TABLE, DynamoDBConstants.CONVERSATION_ID_KEY, DynamoDBConstants.MESSAGE_ID_SORT_KEY
        )
        val INSTRUCTION_USAGE_SEEN = CustomerPartitionTable(
            DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE,
            DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY
        )
        val INSTRUCTION_VERSIONS = CustomerPartitionTable(
            DynamoDBConstants.INSTRUCTION_TABLE, DynamoDBConstants.INSTRUCTION_ID_KEY, DynamoDBConstants.INSTRUCTION_VERSION_KEY
        )
        val GRAPH_VERSIONS = CustomerPartitionTable(
            DynamoDBConstants.CUSTOMER_GRAPHS_TABLE, DynamoDBConstants.GRAPH_ID_KEY, DynamoDBConstants.VERSION_KEY
        )
        val NODE_VERSIONS = CustomerPartitionTable(
            DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE, DynamoDBConstants.NODE_ID_KEY, DynamoDBConstants.VERSION_KEY
        )
        val REQUEST_AGENT_MAP = CustomerPartitionTable(
            DynamoDBConstants.REQUEST_AGENT_MAP_TABLE,
            DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY, DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY
        )

        /**
         * Every table partitioned by customerId whose whole partition goes
         * with the customer. Not here: Conversation (purged per conversation,
         * shared ones kept), CustomerProfile (kept, renamed) and the tables
         * keyed otherwise (handled one by one). CustomerVectorDBConfig must
         * go after the vector purge, which reads it.
         */
        val CUSTOMER_PARTITION_TABLES = listOf(
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_API_KEY_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.AI_VENDOR_KEY),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_USAGE_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.USAGE_DATE_SORT_KEY),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, null),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_EMBEDDING_MODELS_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.VENDOR_KEY),
            CustomerPartitionTable("CustomerSupabaseConfig", DynamoDBConstants.CUSTOMER_ID_KEY, null),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_TOOL_CREDENTIALS_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.TOOL_TYPE_KEY),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_TOOLS_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.TOOL_NAME_KEY),
            CustomerPartitionTable(DynamoDBConstants.INSTRUCTION_USAGE_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.INSTRUCTION_ID_KEY),
            INSTRUCTION_USAGE_SEEN,
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_NOTES_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.NOTE_KEY),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_MEMORY_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.MEMORY_ID_KEY),
            CustomerPartitionTable(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, DynamoDBConstants.PROJECT_ID_KEY),
            SHARED_INSTRUCTIONS
        )

        /** Holds BYO vector-store credentials the vector purge still needs; deleted after it. */
        val VECTOR_DB_CONFIG = CustomerPartitionTable(
            DynamoDBConstants.CUSTOMER_VECTOR_DB_CONFIG_TABLE, DynamoDBConstants.CUSTOMER_ID_KEY, null
        )
    }
}
