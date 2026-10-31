package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.PROJECT_ID_KEY
import com.genflowly.DynamoDBConstants.PROJECT_NAME_KEY
import com.genflowly.models.api.Project
import com.genflowly.models.generateProjectId
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
 * Data access for the CustomerProjects table (PK=customerId, SK=projectId).
 * A project row holds only its name and timestamps; membership lives on the
 * Conversation rows as a projectId attribute, owned by ConversationRepository.
 */
class ProjectRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun createProject(customerId: String, name: String): Project = withContext(Dispatchers.IO) {
        val projectId = generateProjectId()
        val item = withTimestamps(
            mapOf(
                CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                PROJECT_ID_KEY to AttributeValue.builder().s(projectId).build(),
                PROJECT_NAME_KEY to AttributeValue.builder().s(name).build()
            )
        )
        dynamoDbClient.putItem(
            PutItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE)
                .item(item)
                .build()
        )
        logger.info { "Created project $projectId for customer $customerId" }
        val now = item["createdAt"]?.s() ?: Instant.now().toString()
        Project(projectId = projectId, name = name, createdAt = now, updatedAt = now)
    }

    suspend fun getProjects(customerId: String): List<Project> = withContext(Dispatchers.IO) {
        val items = mutableListOf<Map<String, AttributeValue>>()
        var exclusiveStartKey: Map<String, AttributeValue>? = null
        do {
            val builder = QueryRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE)
                .keyConditionExpression("$CUSTOMER_ID_KEY = :cid")
                .expressionAttributeValues(
                    mapOf(":cid" to AttributeValue.builder().s(customerId).build())
                )
            if (!exclusiveStartKey.isNullOrEmpty()) {
                builder.exclusiveStartKey(exclusiveStartKey)
            }
            val response = dynamoDbClient.query(builder.build())
            items.addAll(response.items())
            exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
        } while (!exclusiveStartKey.isNullOrEmpty())

        items.mapNotNull { itemToProject(it) }
    }

    /**
     * One page of the customer's projects in the table's native key order
     * (projectId — the base table has no updatedAt sort, so a paged read
     * cannot be most-recently-updated-first; callers that need that ordering
     * use the fetch-all [getProjects]).
     */
    suspend fun getProjectsPage(
        customerId: String,
        pageSize: Int,
        exclusiveStartKey: String?
    ): Pair<List<Project>, String?> = withContext(Dispatchers.IO) {
        val builder = QueryRequest.builder()
            .tableName(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE)
            .keyConditionExpression("$CUSTOMER_ID_KEY = :cid")
            .expressionAttributeValues(
                mapOf(":cid" to AttributeValue.builder().s(customerId).build())
            )
            .limit(pageSize)

        if (!exclusiveStartKey.isNullOrBlank()) {
            try {
                val keyMap: Map<String, String> = Json.decodeFromString(exclusiveStartKey)
                builder.exclusiveStartKey(keyMap.mapValues { (_, v) -> AttributeValue.builder().s(v).build() })
            } catch (e: Exception) {
                logger.warn { "Failed to parse projects exclusiveStartKey, starting from beginning: ${e.message}" }
            }
        }

        val response = dynamoDbClient.query(builder.build())
        val nextPageToken: String? = if (response.hasLastEvaluatedKey() && response.lastEvaluatedKey().isNotEmpty()) {
            Json.encodeToString(response.lastEvaluatedKey().mapValues { (_, v) -> v.s() ?: "" })
        } else null

        response.items().mapNotNull { itemToProject(it) } to nextPageToken
    }

    suspend fun getProject(customerId: String, projectId: String): Project? = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE)
                .key(projectKey(customerId, projectId))
                .build()
        )
        if (response.hasItem() && response.item().isNotEmpty()) itemToProject(response.item()) else null
    }

    /** Renames a project. Returns false when it no longer exists. */
    suspend fun renameProject(
        customerId: String,
        projectId: String,
        name: String
    ): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.updateItem(
                UpdateItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE)
                    .key(projectKey(customerId, projectId))
                    .updateExpression("SET #name = :name, #updatedAt = :now")
                    .conditionExpression("attribute_exists($PROJECT_ID_KEY)")
                    .expressionAttributeNames(mapOf("#name" to PROJECT_NAME_KEY, "#updatedAt" to "updatedAt"))
                    .expressionAttributeValues(
                        mapOf(
                            ":name" to AttributeValue.builder().s(name).build(),
                            ":now" to AttributeValue.builder().s(Instant.now().toString()).build()
                        )
                    )
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            logger.warn { "Skipped rename of missing project $projectId for $customerId" }
            false
        }
    }

    /**
     * Deletes the project row only. Returns false when it no longer exists.
     * Unassigning the project's conversations is the service's job, done
     * before this call so a mid-crash leaves a retryable state.
     */
    suspend fun deleteProject(customerId: String, projectId: String): Boolean = withContext(Dispatchers.IO) {
        try {
            dynamoDbClient.deleteItem(
                DeleteItemRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_PROJECTS_TABLE)
                    .key(projectKey(customerId, projectId))
                    .conditionExpression("attribute_exists($PROJECT_ID_KEY)")
                    .build()
            )
            logger.info { "Deleted project $projectId for customer $customerId" }
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        }
    }

    private fun projectKey(customerId: String, projectId: String) = mapOf(
        CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
        PROJECT_ID_KEY to AttributeValue.builder().s(projectId).build()
    )

    private fun itemToProject(item: Map<String, AttributeValue>): Project? {
        val projectId = item[PROJECT_ID_KEY]?.s() ?: return null
        val name = item[PROJECT_NAME_KEY]?.s() ?: return null
        return Project(
            projectId = projectId,
            name = name,
            createdAt = item["createdAt"]?.s() ?: "",
            updatedAt = item["updatedAt"]?.s() ?: ""
        )
    }
}
