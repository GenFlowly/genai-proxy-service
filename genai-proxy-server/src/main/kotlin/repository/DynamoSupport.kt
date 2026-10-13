package com.genflowly.repository

import java.time.Instant
import kotlinx.coroutines.delay
import com.genflowly.models.AIConfig
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.BatchGetItemRequest
import software.amazon.awssdk.services.dynamodb.model.BatchWriteItemRequest
import software.amazon.awssdk.services.dynamodb.model.KeysAndAttributes
import software.amazon.awssdk.services.dynamodb.model.WriteRequest
import com.genflowly.models.AIVendor

/**
 * Cross-repository DynamoDB mechanics. Nothing in here may contain domain
 * policy — only storage plumbing shared by the per-domain repositories.
 */

/** Stamps createdAt/updatedAt (same instant) onto a new item. */
internal fun withTimestamps(base: Map<String, AttributeValue>): Map<String, AttributeValue> {
    val now = Instant.now().toString()
    return base + mapOf(
        "createdAt" to AttributeValue.builder().s(now).build(),
        "updatedAt" to AttributeValue.builder().s(now).build()
    )
}

internal fun aiConfigToAttributeValue(aiConfig: List<AIConfig>): AttributeValue =
    AttributeValue.builder()
        .l(
            aiConfig.map { config ->
                AttributeValue.builder()
                    .m(
                        mapOf(
                            "aiVendor" to AttributeValue.builder().s(config.aiVendor.name).build(),
                            "model" to AttributeValue.builder().s(config.model).build()
                        )
                    )
                    .build()
            }
        )
        .build()

internal fun attributeValueToAiConfig(attributeValue: AttributeValue): List<AIConfig> =
    attributeValue.l().map { av ->
        val map = av.m()
        AIConfig(
            aiVendor = AIVendor.valueOf(map["aiVendor"]!!.s()),
            model = map["model"]!!.s()
        )
    }

/**
 * BatchWriteItem with retry of unprocessed (throttled) items — up to 3
 * attempts with linear backoff — so a partial batch never silently drops rows.
 */
internal suspend fun DynamoDbClient.batchWriteWithRetry(requestItems: Map<String, List<WriteRequest>>) {
    var request = BatchWriteItemRequest.builder().requestItems(requestItems).build()
    var response = batchWriteItem(request)
    var retries = 0
    while (response.hasUnprocessedItems() && response.unprocessedItems().isNotEmpty() && retries < 3) {
        retries++
        delay(200L * retries)
        request = BatchWriteItemRequest.builder().requestItems(response.unprocessedItems()).build()
        response = batchWriteItem(request)
    }
}

/**
 * BatchGetItem with chunking (100-key API limit) and retry of unprocessed
 * (throttled) keys — up to 3 attempts with linear backoff, mirroring
 * [batchWriteWithRetry] — so a partial batch never silently drops rows.
 */
internal suspend fun DynamoDbClient.batchGetWithRetry(
    tableName: String,
    keys: List<Map<String, AttributeValue>>,
    projectionExpression: String? = null,
    expressionAttributeNames: Map<String, String>? = null
): List<Map<String, AttributeValue>> {
    val results = mutableListOf<Map<String, AttributeValue>>()
    for (chunk in keys.chunked(100)) {
        var requestKeys = chunk
        var retries = 0
        while (requestKeys.isNotEmpty()) {
            val keysAndAttributes = KeysAndAttributes.builder().keys(requestKeys)
            if (projectionExpression != null) keysAndAttributes.projectionExpression(projectionExpression)
            if (!expressionAttributeNames.isNullOrEmpty()) {
                keysAndAttributes.expressionAttributeNames(expressionAttributeNames)
            }
            val response = batchGetItem(
                BatchGetItemRequest.builder()
                    .requestItems(mapOf(tableName to keysAndAttributes.build()))
                    .build()
            )
            results.addAll(response.responses()[tableName].orEmpty())
            val unprocessed = response.unprocessedKeys()[tableName]?.keys().orEmpty()
            if (unprocessed.isEmpty() || retries >= 3) break
            retries++
            delay(200L * retries)
            requestKeys = unprocessed
        }
    }
    return results
}
