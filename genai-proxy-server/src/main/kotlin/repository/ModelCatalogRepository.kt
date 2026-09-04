package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.AI_VENDOR_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.genflowly.models.ModelCatalogEntry
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.WriteRequest

/** Data access for the AIModelCatalog table (per-model token limits + pricing). */
class ModelCatalogRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    /**
     * Upserts one vendor's model-catalog entries (token limits per model).
     * Batched in chunks of 25 — the BatchWriteItem maximum.
     */
    suspend fun saveModelCatalogEntries(
        aiVendor: String,
        entries: List<ModelCatalogEntry>
    ) = withContext(Dispatchers.IO) {
        val now = Instant.now().toString()
        entries.chunked(25).forEach { chunk ->
            val writeRequests = chunk.map { entry ->
                val item = buildMap {
                    put(AI_VENDOR_KEY, AttributeValue.builder().s(aiVendor).build())
                    put(DynamoDBConstants.MODEL_SORT_KEY, AttributeValue.builder().s(entry.model).build())
                    entry.maxOutputTokens?.let {
                        put("maxOutputTokens", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.maxInputTokens?.let {
                        put("maxInputTokens", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.inputCostPerMTok?.let {
                        put("inputCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.outputCostPerMTok?.let {
                        put("outputCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.cacheReadCostPerMTok?.let {
                        put("cacheReadCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.cacheWriteCostPerMTok?.let {
                        put("cacheWriteCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.inputAudioCostPerMTok?.let {
                        put("inputAudioCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.outputAudioCostPerMTok?.let {
                        put("outputAudioCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    entry.cacheReadAudioCostPerMTok?.let {
                        put("cacheReadAudioCostPerMTok", AttributeValue.builder().n(it.toString()).build())
                    }
                    put("updatedAt", AttributeValue.builder().s(now).build())
                }
                WriteRequest.builder()
                    .putRequest(PutRequest.builder().item(item).build())
                    .build()
            }
            // Retry throttled leftovers so a partial batch never silently drops rows
            dynamoDbClient.batchWriteWithRetry(mapOf(DynamoDBConstants.AI_MODEL_CATALOG_TABLE to writeRequests))
        }
        logger.info("Saved ${entries.size} model catalog entries for vendor $aiVendor")
    }

    suspend fun getModelCatalogEntry(aiVendor: String, model: String): ModelCatalogEntry? =
        withContext(Dispatchers.IO) {
            val response = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(DynamoDBConstants.AI_MODEL_CATALOG_TABLE)
                    .key(mapOf(
                        AI_VENDOR_KEY to AttributeValue.builder().s(aiVendor).build(),
                        DynamoDBConstants.MODEL_SORT_KEY to AttributeValue.builder().s(model).build()
                    ))
                    .build()
            )
            val item = response.item()?.takeIf { it.isNotEmpty() } ?: return@withContext null
            toEntry(item, model)
        }

    /**
     * Latest date-suffixed variant of an alias model id (e.g.
     * "claude-opus-4-5" -> "claude-opus-4-5-20251101"). The LiteLLM-sourced
     * catalog often carries only dated snapshot ids while the vendors accept
     * the undated alias; limits and pricing are identical, so the newest
     * variant is a faithful stand-in. YYYYMMDD suffixes sort chronologically,
     * so the highest sort key is the newest snapshot.
     */
    suspend fun findLatestDatedVariant(aiVendor: String, model: String): ModelCatalogEntry? =
        withContext(Dispatchers.IO) {
            val prefix = "$model-"
            val response = dynamoDbClient.query(
                QueryRequest.builder()
                    .tableName(DynamoDBConstants.AI_MODEL_CATALOG_TABLE)
                    .keyConditionExpression("#v = :v AND begins_with(#m, :p)")
                    .expressionAttributeNames(mapOf(
                        "#v" to AI_VENDOR_KEY,
                        "#m" to DynamoDBConstants.MODEL_SORT_KEY
                    ))
                    .expressionAttributeValues(mapOf(
                        ":v" to AttributeValue.builder().s(aiVendor).build(),
                        ":p" to AttributeValue.builder().s(prefix).build()
                    ))
                    .scanIndexForward(false)
                    .build()
            )
            val item = response.items().firstOrNull { candidate ->
                candidate[DynamoDBConstants.MODEL_SORT_KEY]?.s()
                    ?.removePrefix(prefix)?.matches(Regex("\\d{8}")) == true
            } ?: return@withContext null
            toEntry(item, item[DynamoDBConstants.MODEL_SORT_KEY]!!.s())
        }

    private fun toEntry(item: Map<String, AttributeValue>, model: String) = ModelCatalogEntry(
        model = model,
        maxOutputTokens = item["maxOutputTokens"]?.n()?.toIntOrNull(),
        maxInputTokens = item["maxInputTokens"]?.n()?.toIntOrNull(),
        inputCostPerMTok = item["inputCostPerMTok"]?.n()?.toDoubleOrNull(),
        outputCostPerMTok = item["outputCostPerMTok"]?.n()?.toDoubleOrNull(),
        cacheReadCostPerMTok = item["cacheReadCostPerMTok"]?.n()?.toDoubleOrNull(),
        cacheWriteCostPerMTok = item["cacheWriteCostPerMTok"]?.n()?.toDoubleOrNull(),
        inputAudioCostPerMTok = item["inputAudioCostPerMTok"]?.n()?.toDoubleOrNull(),
        outputAudioCostPerMTok = item["outputAudioCostPerMTok"]?.n()?.toDoubleOrNull(),
        cacheReadAudioCostPerMTok = item["cacheReadAudioCostPerMTok"]?.n()?.toDoubleOrNull()
    )
}
