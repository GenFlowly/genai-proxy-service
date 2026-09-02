package com.genflowly.repository

import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPHS_GSI_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPHS_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPH_NODES_GSI_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_GRAPH_NODES_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.DELETED_AT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_EDGES_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ENTRY_POINT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ID_KEY
import com.genflowly.DynamoDBConstants.GRAPH_IS_DEFAULT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_LAYOUT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_MAX_ITERATIONS_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NAME_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NODE_IDS_KEY
import com.genflowly.DynamoDBConstants.LATEST_VERSION_KEY
import com.genflowly.DynamoDBConstants.NODE_CONFIG_KEY
import com.genflowly.DynamoDBConstants.NODE_ID_KEY
import com.genflowly.DynamoDBConstants.NODE_NAME_KEY
import com.genflowly.DynamoDBConstants.NODE_TYPE_KEY
import com.genflowly.DynamoDBConstants.VERSION_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the CustomerGraphNodes and CustomerGraphs tables.
 * Versioning scheme (see constants.kt): version=0 is the live record;
 * version=1,2,... are immutable history snapshots.
 *
 * The version bookkeeping (next-version computation, rollback fallback-merge)
 * stays here deliberately: it is inseparable from how the rows are laid out,
 * and lifting it into GraphService would drag AttributeValue construction up
 * into the domain layer. Domain policy (ownership checks, validation,
 * response mapping) lives in GraphService.
 */
class GraphRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    // ─── Graph Nodes ──────────────────────────────────────────────────────────

    suspend fun createCustomerGraphNode(
        customerId: String,
        nodeId: String,
        nodeType: String,
        name: String,
        config: String
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val baseFields = mapOf(
                NODE_TYPE_KEY to AttributeValue.builder().s(nodeType).build(),
                NODE_NAME_KEY to AttributeValue.builder().s(name).build(),
                NODE_CONFIG_KEY to AttributeValue.builder().s(config).build(),
            )
            // v=1: history snapshot (no customerId → excluded from GSI)
            val historyItem = baseFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            // v=0: current/live item with customerId for GSI
            val currentItem = baseFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(currentItem).build())
            logger.info("Created graph node $nodeId ($nodeType) v1 for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to create graph node $nodeId for customer $customerId", e)
            throw e
        }
    }

    suspend fun updateCustomerGraphNode(
        nodeId: String,
        nodeType: String,
        name: String,
        config: String
    ): Map<String, AttributeValue> = withContext(Dispatchers.IO) {
        val current = getCustomerGraphNode(nodeId) ?: error("Graph node $nodeId not found")
        val latestVersion = current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1
        val nextVersion = latestVersion + 1
        val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on node $nodeId")
        val createdAt = current["createdAt"]?.s() ?: Instant.now().toString()
        val now = Instant.now().toString()

        val baseFields = mapOf(
            NODE_TYPE_KEY to AttributeValue.builder().s(nodeType).build(),
            NODE_NAME_KEY to AttributeValue.builder().s(name).build(),
            NODE_CONFIG_KEY to AttributeValue.builder().s(config).build(),
        )
        val historyItem = baseFields + mapOf(
            NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
            VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(now).build(),
        )
        val updatedCurrent = baseFields + mapOf(
            NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
            VERSION_KEY to AttributeValue.builder().n("0").build(),
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
            LATEST_VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(createdAt).build(),
            "updatedAt" to AttributeValue.builder().s(now).build(),
        )
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(historyItem).build())
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(updatedCurrent).build())
        logger.info("Updated graph node $nodeId to v$nextVersion")
        updatedCurrent
    }

    suspend fun getCustomerGraphNode(nodeId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            try {
                val request = GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                    .key(mapOf(
                        NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .build()
                val item = dynamoDbClient.getItem(request).item()
                if (item.isNullOrEmpty() || item.containsKey(DELETED_AT_KEY)) null else item
            } catch (e: Exception) {
                logger.error("Failed to get graph node $nodeId", e)
                null
            }
        }

    suspend fun deleteCustomerGraphNode(nodeId: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                    .key(mapOf(
                        NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .updateExpression("SET #da = :now")
                    .expressionAttributeNames(mapOf("#da" to DELETED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Soft-deleted graph node $nodeId")
        } catch (e: Exception) {
            logger.error("Failed to delete graph node $nodeId", e)
            throw e
        }
    }

    suspend fun listCustomerGraphNodes(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                        .indexName(CUSTOMER_GRAPH_NODES_GSI_KEY)
                        .keyConditionExpression("#cid = :cid")
                        .filterExpression("attribute_not_exists(#da)")
                        .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY, "#da" to DELETED_AT_KEY))
                        .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to list graph nodes for customer $customerId", e)
                emptyList()
            }
        }

    suspend fun getCustomerGraphNodeVersions(nodeId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                        .keyConditionExpression("#nid = :nid AND #v > :zero")
                        .expressionAttributeNames(mapOf("#nid" to NODE_ID_KEY, "#v" to VERSION_KEY))
                        .expressionAttributeValues(mapOf(
                            ":nid" to AttributeValue.builder().s(nodeId).build(),
                            ":zero" to AttributeValue.builder().n("0").build(),
                        ))
                        .scanIndexForward(false)
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to get versions for graph node $nodeId", e)
                emptyList()
            }
        }

    suspend fun rollbackCustomerGraphNode(nodeId: String, toVersion: Int): Map<String, AttributeValue> =
        withContext(Dispatchers.IO) {
            val target = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                    .key(mapOf(
                        NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                        VERSION_KEY to AttributeValue.builder().n(toVersion.toString()).build(),
                    ))
                    .build()
            ).item()
            require(!target.isNullOrEmpty()) { "Version $toVersion not found for node $nodeId" }

            val current = getCustomerGraphNode(nodeId) ?: error("Graph node $nodeId not found")
            val latestVersion = (current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 0) + 1
            val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on node $nodeId")
            val now = Instant.now().toString()

            val restoredFields = mapOf(
                NODE_TYPE_KEY to (target[NODE_TYPE_KEY] ?: current[NODE_TYPE_KEY]!!),
                NODE_NAME_KEY to (target[NODE_NAME_KEY] ?: current[NODE_NAME_KEY]!!),
                NODE_CONFIG_KEY to (target[NODE_CONFIG_KEY] ?: current[NODE_CONFIG_KEY]!!),
            )
            val historyItem = restoredFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            val updatedCurrent = restoredFields + mapOf(
                NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(current["createdAt"]?.s() ?: now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPH_NODES_TABLE).item(updatedCurrent).build())
            logger.info("Rolled back graph node $nodeId to v$toVersion (new snapshot v$latestVersion)")
            updatedCurrent
        }

    // ─── Graphs ───────────────────────────────────────────────────────────────

    suspend fun createCustomerGraph(
        customerId: String,
        graphId: String,
        name: String,
        isDefault: Boolean,
        nodeIds: List<String>,
        edges: String,
        entryPoint: String,
        maxIterations: Int = 10,
        layout: String? = null,
    ) = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            val nodeIdAttrList = nodeIds.map { AttributeValue.builder().s(it).build() }
            val baseFields = mapOf(
                GRAPH_NAME_KEY to AttributeValue.builder().s(name).build(),
                GRAPH_IS_DEFAULT_KEY to AttributeValue.builder().bool(isDefault).build(),
                GRAPH_NODE_IDS_KEY to AttributeValue.builder().l(nodeIdAttrList).build(),
                GRAPH_EDGES_KEY to AttributeValue.builder().s(edges).build(),
                GRAPH_ENTRY_POINT_KEY to AttributeValue.builder().s(entryPoint).build(),
                GRAPH_MAX_ITERATIONS_KEY to AttributeValue.builder().n(maxIterations.toString()).build(),
            ) + (layout?.let { mapOf(GRAPH_LAYOUT_KEY to AttributeValue.builder().s(it).build()) } ?: emptyMap())
            val historyItem = baseFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            val currentItem = baseFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n("1").build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(currentItem).build())
            logger.info("Created graph $graphId ($name) v1 for customer $customerId")
        } catch (e: Exception) {
            logger.error("Failed to create graph $graphId for customer $customerId", e)
            throw e
        }
    }

    suspend fun updateCustomerGraph(
        graphId: String,
        name: String,
        isDefault: Boolean,
        nodeIds: List<String>,
        edges: String,
        entryPoint: String,
        maxIterations: Int,
        layout: String? = null,
    ): Map<String, AttributeValue> = withContext(Dispatchers.IO) {
        val current = getCustomerGraph(graphId) ?: error("Graph $graphId not found")
        val latestVersion = current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1
        val nextVersion = latestVersion + 1
        val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on graph $graphId")
        val createdAt = current["createdAt"]?.s() ?: Instant.now().toString()
        val now = Instant.now().toString()

        // layout=null keeps the stored layout (callers pass it only when it changed)
        val mergedLayout = layout ?: current[GRAPH_LAYOUT_KEY]?.s()
        val nodeIdAttrList = nodeIds.map { AttributeValue.builder().s(it).build() }
        val baseFields = mapOf(
            GRAPH_NAME_KEY to AttributeValue.builder().s(name).build(),
            GRAPH_IS_DEFAULT_KEY to AttributeValue.builder().bool(isDefault).build(),
            GRAPH_NODE_IDS_KEY to AttributeValue.builder().l(nodeIdAttrList).build(),
            GRAPH_EDGES_KEY to AttributeValue.builder().s(edges).build(),
            GRAPH_ENTRY_POINT_KEY to AttributeValue.builder().s(entryPoint).build(),
            GRAPH_MAX_ITERATIONS_KEY to AttributeValue.builder().n(maxIterations.toString()).build(),
        ) + (mergedLayout?.let { mapOf(GRAPH_LAYOUT_KEY to AttributeValue.builder().s(it).build()) } ?: emptyMap())
        val historyItem = baseFields + mapOf(
            GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
            VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(now).build(),
        )
        val updatedCurrent = baseFields + mapOf(
            GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
            VERSION_KEY to AttributeValue.builder().n("0").build(),
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
            LATEST_VERSION_KEY to AttributeValue.builder().n(nextVersion.toString()).build(),
            "createdAt" to AttributeValue.builder().s(createdAt).build(),
            "updatedAt" to AttributeValue.builder().s(now).build(),
        )
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(historyItem).build())
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(updatedCurrent).build())
        logger.info("Updated graph $graphId to v$nextVersion")
        updatedCurrent
    }

    suspend fun getCustomerGraph(graphId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            try {
                val request = GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPHS_TABLE)
                    .key(mapOf(
                        GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .build()
                val item = dynamoDbClient.getItem(request).item()
                if (item.isNullOrEmpty() || item.containsKey(DELETED_AT_KEY)) null else item
            } catch (e: Exception) {
                logger.error("Failed to get graph $graphId", e)
                null
            }
        }

    suspend fun deleteCustomerGraph(graphId: String) = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(CUSTOMER_GRAPHS_TABLE)
                    .key(mapOf(
                        GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                        VERSION_KEY to AttributeValue.builder().n("0").build(),
                    ))
                    .updateExpression("SET #da = :now")
                    .expressionAttributeNames(mapOf("#da" to DELETED_AT_KEY))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().s(Instant.now().toString()).build()))
                    .build()
            )
            logger.info("Soft-deleted graph $graphId")
        } catch (e: Exception) {
            logger.error("Failed to delete graph $graphId", e)
            throw e
        }
    }

    suspend fun listCustomerGraphs(customerId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPHS_TABLE)
                        .indexName(CUSTOMER_GRAPHS_GSI_KEY)
                        .keyConditionExpression("#cid = :cid")
                        .filterExpression("attribute_not_exists(#da)")
                        .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY, "#da" to DELETED_AT_KEY))
                        .expressionAttributeValues(mapOf(":cid" to AttributeValue.builder().s(customerId).build()))
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to list graphs for customer $customerId", e)
                emptyList()
            }
        }

    suspend fun getDefaultCustomerGraph(customerId: String): Map<String, AttributeValue>? =
        withContext(Dispatchers.IO) {
            try {
                // Sparse GSI: only v=0 items have customerId, so all results are current-state.
                // Scan up to 20 to find one with isDefault=true (most customers have very few graphs).
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPHS_TABLE)
                        .indexName(CUSTOMER_GRAPHS_GSI_KEY)
                        .keyConditionExpression("#cid = :cid")
                        .filterExpression("#isDefault = :true AND attribute_not_exists(#da)")
                        .expressionAttributeNames(mapOf(
                            "#cid" to CUSTOMER_ID_KEY,
                            "#isDefault" to GRAPH_IS_DEFAULT_KEY,
                            "#da" to DELETED_AT_KEY,
                        ))
                        .expressionAttributeValues(mapOf(
                            ":cid" to AttributeValue.builder().s(customerId).build(),
                            ":true" to AttributeValue.builder().bool(true).build(),
                        ))
                        .limit(20)
                        .build()
                ).items().firstOrNull()
            } catch (e: Exception) {
                logger.error("Failed to get default graph for customer $customerId", e)
                null
            }
        }

    /**
     * Re-owns a live (v=0) graph row. Used when an admin maps a graph into the
     * global request-agent map: the graph becomes System infrastructure. The
     * sparse customerIdIndex GSI follows the attribute automatically.
     */
    suspend fun transferGraphOwnership(graphId: String, newOwner: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(CUSTOMER_GRAPHS_TABLE)
                .key(mapOf(
                    GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                    VERSION_KEY to AttributeValue.builder().n("0").build(),
                ))
                .updateExpression("SET #cid = :owner")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":owner" to AttributeValue.builder().s(newOwner).build()))
                .build()
        )
        logger.info("Transferred graph $graphId ownership to $newOwner")
    }

    /** Node counterpart of [transferGraphOwnership]. */
    suspend fun transferNodeOwnership(nodeId: String, newOwner: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(CUSTOMER_GRAPH_NODES_TABLE)
                .key(mapOf(
                    NODE_ID_KEY to AttributeValue.builder().s(nodeId).build(),
                    VERSION_KEY to AttributeValue.builder().n("0").build(),
                ))
                .updateExpression("SET #cid = :owner")
                .expressionAttributeNames(mapOf("#cid" to CUSTOMER_ID_KEY))
                .expressionAttributeValues(mapOf(":owner" to AttributeValue.builder().s(newOwner).build()))
                .build()
        )
        logger.info("Transferred node $nodeId ownership to $newOwner")
    }

    suspend fun getCustomerGraphVersions(graphId: String): List<Map<String, AttributeValue>> =
        withContext(Dispatchers.IO) {
            try {
                dynamoDbClient.query(
                    QueryRequest.builder()
                        .tableName(CUSTOMER_GRAPHS_TABLE)
                        .keyConditionExpression("#gid = :gid AND #v > :zero")
                        .expressionAttributeNames(mapOf("#gid" to GRAPH_ID_KEY, "#v" to VERSION_KEY))
                        .expressionAttributeValues(mapOf(
                            ":gid" to AttributeValue.builder().s(graphId).build(),
                            ":zero" to AttributeValue.builder().n("0").build(),
                        ))
                        .scanIndexForward(false)
                        .build()
                ).items()
            } catch (e: Exception) {
                logger.error("Failed to get versions for graph $graphId", e)
                emptyList()
            }
        }

    suspend fun rollbackCustomerGraph(graphId: String, toVersion: Int): Map<String, AttributeValue> =
        withContext(Dispatchers.IO) {
            val target = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(CUSTOMER_GRAPHS_TABLE)
                    .key(mapOf(
                        GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                        VERSION_KEY to AttributeValue.builder().n(toVersion.toString()).build(),
                    ))
                    .build()
            ).item()
            require(!target.isNullOrEmpty()) { "Version $toVersion not found for graph $graphId" }

            val current = getCustomerGraph(graphId) ?: error("Graph $graphId not found")
            val latestVersion = (current[LATEST_VERSION_KEY]?.n()?.toInt() ?: 0) + 1
            val customerId = current[CUSTOMER_ID_KEY]?.s() ?: error("Missing customerId on graph $graphId")
            val now = Instant.now().toString()

            val restoredFields = listOf(
                GRAPH_NAME_KEY, GRAPH_IS_DEFAULT_KEY, GRAPH_NODE_IDS_KEY,
                GRAPH_EDGES_KEY, GRAPH_ENTRY_POINT_KEY, GRAPH_MAX_ITERATIONS_KEY,
                GRAPH_LAYOUT_KEY
            ).mapNotNull { key -> target[key]?.let { key to it } }.toMap()

            val historyItem = restoredFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(now).build(),
            )
            val updatedCurrent = restoredFields + mapOf(
                GRAPH_ID_KEY to AttributeValue.builder().s(graphId).build(),
                VERSION_KEY to AttributeValue.builder().n("0").build(),
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                LATEST_VERSION_KEY to AttributeValue.builder().n(latestVersion.toString()).build(),
                "createdAt" to AttributeValue.builder().s(current["createdAt"]?.s() ?: now).build(),
                "updatedAt" to AttributeValue.builder().s(now).build(),
            )
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(historyItem).build())
            dynamoDbClient.putItem(PutItemRequest.builder().tableName(CUSTOMER_GRAPHS_TABLE).item(updatedCurrent).build())
            logger.info("Rolled back graph $graphId to v$toVersion (new snapshot v$latestVersion)")
            updatedCurrent
        }
}
