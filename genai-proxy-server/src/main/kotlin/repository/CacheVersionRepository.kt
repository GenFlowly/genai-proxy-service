package com.genflowly.repository

import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_PREFERENCES_TABLE
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Per-owner cache-version counters, stored as number attributes on the
 * owner's CustomerPreferences item (plus one system-scoped item for
 * SYSTEM-owned data every customer sees). Clients compare the counters
 * returned by /onboard against the version their local cache was written at
 * and skip refetching a resource whose counter is unchanged — so a missed
 * bump serves stale data indefinitely: every mutation path for a versioned
 * resource MUST bump, including admin and seeder writes.
 */
class CacheVersionRepository(private val dynamoDbClient: DynamoDbClient) {

    enum class Resource(val attr: String) {
        AGENTS("cacheVersionAgents"),
        REQUEST_AGENTS("cacheVersionRequestAgents"),
        PROJECTS("cacheVersionProjects"),
    }

    suspend fun bump(ownerId: String, resource: Resource): Unit = withContext(Dispatchers.IO) {
        val request = UpdateItemRequest.builder()
            .tableName(CUSTOMER_PREFERENCES_TABLE)
            .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(ownerId).build()))
            .updateExpression("ADD #attr :one")
            .expressionAttributeNames(mapOf("#attr" to resource.attr))
            .expressionAttributeValues(mapOf(":one" to AttributeValue.builder().n("1").build()))
            .build()
        dynamoDbClient.updateItem(request)
    }

    suspend fun getVersions(ownerId: String): Map<Resource, Long> = withContext(Dispatchers.IO) {
        val request = GetItemRequest.builder()
            .tableName(CUSTOMER_PREFERENCES_TABLE)
            .key(mapOf(CUSTOMER_ID_KEY to AttributeValue.builder().s(ownerId).build()))
            .projectionExpression(Resource.entries.joinToString(", ") { it.attr })
            .build()
        val item = dynamoDbClient.getItem(request).item() ?: return@withContext emptyMap()
        Resource.entries.mapNotNull { resource ->
            item[resource.attr]?.n()?.toLongOrNull()?.let { resource to it }
        }.toMap()
    }

    companion object {
        /** System-scoped row id — the "#" cannot collide with real customer ids. */
        const val SYSTEM_VERSIONS_ITEM_ID = "SYSTEM#CACHE_VERSIONS"
    }
}
