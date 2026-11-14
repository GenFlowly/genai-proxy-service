package com.genflowly.repository

import com.genflowly.DynamoDBConstants.BLOCKED_CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.BLOCKER_CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.CREATED_AT_KEY
import com.genflowly.DynamoDBConstants.CUSTOMER_BLOCKS_BLOCKED_GSI
import com.genflowly.DynamoDBConstants.CUSTOMER_BLOCKS_TABLE
import com.genflowly.DynamoDBConstants.USERNAME_KEY
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.KeysAndAttributes
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.ResourceNotFoundException

data class CustomerBlock(
    val blockerCustomerId: String,
    val blockedCustomerId: String,
    val blockedUsername: String?,
    val blockedName: String?,
    val createdAt: String
)

class CustomerBlockRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /** Keeps the original row, and its date, when this pair is already blocked. */
    suspend fun block(block: CustomerBlock) = withContext(Dispatchers.IO) {
        val item = buildMap {
            put(BLOCKER_CUSTOMER_ID_KEY, s(block.blockerCustomerId))
            put(BLOCKED_CUSTOMER_ID_KEY, s(block.blockedCustomerId))
            put(CREATED_AT_KEY, s(block.createdAt))
            block.blockedUsername?.let { put(USERNAME_KEY, s(it)) }
            block.blockedName?.let { put(NAME_KEY, s(it)) }
        }
        try {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(CUSTOMER_BLOCKS_TABLE)
                    .item(item)
                    .conditionExpression("attribute_not_exists($BLOCKER_CUSTOMER_ID_KEY)")
                    .build()
            )
        } catch (e: ConditionalCheckFailedException) {
            logger.debug { "${block.blockerCustomerId} had already blocked ${block.blockedCustomerId}" }
        }
    }

    suspend fun unblock(blockerCustomerId: String, blockedCustomerId: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(CUSTOMER_BLOCKS_TABLE)
                .key(pairKey(blockerCustomerId, blockedCustomerId))
                .build()
        )
    }

    /** Everyone [blockerCustomerId] has blocked. */
    suspend fun blocksBy(blockerCustomerId: String): List<CustomerBlock> = withContext(Dispatchers.IO) {
        dynamoDbClient.queryPaginator(
            QueryRequest.builder()
                .tableName(CUSTOMER_BLOCKS_TABLE)
                .keyConditionExpression("$BLOCKER_CUSTOMER_ID_KEY = :id")
                .expressionAttributeValues(mapOf(":id" to s(blockerCustomerId)))
                .build()
        ).items().map { item ->
            CustomerBlock(
                blockerCustomerId = blockerCustomerId,
                blockedCustomerId = item.getValue(BLOCKED_CUSTOMER_ID_KEY).s(),
                blockedUsername = item[USERNAME_KEY]?.s(),
                blockedName = item[NAME_KEY]?.s(),
                createdAt = item[CREATED_AT_KEY]?.s().orEmpty()
            )
        }.toList()
    }

    /** Everyone who has blocked [blockedCustomerId]. */
    suspend fun blockersOf(blockedCustomerId: String): List<String> = withContext(Dispatchers.IO) {
        dynamoDbClient.queryPaginator(
            QueryRequest.builder()
                .tableName(CUSTOMER_BLOCKS_TABLE)
                .indexName(CUSTOMER_BLOCKS_BLOCKED_GSI)
                .keyConditionExpression("$BLOCKED_CUSTOMER_ID_KEY = :id")
                .expressionAttributeValues(mapOf(":id" to s(blockedCustomerId)))
                .build()
        ).items().mapNotNull { it[BLOCKER_CUSTOMER_ID_KEY]?.s() }.toList()
    }

    /** Whoever [customerId] has blocked or been blocked by. Empty on a stage whose table isn't deployed yet. */
    suspend fun relatedCustomerIds(customerId: String): Set<String> =
        whenTableExists(emptySet()) {
            (blocksBy(customerId).map { it.blockedCustomerId } + blockersOf(customerId)).toSet()
        }

    /** Whether either customer has blocked the other, read from the base table so a new block counts at once. */
    suspend fun isBlockedEitherWay(a: String, b: String): Boolean =
        whenTableExists(false) {
            withContext(Dispatchers.IO) {
                var pending = KeysAndAttributes.builder()
                    .keys(pairKey(a, b), pairKey(b, a))
                    .projectionExpression(BLOCKER_CUSTOMER_ID_KEY)
                    .consistentRead(true)
                    .build()
                while (true) {
                    val response = dynamoDbClient.batchGetItem(
                        BatchGetItemRequest.builder().requestItems(mapOf(CUSTOMER_BLOCKS_TABLE to pending)).build()
                    )
                    if (response.responses()[CUSTOMER_BLOCKS_TABLE].orEmpty().isNotEmpty()) return@withContext true
                    pending = response.unprocessedKeys()[CUSTOMER_BLOCKS_TABLE] ?: return@withContext false
                    if (!pending.hasKeys() || pending.keys().isEmpty()) return@withContext false
                }
                @Suppress("UNREACHABLE_CODE")
                false
            }
        }

    // A local stack can run this code against a shared stage before the CDK
    // deploy has created the table; reads must not take down unrelated pages.
    private suspend fun <T> whenTableExists(fallback: T, read: suspend () -> T): T =
        try {
            read()
        } catch (e: ResourceNotFoundException) {
            logger.error { "$CUSTOMER_BLOCKS_TABLE is missing on this stage; treating every customer as unblocked" }
            fallback
        }

    private fun pairKey(blocker: String, blocked: String): Map<String, AttributeValue> =
        mapOf(BLOCKER_CUSTOMER_ID_KEY to s(blocker), BLOCKED_CUSTOMER_ID_KEY to s(blocked))

    private fun s(value: String): AttributeValue = AttributeValue.builder().s(value).build()

    private companion object {
        const val NAME_KEY = "name"
    }
}
