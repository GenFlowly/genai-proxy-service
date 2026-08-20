package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CONVERSATION_ID_KEY
import com.genflowly.DynamoDBConstants.INSTRUCTION_ID_KEY
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest

/**
 * Data access for the SharedInstructions (generic entity shares) and
 * SharedConversations tables.
 *
 * NOTE (Phase 4): the users-with-shared-* methods still synthesize the PUBLIC
 * pseudo-profile and fan out to CustomerProfileRepository — that join/policy
 * ascends to the domain services in the service-decomposition phase, at which
 * point the profile-repository dependency here disappears.
 */
class ShareRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger,
    private val customerProfileRepository: CustomerProfileRepository
) {

    suspend fun shareEntityWithCustomer(entityId: String, sharedWithCustomerId: String, sharedByCustomerId: String, role: String) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                INSTRUCTION_ID_KEY to AttributeValue.builder().s(entityId).build(),
                DynamoDBConstants.SHARED_BY_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedByCustomerId).build(),
                DynamoDBConstants.ENTITY_ROLE_KEY to AttributeValue.builder().s(role).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Shared entity $entityId with $sharedWithCustomerId (by $sharedByCustomerId, role=$role)")
        } catch (e: Exception) {
            logger.error("Failed to share entity", e)
            throw e
        }
    }

    suspend fun unshareEntityWithCustomer(entityId: String, sharedWithCustomerId: String) = withContext(Dispatchers.IO) {
        try {
            val deleteReq = DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
                .key(
                    mapOf(
                        DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                        INSTRUCTION_ID_KEY to AttributeValue.builder().s(entityId).build()
                    )
                )
                .build()

            dynamoDbClient.deleteItem(deleteReq)
            logger.info("Unshared entity $entityId with $sharedWithCustomerId")
        } catch (e: Exception) {
            logger.error("Failed to unshare entity", e)
            throw e
        }
    }

    suspend fun getSharedEntityIdsForCustomer(customerId: String, prefix: String? = null): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
            .keyConditionExpression("${DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY} = :cid")
            .expressionAttributeValues(
                mapOf(":cid" to AttributeValue.builder().s(customerId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { item ->
            val id = item[INSTRUCTION_ID_KEY]?.s()
            val role = item[DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"
            if (id != null) id to role else null
        }.filter { prefix == null || it.first.startsWith(prefix) }
    }

    suspend fun getUsersWithSharedEntity(entityId: String): List<models.CustomerProfile> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(DynamoDBConstants.SHARED_INSTRUCTIONS_TABLE)
            .indexName(DynamoDBConstants.SHARED_INSTRUCTIONS_GSI_KEY)
            .keyConditionExpression("$INSTRUCTION_ID_KEY = :id")
            .expressionAttributeValues(
                mapOf(":id" to AttributeValue.builder().s(entityId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)

        response.items().mapNotNull { item ->
            val customerId = item[DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s() ?: return@mapNotNull null
            val role = item[DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"

            if (customerId == "PUBLIC") {
                return@mapNotNull models.CustomerProfile(
                    customerId = "PUBLIC",
                    sub = "",
                    client = "",
                    email = null,
                    name = "Public",
                    picture = null,
                    username = "Public",
                    isDiscoverable = true,
                    role = role
                )
            }

            val profileItem = customerProfileRepository.getCustomerProfileByCustomerId(customerId)
            if (profileItem != null) {
                models.CustomerProfile(
                    customerId = customerId,
                    sub = profileItem["sub"]?.s() ?: "",
                    client = profileItem["client"]?.s() ?: "",
                    email = profileItem["email"]?.s(),
                    name = profileItem["name"]?.s(),
                    picture = profileItem["picture"]?.s(),
                    username = profileItem["username"]?.s(),
                    isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false,
                    role = role
                )
            } else null
        }
    }

    suspend fun shareConversationWithCustomer(
        conversationId: String,
        sharedWithCustomerId: String,
        sharedByCustomerId: String,
        role: String
    ) = withContext(Dispatchers.IO) {
        try {
            val item = withTimestamps(mapOf(
                DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build(),
                DynamoDBConstants.SHARED_BY_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedByCustomerId).build(),
                DynamoDBConstants.ENTITY_ROLE_KEY to AttributeValue.builder().s(role).build()
            ))

            val putReq = PutItemRequest.builder()
                .tableName(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
                .item(item)
                .build()

            dynamoDbClient.putItem(putReq)
            logger.info("Shared conversation $conversationId with $sharedWithCustomerId (by $sharedByCustomerId, role=$role)")
        } catch (e: Exception) {
            logger.error("Failed to share conversation", e)
            throw e
        }
    }

    suspend fun unshareConversationWithCustomer(
        conversationId: String,
        sharedWithCustomerId: String
    ) = withContext(Dispatchers.IO) {
        try {
            val deleteReq = DeleteItemRequest.builder()
                .tableName(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
                .key(
                    mapOf(
                        DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(sharedWithCustomerId).build(),
                        CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
                    )
                )
                .build()

            dynamoDbClient.deleteItem(deleteReq)
            logger.info("Unshared conversation $conversationId with $sharedWithCustomerId")
        } catch (e: Exception) {
            logger.error("Failed to unshare conversation", e)
            throw e
        }
    }

    suspend fun unshareAllConversationWithCustomer(
        conversationId: String
    ) = withContext(Dispatchers.IO) {
        try {
            val request = QueryRequest.builder()
                .tableName(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
                .indexName(DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY)
                .keyConditionExpression("$CONVERSATION_ID_KEY = :id")
                .expressionAttributeValues(
                    mapOf(":id" to AttributeValue.builder().s(conversationId).build())
                )
                .build()

            val response = dynamoDbClient.query(request)

            response.items().forEach { item ->
                val sharedWithCustomerId = item[DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s()
                if (sharedWithCustomerId != null) {
                    unshareConversationWithCustomer(conversationId, sharedWithCustomerId)
                }
            }
            logger.info("Unshared all for conversation $conversationId")
        } catch (e: Exception) {
            logger.error("Failed to unshare all for conversation $conversationId", e)
            throw e
        }
    }

    /**
     * Returns (conversationId, role) pairs for every conversation shared with [customerId],
     * including any PUBLIC entries the customer inherits.
     */
    suspend fun getSharedConversationIdsForCustomer(customerId: String): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
            .keyConditionExpression("${DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY} = :cid")
            .expressionAttributeValues(
                mapOf(":cid" to AttributeValue.builder().s(customerId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)
        response.items().mapNotNull { item ->
            val id = item[CONVERSATION_ID_KEY]?.s()
            val role = item[DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"
            if (id != null) id to role else null
        }
    }

    /**
     * Returns the effective share role for [customerId] on [conversationId] via a direct
     * SharedConversations lookup, or null if no share exists. Does NOT consider PUBLIC —
     * callers should check PUBLIC separately.
     */
    suspend fun getConversationShare(conversationId: String, customerId: String): String? = withContext(Dispatchers.IO) {
        val request = GetItemRequest.builder()
            .tableName(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
            .key(mapOf(
                DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                CONVERSATION_ID_KEY to AttributeValue.builder().s(conversationId).build()
            ))
            .build()
        val item = dynamoDbClient.getItem(request).item()
        if (item.isNullOrEmpty()) null
        else item[DynamoDBConstants.ENTITY_ROLE_KEY]?.s()
    }

    suspend fun getUsersWithSharedConversation(conversationId: String): List<models.CustomerProfile> = withContext(Dispatchers.IO) {
        val request = QueryRequest.builder()
            .tableName(DynamoDBConstants.SHARED_CONVERSATIONS_TABLE)
            .indexName(DynamoDBConstants.SHARED_CONVERSATIONS_GSI_KEY)
            .keyConditionExpression("$CONVERSATION_ID_KEY = :id")
            .expressionAttributeValues(
                mapOf(":id" to AttributeValue.builder().s(conversationId).build())
            )
            .build()

        val response = dynamoDbClient.query(request)

        response.items().mapNotNull { item ->
            val customerId = item[DynamoDBConstants.SHARED_WITH_CUSTOMER_ID_KEY]?.s() ?: return@mapNotNull null
            val role = item[DynamoDBConstants.ENTITY_ROLE_KEY]?.s() ?: "VIEW"

            if (customerId == "PUBLIC") {
                return@mapNotNull models.CustomerProfile(
                    customerId = "PUBLIC",
                    sub = "",
                    client = "",
                    email = null,
                    name = "Public",
                    picture = null,
                    username = "Public",
                    isDiscoverable = true,
                    role = role
                )
            }

            val profileItem = customerProfileRepository.getCustomerProfileByCustomerId(customerId)
            if (profileItem != null) {
                models.CustomerProfile(
                    customerId = customerId,
                    sub = profileItem["sub"]?.s() ?: "",
                    client = profileItem["client"]?.s() ?: "",
                    email = profileItem["email"]?.s(),
                    name = profileItem["name"]?.s(),
                    picture = profileItem["picture"]?.s(),
                    username = profileItem["username"]?.s(),
                    isDiscoverable = profileItem["isDiscoverable"]?.bool() ?: false,
                    role = role
                )
            } else null
        }
    }
}
