package com.genflowly.repository

import com.genflowly.DynamoDBConstants.REQUEST_AGENT_ENABLED_KEY
import com.genflowly.DynamoDBConstants.REQUEST_AGENT_GRAPH_ID_KEY
import com.genflowly.DynamoDBConstants.REQUEST_AGENT_MAP_KEY
import com.genflowly.DynamoDBConstants.REQUEST_AGENT_MAP_TABLE
import com.genflowly.DynamoDBConstants.REQUEST_AGENT_REQUEST_TYPE_KEY
import com.genflowly.DynamoDBConstants.REQUEST_AGENT_SCOPE_KEY
import com.genflowly.DynamoDBConstants.REQUEST_AGENT_UPDATED_BY_KEY
import com.genflowly.models.RequestAgentMapEntry
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for the RequestAgentMap table: (scope, requestType) → the agent
 * graph serving that request type. scope is "SYSTEM" for the global defaults
 * managed from the admin panel; per-customer override rows use the customerId
 * as scope (future).
 */
class RequestAgentMapRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun getMapEntry(
        scope: String,
        requestType: String,
        /** Strongly-consistent read — the seeder's existence check must not act on a stale miss. */
        consistentRead: Boolean = false,
    ): RequestAgentMapEntry? =
        withContext(Dispatchers.IO) {
            val request = GetItemRequest.builder()
                .tableName(REQUEST_AGENT_MAP_TABLE)
                .key(keyOf(scope, requestType))
                .consistentRead(consistentRead)
                .build()
            val item = dynamoDbClient.getItem(request).item()
            if (item.isNullOrEmpty()) null else itemToMapEntry(item)
        }

    suspend fun listMapEntries(scope: String): List<RequestAgentMapEntry> =
        withContext(Dispatchers.IO) {
            // "scope" is a DynamoDB reserved keyword — alias it in the expression
            val request = QueryRequest.builder()
                .tableName(REQUEST_AGENT_MAP_TABLE)
                .keyConditionExpression("#scope = :scope")
                .expressionAttributeNames(mapOf("#scope" to REQUEST_AGENT_SCOPE_KEY))
                .expressionAttributeValues(
                    mapOf(":scope" to AttributeValue.builder().s(scope).build())
                )
                .build()
            dynamoDbClient.query(request).items().mapNotNull { itemToMapEntry(it) }
        }

    suspend fun putMapEntry(entry: RequestAgentMapEntry) = withContext(Dispatchers.IO) {
        try {
            // Upsert so re-pointing a request type at another graph preserves createdAt
            val now = Instant.now().toString()
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(REQUEST_AGENT_MAP_TABLE)
                    .key(keyOf(entry.scope, entry.requestType))
                    .updateExpression(
                        "SET $REQUEST_AGENT_MAP_KEY = :mapKey, " +
                                "$REQUEST_AGENT_GRAPH_ID_KEY = :graphId, " +
                                "$REQUEST_AGENT_ENABLED_KEY = :enabled, " +
                                "$REQUEST_AGENT_UPDATED_BY_KEY = :by, " +
                                "updatedAt = :now, createdAt = if_not_exists(createdAt, :now)"
                    )
                    .expressionAttributeValues(mapOf(
                        ":mapKey" to AttributeValue.builder().s(entry.mapKey).build(),
                        ":graphId" to AttributeValue.builder().s(entry.graphId).build(),
                        ":enabled" to AttributeValue.builder().bool(entry.enabled).build(),
                        ":by" to AttributeValue.builder().s(entry.updatedBy ?: "").build(),
                        ":now" to AttributeValue.builder().s(now).build()
                    ))
                    .build()
            )
            logger.info("Saved request-agent map entry ${entry.scope}/${entry.requestType} → ${entry.graphId}")
        } catch (e: Exception) {
            logger.error("Failed to save request-agent map entry ${entry.scope}/${entry.requestType}", e)
            throw e
        }
    }

    /**
     * Create the entry only if no row exists for (scope, requestType) — the
     * seeder's write, so a concurrent seeder instance (or an admin racing the
     * boot) can never be overwritten. Returns false when a row already exists.
     */
    suspend fun putMapEntryIfAbsent(entry: RequestAgentMapEntry): Boolean = withContext(Dispatchers.IO) {
        try {
            val now = Instant.now().toString()
            dynamoDbClient.putItem(
                software.amazon.awssdk.services.dynamodb.model.PutItemRequest.builder()
                    .tableName(REQUEST_AGENT_MAP_TABLE)
                    .item(
                        mapOf(
                            REQUEST_AGENT_SCOPE_KEY to AttributeValue.builder().s(entry.scope).build(),
                            REQUEST_AGENT_REQUEST_TYPE_KEY to AttributeValue.builder().s(entry.requestType).build(),
                            REQUEST_AGENT_MAP_KEY to AttributeValue.builder().s(entry.mapKey).build(),
                            REQUEST_AGENT_GRAPH_ID_KEY to AttributeValue.builder().s(entry.graphId).build(),
                            REQUEST_AGENT_ENABLED_KEY to AttributeValue.builder().bool(entry.enabled).build(),
                            REQUEST_AGENT_UPDATED_BY_KEY to AttributeValue.builder().s(entry.updatedBy ?: "").build(),
                            "createdAt" to AttributeValue.builder().s(now).build(),
                            "updatedAt" to AttributeValue.builder().s(now).build(),
                        )
                    )
                    // "scope" is a DynamoDB reserved keyword — alias it, or the
                    // put 400s and the seeder can never create the row
                    .conditionExpression("attribute_not_exists(#scope)")
                    .expressionAttributeNames(mapOf("#scope" to REQUEST_AGENT_SCOPE_KEY))
                    .build()
            )
            logger.info("Created request-agent map entry ${entry.scope}/${entry.requestType} → ${entry.graphId}")
            true
        } catch (e: software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException) {
            false
        }
    }

    suspend fun deleteMapEntry(scope: String, requestType: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(REQUEST_AGENT_MAP_TABLE)
                .key(keyOf(scope, requestType))
                .build()
        )
        logger.info("Deleted request-agent map entry $scope/$requestType")
    }

    private fun keyOf(scope: String, requestType: String) = mapOf(
        REQUEST_AGENT_SCOPE_KEY to AttributeValue.builder().s(scope).build(),
        REQUEST_AGENT_REQUEST_TYPE_KEY to AttributeValue.builder().s(requestType).build()
    )

    private fun itemToMapEntry(item: Map<String, AttributeValue>): RequestAgentMapEntry? {
        val scope = item[REQUEST_AGENT_SCOPE_KEY]?.s() ?: return null
        val requestType = item[REQUEST_AGENT_REQUEST_TYPE_KEY]?.s() ?: return null
        val graphId = item[REQUEST_AGENT_GRAPH_ID_KEY]?.s() ?: return null
        return RequestAgentMapEntry(
            scope = scope,
            requestType = requestType,
            mapKey = item[REQUEST_AGENT_MAP_KEY]?.s() ?: "",
            graphId = graphId,
            enabled = item[REQUEST_AGENT_ENABLED_KEY]?.bool() ?: true,
            updatedBy = item[REQUEST_AGENT_UPDATED_BY_KEY]?.s()?.takeIf { it.isNotBlank() },
            createdAt = item["createdAt"]?.s(),
            updatedAt = item["updatedAt"]?.s()
        )
    }
}
