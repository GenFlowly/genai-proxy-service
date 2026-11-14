package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemRequest
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.Delete
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.DeleteRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItem
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
import software.amazon.awssdk.services.dynamodb.model.Update
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.WriteRequest

/**
 * The DynamoDB reads and hard deletes behind account, conversation and note
 * deletion. Every delete is idempotent, so a deletion interrupted at any
 * point can simply run again.
 */
class PurgeRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /** Ids of every conversation the customer owns, archived ones included. */
    suspend fun ownedConversationIds(customerId: String): List<String> =
        values(DynamoDBConstants.CONVERSATION_TABLE, CUSTOMER_ID_KEY, customerId, DynamoDBConstants.CONVERSATION_ID_KEY)

    /**
     * Deletes one owned conversation: every share of it (its public link
     * included), its messages and its row. Returns how many items it deleted.
     */
    suspend fun deleteConversation(customerId: String, conversationId: String): Int =
        deleteConversationShares(conversationId) + deleteMessages(conversationId) +
            deleteConversationRow(customerId, conversationId)

    /** Deletes every share of the conversation, its public link included. */
    suspend fun deleteConversationShares(conversationId: String): Int =
        deleteKeys(
            DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
            keys(
                DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
                DynamoDBConstants.CONVERSATION_ID_KEY, conversationId,
                listOf(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, DynamoDBConstants.CONVERSATION_ID_KEY),
                DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY
            )
        )

    suspend fun deleteConversationRow(customerId: String, conversationId: String): Int =
        deleteKeys(
            DynamoDBConstants.CONVERSATION_TABLE,
            listOf(mapOf(CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.CONVERSATION_ID_KEY to s(conversationId)))
        )

    suspend fun deleteMessages(conversationId: String): Int =
        deleteKeys(
            DynamoDBConstants.MESSAGE_TABLE,
            keys(
                DynamoDBConstants.MESSAGE_TABLE,
                DynamoDBConstants.CONVERSATION_ID_KEY, conversationId,
                listOf(DynamoDBConstants.CONVERSATION_ID_KEY, DynamoDBConstants.MESSAGE_ID_SORT_KEY)
            )
        )

    /**
     * Keys of the files the conversation's messages reference, uploads and
     * generated files alike: from each message's attachments, and from its
     * tool results, which can name generated files too.
     */
    suspend fun messageFileKeys(conversationId: String): Set<String> =
        query(
            DynamoDBConstants.MESSAGE_TABLE, DynamoDBConstants.CONVERSATION_ID_KEY, conversationId,
            listOf(ATTACHMENTS, TOOL_RESULTS_JSON), indexName = null
        ).flatMapTo(mutableSetOf()) { item ->
            val attached = item[ATTACHMENTS]?.l().orEmpty().mapNotNull { it.m()?.get("s3Key")?.s() }
            val named = item[TOOL_RESULTS_JSON]?.s()?.let { json -> FILE_KEY.findAll(json).map { it.value }.toList() }.orEmpty()
            attached + named
        }

    /** Each of the customer's conversations, with the conversation it was forked from (null if none). */
    suspend fun conversationParents(customerId: String): Map<String, String?> =
        query(
            DynamoDBConstants.CONVERSATION_TABLE, CUSTOMER_ID_KEY, customerId,
            listOf(DynamoDBConstants.CONVERSATION_ID_KEY, DynamoDBConstants.PARENT_CONVERSATION_ID_KEY), indexName = null
        ).mapNotNull { item ->
            val id = item[DynamoDBConstants.CONVERSATION_ID_KEY]?.s() ?: return@mapNotNull null
            id to item[DynamoDBConstants.PARENT_CONVERSATION_ID_KEY]?.s()
        }.toMap()

    /** Deletes the conversation's rows waiting for the vector DB, which hold the ids of its messages. */
    suspend fun deletePendingVectorRows(customerId: String, conversationId: String): Int =
        deleteKeys(
            DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE,
            query(
                DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE, CUSTOMER_ID_KEY, customerId,
                listOf(CUSTOMER_ID_KEY, DynamoDBConstants.VECTOR_SYNC_ITEM_KEY, DynamoDBConstants.CONVERSATION_ID_KEY),
                indexName = null,
                sortKeyPrefix = DynamoDBConstants.VECTOR_SYNC_ITEM_KEY to "$PENDING_CONVERSATION_PREFIX#"
            ).filter { it[DynamoDBConstants.CONVERSATION_ID_KEY]?.s() == conversationId }
                .map { it.filterKeys { name -> name != DynamoDBConstants.CONVERSATION_ID_KEY } }
        )

    /** Deletes the note's row waiting for the vector DB. */
    suspend fun deletePendingVectorRow(customerId: String, noteKey: String): Int =
        deleteKeys(
            DynamoDBConstants.VECTOR_SYNC_PENDING_TABLE,
            listOf(mapOf(CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.VECTOR_SYNC_ITEM_KEY to s("$PENDING_NOTE_PREFIX#$noteKey")))
        )

    /** Deletes the memory extraction's bookkeeping for the conversation: progress and queued work. */
    suspend fun deleteMemoryBookkeeping(customerId: String, conversationId: String): Int =
        deleteKeys(
            DynamoDBConstants.CUSTOMER_MEMORY_TABLE,
            listOf(DynamoDBConstants.MEMORY_CONV_META_PREFIX, DynamoDBConstants.MEMORY_PENDING_PREFIX).map { prefix ->
                mapOf(CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.MEMORY_ID_KEY to s("$prefix$conversationId"))
            }
        )

    /**
     * Deletes the usage-log rows saying a memory was used in the conversation,
     * taking each one off its memory's hit counter, and moves lastUsedAt back
     * to the newest use left. The memories themselves, their versions and
     * change logs are kept. Returns how many rows it deleted.
     */
    suspend fun deleteMemoryUsageOfConversation(customerId: String, conversationId: String): Int {
        val rows = query(
            DynamoDBConstants.CUSTOMER_MEMORY_TABLE, CUSTOMER_ID_KEY, customerId,
            listOf(DynamoDBConstants.MEMORY_ID_KEY, DynamoDBConstants.CONVERSATION_ID_KEY, DynamoDBConstants.MEMORY_USED_AT_KEY),
            indexName = null,
            sortKeyPrefix = DynamoDBConstants.MEMORY_ID_KEY to DynamoDBConstants.MEMORY_USAGE_PREFIX
        ).filter { it[DynamoDBConstants.CONVERSATION_ID_KEY]?.s() == conversationId }
            .mapNotNull { row -> row[DynamoDBConstants.MEMORY_ID_KEY]?.s()?.let { it to row[DynamoDBConstants.MEMORY_USED_AT_KEY]?.s() } }
        var deleted = 0
        rows.groupBy { memoryIdOfUsage(it.first) }.forEach { (memoryId, uses) ->
            val removed = uses.filter { (usageKey, _) -> deleteUsage(customerId, memoryId, usageKey) }
            deleted += removed.size
            removed.mapNotNull { it.second }.maxOrNull()?.let { newestRemoved ->
                rewindLastUsedAt(customerId, memoryId, newestRemoved)
            }
        }
        return deleted
    }

    /**
     * Deletes one usage row and its hit together. False when the row was
     * already gone, so a rerun never takes a hit off twice. When the memory is
     * gone (or its counter is already 0) the row goes on its own.
     */
    private suspend fun deleteUsage(customerId: String, memoryId: String, usageKey: String): Boolean =
        withContext(Dispatchers.IO) {
            val usageRow = memoryKey(customerId, usageKey)
            try {
                dynamoDbClient.transactWriteItems(
                    TransactWriteItemsRequest.builder().transactItems(
                        TransactWriteItem.builder().delete(
                            Delete.builder()
                                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                                .key(usageRow)
                                .conditionExpression("attribute_exists(#sk)")
                                .expressionAttributeNames(mapOf("#sk" to DynamoDBConstants.MEMORY_ID_KEY))
                                .build()
                        ).build(),
                        TransactWriteItem.builder().update(
                            Update.builder()
                                .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                                .key(memoryKey(customerId, memoryId))
                                .updateExpression("SET #hits = #hits - :one")
                                .conditionExpression("attribute_exists(#sk) AND #hits >= :one")
                                .expressionAttributeNames(
                                    mapOf("#sk" to DynamoDBConstants.MEMORY_ID_KEY, "#hits" to DynamoDBConstants.MEMORY_HIT_COUNT_KEY)
                                )
                                .expressionAttributeValues(mapOf(":one" to AttributeValue.builder().n("1").build()))
                                .build()
                        ).build()
                    ).build()
                )
                true
            } catch (e: TransactionCanceledException) {
                val (row, memory) = e.cancellationReasons().map { it.code() }.let { it.getOrNull(0) to it.getOrNull(1) }
                when {
                    row == CONDITIONAL_CHECK_FAILED -> false
                    memory == CONDITIONAL_CHECK_FAILED -> {
                        dynamoDbClient.deleteItem(
                            DeleteItemRequest.builder().tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE).key(usageRow).build()
                        )
                        true
                    }
                    else -> throw e
                }
            }
        }

    /**
     * Sets lastUsedAt to the newest use left, or removes it when none is left,
     * but only while it still names [newestRemoved]: a newer use, or one in
     * another conversation, keeps its time.
     */
    private suspend fun rewindLastUsedAt(customerId: String, memoryId: String, newestRemoved: String) {
        withContext(Dispatchers.IO) {
            val newestLeft = dynamoDbClient.query(
                QueryRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                    .keyConditionExpression("#pk = :cid AND begins_with(#sk, :prefix)")
                    .expressionAttributeNames(mapOf("#pk" to CUSTOMER_ID_KEY, "#sk" to DynamoDBConstants.MEMORY_ID_KEY))
                    .expressionAttributeValues(
                        mapOf(":cid" to s(customerId), ":prefix" to s(usagePrefixOf(memoryId)))
                    )
                    .scanIndexForward(false)
                    .limit(1)
                    .build()
            ).items().firstOrNull()?.get(DynamoDBConstants.MEMORY_USED_AT_KEY)?.s()
            val names = mapOf("#sk" to DynamoDBConstants.MEMORY_ID_KEY, "#last" to DynamoDBConstants.MEMORY_LAST_USED_AT_KEY)
            try {
                dynamoDbClient.updateItem(
                    UpdateItemRequest.builder()
                        .tableName(DynamoDBConstants.CUSTOMER_MEMORY_TABLE)
                        .key(memoryKey(customerId, memoryId))
                        .updateExpression(if (newestLeft != null) "SET #last = :left" else "REMOVE #last")
                        .conditionExpression("attribute_exists(#sk) AND #last = :removed")
                        .expressionAttributeNames(names)
                        .expressionAttributeValues(
                            mapOf(":removed" to s(newestRemoved)) + (newestLeft?.let { mapOf(":left" to s(it)) } ?: emptyMap())
                        )
                        .build()
                )
            } catch (e: ConditionalCheckFailedException) {
                logger.debug { "Kept lastUsedAt of $memoryId: a newer use, or the memory is gone" }
            }
        }
    }

    private fun memoryKey(customerId: String, sortKey: String) =
        mapOf(CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.MEMORY_ID_KEY to s(sortKey))

    /** Deletes one memory's change log and usage log. */
    suspend fun deleteMemoryHistory(customerId: String, memoryId: String): Int =
        deleteMemoryRows(customerId, memoryId.removePrefix(DynamoDBConstants.MEMORY_ITEM_PREFIX) + "#")

    /** Deletes the change logs and usage logs of every memory the customer has. */
    suspend fun deleteAllMemoryHistory(customerId: String): Int = deleteMemoryRows(customerId, "")

    private suspend fun deleteMemoryRows(customerId: String, suffix: String): Int =
        listOf(DynamoDBConstants.MEMORY_CHANGE_PREFIX, DynamoDBConstants.MEMORY_USAGE_PREFIX).sumOf { prefix ->
            deleteKeys(
                DynamoDBConstants.CUSTOMER_MEMORY_TABLE,
                keys(
                    DynamoDBConstants.CUSTOMER_MEMORY_TABLE, CUSTOMER_ID_KEY, customerId,
                    listOf(CUSTOMER_ID_KEY, DynamoDBConstants.MEMORY_ID_KEY),
                    sortKeyPrefix = DynamoDBConstants.MEMORY_ID_KEY to "$prefix$suffix"
                )
            )
        }

    /** Deletes the rows recording which instructions the conversation used. */
    suspend fun deleteInstructionUsageSeen(customerId: String, conversationId: String): Int =
        deleteKeys(
            DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE,
            keys(
                DynamoDBConstants.INSTRUCTION_USAGE_SEEN_TABLE, CUSTOMER_ID_KEY, customerId,
                listOf(CUSTOMER_ID_KEY, DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY),
                sortKeyPrefix = DynamoDBConstants.INSTRUCTION_USAGE_SEEN_SORT_KEY to "$conversationId#"
            )
        )

    /** Deletes the note's row. Returns true when there was one. */
    suspend fun deleteNoteRow(customerId: String, noteKey: String): Boolean =
        deleteKeys(
            DynamoDBConstants.CUSTOMER_NOTES_TABLE,
            listOf(mapOf(CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.NOTE_KEY to s(noteKey)))
        ) > 0

    /** Deletes the conversations and the instructions or agents other people shared with the customer. */
    suspend fun deleteSharesWith(customerId: String): Int =
        deletePartition(
            DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
            DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, customerId, DynamoDBConstants.CONVERSATION_ID_KEY
        ) + deletePartition(
            DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE,
            DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, customerId, DynamoDBConstants.INSTRUCTION_ID_KEY
        )

    /** Deletes [customerId]'s shares of these conversations. */
    suspend fun deleteConversationSharesWith(customerId: String, conversationIds: List<String>): Int =
        deleteKeys(
            DynamoDBConstants.SHARED_CONVERSATIONS_TABLE,
            conversationIds.map {
                mapOf(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.CONVERSATION_ID_KEY to s(it))
            }
        )

    /** Deletes [customerId]'s shares of these instructions. */
    suspend fun deleteEntitySharesWith(customerId: String, entityIds: List<String>): Int =
        deleteKeys(
            DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE,
            entityIds.map {
                mapOf(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to s(customerId), DynamoDBConstants.INSTRUCTION_ID_KEY to s(it))
            }
        )

    /** Deletes the customer's blocks, both those they made and those made against them. */
    suspend fun deleteBlocks(customerId: String): Int {
        val blocker = DynamoDBConstants.BLOCKER_CUSTOMER_ID_KEY
        val blocked = DynamoDBConstants.BLOCKED_CUSTOMER_ID_KEY
        val table = DynamoDBConstants.CUSTOMER_BLOCKS_TABLE
        return deleteKeys(
            table,
            keys(table, blocker, customerId, listOf(blocker, blocked)) +
                keys(table, blocked, customerId, listOf(blocker, blocked), DynamoDBConstants.CUSTOMER_BLOCKS_BLOCKED_GSI)
        )
    }

    suspend fun instructionIdsByCreator(customerId: String): Set<String> =
        values(
            DynamoDBConstants.INSTRUCTION_TABLE, DynamoDBConstants.INSTRUCTION_CREATOR_KEY, customerId,
            DynamoDBConstants.INSTRUCTION_ID_KEY, DynamoDBConstants.INSTRUCTION_CREATOR_GSI_KEY
        ).toSet()

    suspend fun ownedGraphIds(customerId: String): Set<String> =
        values(
            DynamoDBConstants.CUSTOMER_GRAPHS_TABLE, CUSTOMER_ID_KEY, customerId,
            DynamoDBConstants.GRAPH_ID_KEY, DynamoDBConstants.CUSTOMER_GRAPHS_GSI_KEY
        ).toSet()

    suspend fun ownedNodeIds(customerId: String): Set<String> =
        values(
            DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE, CUSTOMER_ID_KEY, customerId,
            DynamoDBConstants.NODE_ID_KEY, DynamoDBConstants.CUSTOMER_GRAPH_NODES_GSI_KEY
        ).toSet()

    /** Config JSON of every node the System owns, i.e. the nodes of the platform's default agents. */
    suspend fun systemNodeConfigs(): List<String> =
        values(
            DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE, CUSTOMER_ID_KEY, DynamoDBConstants.SYSTEM_GRAPH_OWNER,
            DynamoDBConstants.NODE_CONFIG_KEY, DynamoDBConstants.CUSTOMER_GRAPH_NODES_GSI_KEY
        )

    /** Deletes every version of an instruction and every share of it. */
    suspend fun deleteInstruction(instructionId: String): Int =
        deleteEntityShares(instructionId) + deletePartition(
            DynamoDBConstants.INSTRUCTION_TABLE,
            DynamoDBConstants.INSTRUCTION_ID_KEY, instructionId, DynamoDBConstants.INSTRUCTION_VERSION_KEY
        )

    /** Deletes every version of an agent graph and every share of it. */
    suspend fun deleteGraph(graphId: String): Int =
        deleteEntityShares(graphId) + deletePartition(
            DynamoDBConstants.CUSTOMER_GRAPHS_TABLE,
            DynamoDBConstants.GRAPH_ID_KEY, graphId, DynamoDBConstants.VERSION_KEY
        )

    suspend fun deleteNode(nodeId: String): Int =
        deletePartition(
            DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE,
            DynamoDBConstants.NODE_ID_KEY, nodeId, DynamoDBConstants.VERSION_KEY
        )

    suspend fun deleteRequestAgentOverrides(customerId: String): Int =
        deletePartition(
            DynamoDBConstants.REQUEST_AGENT_MAP_TABLE,
            DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY, customerId, DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY
        )

    suspend fun deleteDeveloperApiKeys(customerId: String): Int =
        deleteKeys(
            DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE,
            keys(
                DynamoDBConstants.CUSTOMER_DEVELOPER_API_KEY_TABLE, CUSTOMER_ID_KEY, customerId,
                listOf(DynamoDBConstants.DEVELOPER_API_KEY_HASH_KEY), DynamoDBConstants.DEVELOPER_API_KEY_CUSTOMER_GSI
            )
        )

    /** Deletes every item in the customer's partition of [table], whose sort key is [sortKey] (null: none). */
    suspend fun deleteCustomerPartition(customerId: String, table: String, sortKey: String?): Int =
        deletePartition(table, CUSTOMER_ID_KEY, customerId, sortKey)

    /** Customer ids of every profile under the login [sub], one per app. */
    suspend fun customerIdsForSub(sub: String): List<String> =
        values(
            DynamoDBConstants.CUSTOMER_PROFILE_TABLE, DynamoDBConstants.SUB_PARTITION_KEY, sub, CUSTOMER_ID_KEY
        )

    /** Deletes the profile row, but only while it still belongs to [customerId]. */
    suspend fun deleteProfile(sub: String, client: String, customerId: String): Boolean =
        deleteIfOwned(
            DynamoDBConstants.CUSTOMER_PROFILE_TABLE,
            mapOf(DynamoDBConstants.SUB_PARTITION_KEY to s(sub), DynamoDBConstants.CLIENT_SORT_KEY to s(client)),
            customerId
        )

    /** Frees the username, but only while it still belongs to [customerId]. */
    suspend fun deleteUsername(username: String, customerId: String): Boolean =
        deleteIfOwned(
            DynamoDBConstants.USERNAME_LOOKUP_TABLE,
            mapOf(DynamoDBConstants.USERNAME_KEY to s(username)),
            customerId
        )

    // ── generic helpers ──────────────────────────────────────────────────────

    suspend fun deleteEntityShares(entityId: String): Int =
        deleteKeys(
            DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE,
            keys(
                DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE, DynamoDBConstants.INSTRUCTION_ID_KEY, entityId,
                listOf(DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY, DynamoDBConstants.INSTRUCTION_ID_KEY),
                DynamoDBConstants.SHARED_INSTRUCTIONS_GSI_KEY
            )
        )

    private suspend fun deletePartition(table: String, partitionKey: String, value: String, sortKey: String?): Int =
        deleteKeys(table, keys(table, partitionKey, value, listOfNotNull(partitionKey, sortKey)))

    private suspend fun deleteIfOwned(table: String, key: Map<String, AttributeValue>, customerId: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.deleteItem(
                    DeleteItemRequest.builder()
                        .tableName(table)
                        .key(key)
                        .conditionExpression("#cid = :cid")
                        .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                        .expressionAttributeValues(mapOf(":cid" to s(customerId)))
                        .build()
                )
                true
            } catch (e: ConditionalCheckFailedException) {
                false
            }
        }

    /** The [attribute] string of every item whose [partitionKey] is [value], in the table or [indexName]. */
    private suspend fun values(
        table: String,
        partitionKey: String,
        value: String,
        attribute: String,
        indexName: String? = null
    ): List<String> = query(table, partitionKey, value, listOf(attribute), indexName)
        .mapNotNull { it[attribute]?.s() }

    /** The table-key attributes [keyNames] of every item whose [partitionKey] is [value]. */
    private suspend fun keys(
        table: String,
        partitionKey: String,
        value: String,
        keyNames: List<String>,
        indexName: String? = null,
        sortKeyPrefix: Pair<String, String>? = null
    ): List<Map<String, AttributeValue>> = query(table, partitionKey, value, keyNames, indexName, sortKeyPrefix)
        .mapNotNull { item -> keyNames.associateWith { item[it] ?: return@mapNotNull null } }

    /**
     * The [attributes] of every item whose [partitionKey] is [value] and,
     * with [sortKeyPrefix] (sort key name to prefix), whose sort key starts
     * with that prefix.
     */
    private suspend fun query(
        table: String,
        partitionKey: String,
        value: String,
        attributes: List<String>,
        indexName: String?,
        sortKeyPrefix: Pair<String, String>? = null
    ): List<Map<String, AttributeValue>> = withContext(Dispatchers.IO) {
        val names = (attributes + partitionKey + listOfNotNull(sortKeyPrefix?.first)).distinct()
        val aliases = names.withIndex().associate { (i, name) -> "#a$i" to name }
        val alias = aliases.entries.associate { (k, v) -> v to k }
        val condition = "${alias.getValue(partitionKey)} = :v" +
            (sortKeyPrefix?.let { " AND begins_with(${alias.getValue(it.first)}, :prefix)" } ?: "")
        val values = mapOf(":v" to s(value)) + (sortKeyPrefix?.let { mapOf(":prefix" to s(it.second)) } ?: emptyMap())
        dynamoDbClient.queryPaginator(
            QueryRequest.builder()
                .tableName(table)
                .apply { if (indexName != null) indexName(indexName) }
                .keyConditionExpression(condition)
                .projectionExpression(attributes.joinToString(", ") { alias.getValue(it) })
                .expressionAttributeNames(aliases)
                .expressionAttributeValues(values)
                .build()
        ).items().toList()
    }

    /**
     * Deletes [keys] from [table] in BatchWriteItem requests of 25, retrying
     * whatever DynamoDB leaves unprocessed. Returns how many it deleted.
     */
    private suspend fun deleteKeys(table: String, keys: List<Map<String, AttributeValue>>): Int {
        val distinct = keys.distinct()
        for (batch in distinct.chunked(MAX_BATCH_WRITE)) {
            var pending = batch.map { WriteRequest.builder().deleteRequest(DeleteRequest.builder().key(it).build()).build() }
            var retries = 0
            while (pending.isNotEmpty()) {
                val response = withContext(Dispatchers.IO) {
                    dynamoDbClient.batchWriteItem(
                        BatchWriteItemRequest.builder().requestItems(mapOf(table to pending)).build()
                    )
                }
                pending = response.unprocessedItems()[table].orEmpty()
                if (pending.isNotEmpty()) {
                    check(++retries <= MAX_UNPROCESSED_RETRIES) {
                        "DynamoDB left ${pending.size} delete(s) on $table unprocessed"
                    }
                    delay((BACKOFF_BASE_MS shl retries).coerceAtMost(BACKOFF_MAX_MS))
                }
            }
        }
        if (distinct.isNotEmpty()) logger.debug { "Deleted ${distinct.size} item(s) from $table" }
        return distinct.size
    }

    private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()

    private companion object {
        const val CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailed"
        const val ATTACHMENTS = "attachments"
        const val TOOL_RESULTS_JSON = "toolResultsJson"
        // VectorSyncPending item keys are "<type token>#<key>"; see PendingVectorType.
        const val PENDING_CONVERSATION_PREFIX = "conversation"
        const val PENDING_NOTE_PREFIX = "notes"
        // An attachments-bucket key as stored on messages: customers/{customerId}/attachments/{id}
        val FILE_KEY = Regex("customers/[A-Za-z0-9-]+/attachments/[A-Za-z0-9._-]+")
        const val MAX_BATCH_WRITE = 25
        const val MAX_UNPROCESSED_RETRIES = 8
        const val BACKOFF_BASE_MS = 50L
        const val BACKOFF_MAX_MS = 5_000L

        /** "MEMUSE#<uuid>#<turn>#<messageId>" → "MEM#<uuid>". */
        fun memoryIdOfUsage(usageKey: String): String =
            DynamoDBConstants.MEMORY_ITEM_PREFIX +
                usageKey.removePrefix(DynamoDBConstants.MEMORY_USAGE_PREFIX).substringBefore('#')

        fun usagePrefixOf(memoryId: String): String =
            DynamoDBConstants.MEMORY_USAGE_PREFIX + memoryId.removePrefix(DynamoDBConstants.MEMORY_ITEM_PREFIX) + "#"
    }
}
