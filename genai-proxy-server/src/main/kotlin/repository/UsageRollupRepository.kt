package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.models.Message
import com.genflowly.models.UsageCategory
import com.genflowly.models.UsageRollupRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest

/**
 * Data access for CustomerAIUsage: the per-customer usage/cost rollup
 * backing the Cost and Usage settings pages.
 *
 * The sort key (usageDate) is a composite
 * "{YYYY-MM-DD}#{category}#{vendor}#{dim3}" string — not a bare date — so one
 * bounded [queryRange] per customer per date window returns every
 * category/vendor/dim3 bucket touched in that window, with no GSI and no
 * fan-out across conversations/collections. Writers ADD their numeric deltas
 * atomically; the composite key's descriptive fields (category/vendor/dim3)
 * are SET on every write, which is idempotent.
 */
class UsageRollupRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /**
     * Every (category, vendor, dim3) row whose usageDate falls within
     * [fromDate, toDate] (both inclusive, "YYYY-MM-DD"), for one customer.
     * "~" (0x7E) sorts after any "#..." suffix a bare date could have, so the
     * upper bound catches every row stamped on [toDate] regardless of
     * category/vendor/dim3.
     */
    suspend fun queryRange(customerId: String, fromDate: String, toDate: String): List<UsageRollupRow> =
        withContext(Dispatchers.IO) {
            val rows = mutableListOf<UsageRollupRow>()
            var exclusiveStartKey: Map<String, AttributeValue>? = null
            do {
                val queryBuilder = QueryRequest.builder()
                    .tableName(DynamoDBConstants.CUSTOMER_USAGE_TABLE)
                    .keyConditionExpression("#cid = :cid AND #ud BETWEEN :from AND :to")
                    .expressionAttributeNames(mapOf(
                        "#cid" to CUSTOMER_ID_KEY,
                        "#ud" to DynamoDBConstants.USAGE_DATE_SORT_KEY
                    ))
                    .expressionAttributeValues(mapOf(
                        ":cid" to AttributeValue.builder().s(customerId).build(),
                        ":from" to AttributeValue.builder().s(fromDate).build(),
                        ":to" to AttributeValue.builder().s("$toDate~").build()
                    ))
                if (!exclusiveStartKey.isNullOrEmpty()) {
                    queryBuilder.exclusiveStartKey(exclusiveStartKey)
                }
                val response = dynamoDbClient.query(queryBuilder.build())
                response.items().forEach { item -> toRow(item)?.let { rows.add(it) } }
                exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
            } while (!exclusiveStartKey.isNullOrEmpty())
            rows
        }

    /**
     * Fans a message's token/cost usage into the LLM rollup bucket for the
     * day it was created. Best-effort: callers must catch and swallow —
     * never let a rollup failure fail the message save. Call only for
     * freshly-generated messages (never for [Message.createdAt]-preserving
     * copies, e.g. conversation forks, which would double-count history).
     */
    suspend fun incrementLlmUsage(message: Message) = withContext(Dispatchers.IO) {
        val config = message.aiConfig.firstOrNull() ?: return@withContext
        if ((message.inputTokens ?: 0) == 0 && (message.outputTokens ?: 0) == 0) return@withContext

        val date = (message.createdAt ?: java.time.Instant.now().toString()).substring(0, 10)
        val vendor = config.aiVendor.name
        val model = config.model
        val sortKey = "$date#${UsageCategory.LLM.storageKey}#$vendor#$model"

        val updateExpressionParts = mutableListOf("SET #cat = :cat, #ven = :ven, #d3 = :d3")
        val addParts = mutableListOf("requestCount :one")
        val names = mutableMapOf(
            "#cat" to DynamoDBConstants.USAGE_CATEGORY_KEY,
            "#ven" to DynamoDBConstants.USAGE_VENDOR_KEY,
            "#d3" to DynamoDBConstants.USAGE_DIM3_KEY
        )
        val values = mutableMapOf(
            ":cat" to AttributeValue.builder().s(UsageCategory.LLM.storageKey).build(),
            ":ven" to AttributeValue.builder().s(vendor).build(),
            ":d3" to AttributeValue.builder().s(model).build(),
            ":one" to AttributeValue.builder().n("1").build()
        )

        fun addNumeric(attr: String, value: Number?) {
            if (value == null) return
            val key = ":$attr"
            addParts.add("$attr $key")
            values[key] = AttributeValue.builder().n(value.toString()).build()
        }

        addNumeric("costUsd", message.costUsd)
        addNumeric("reasoningCostUsd", message.reasoningCostUsd)
        addNumeric("inputTokens", message.inputTokens)
        addNumeric("outputTokens", message.outputTokens)
        addNumeric("totalTokens", message.totalTokens)
        addNumeric("cacheReadTokens", message.tokensReadFromCache)
        addNumeric("cacheWriteTokens", message.tokensWrittenToCache)
        addNumeric("reasoningTokens", message.reasoningTokens)

        updateExpressionParts.add("ADD ${addParts.joinToString(", ")}")

        dynamoDbClient.updateItem(
            UpdateItemRequest.builder()
                .tableName(DynamoDBConstants.CUSTOMER_USAGE_TABLE)
                .key(mapOf(
                    CUSTOMER_ID_KEY to AttributeValue.builder().s(message.customerId).build(),
                    DynamoDBConstants.USAGE_DATE_SORT_KEY to AttributeValue.builder().s(sortKey).build()
                ))
                .updateExpression(updateExpressionParts.joinToString(" "))
                .expressionAttributeNames(names)
                .expressionAttributeValues(values)
                .build()
        )
    }

    private fun toRow(item: Map<String, AttributeValue>): UsageRollupRow? {
        val sortKey = item[DynamoDBConstants.USAGE_DATE_SORT_KEY]?.s() ?: return null
        val date = sortKey.substringBefore('#')
        val category = item[DynamoDBConstants.USAGE_CATEGORY_KEY]?.s()?.let { UsageCategory.fromStorageKey(it) }
            ?: run {
                logger.warn { "Skipping CustomerAIUsage row with unknown category: $sortKey" }
                return null
            }
        val vendor = item[DynamoDBConstants.USAGE_VENDOR_KEY]?.s() ?: return null
        val dim3 = item[DynamoDBConstants.USAGE_DIM3_KEY]?.s() ?: return null
        val metrics = item
            .filterKeys { it !in RESERVED_KEYS }
            .mapNotNull { (k, v) -> v.n()?.toDoubleOrNull()?.let { k to it } }
            .toMap()
        return UsageRollupRow(category = category, date = date, vendor = vendor, dim3 = dim3, metrics = metrics)
    }

    companion object {
        private val RESERVED_KEYS = setOf(
            CUSTOMER_ID_KEY,
            DynamoDBConstants.USAGE_DATE_SORT_KEY,
            DynamoDBConstants.USAGE_CATEGORY_KEY,
            DynamoDBConstants.USAGE_VENDOR_KEY,
            DynamoDBConstants.USAGE_DIM3_KEY
        )
    }
}
