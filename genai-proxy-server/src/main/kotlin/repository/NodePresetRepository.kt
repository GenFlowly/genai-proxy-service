package com.genflowly.repository

import com.genflowly.DynamoDBConstants.NODE_PRESETS_TABLE
import com.genflowly.DynamoDBConstants.PRESET_CONFIG_KEY
import com.genflowly.DynamoDBConstants.PRESET_DESCRIPTION_KEY
import com.genflowly.DynamoDBConstants.PRESET_ID_KEY
import com.genflowly.DynamoDBConstants.PRESET_NAME_KEY
import com.genflowly.DynamoDBConstants.PRESET_NODE_TYPE_KEY
import com.genflowly.DynamoDBConstants.PRESET_REQUIRED_ATTRIBUTES_KEY
import com.genflowly.DynamoDBConstants.PRESET_SORT_ORDER_KEY
import com.genflowly.models.api.NodePreset
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.ScanRequest

/**
 * Data access for the NodePresets table: the admin-curated "pre-made nodes"
 * offered in the graph editor palette. A handful of small rows — a scan is
 * the right listing primitive.
 */
class NodePresetRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun listPresets(): List<NodePreset> = withContext(Dispatchers.IO) {
        val items = mutableListOf<Map<String, AttributeValue>>()
        var exclusiveStartKey: Map<String, AttributeValue>? = null
        do {
            val builder = ScanRequest.builder().tableName(NODE_PRESETS_TABLE)
            if (!exclusiveStartKey.isNullOrEmpty()) builder.exclusiveStartKey(exclusiveStartKey)
            val response = dynamoDbClient.scan(builder.build())
            items.addAll(response.items())
            exclusiveStartKey = if (response.hasLastEvaluatedKey()) response.lastEvaluatedKey() else null
        } while (!exclusiveStartKey.isNullOrEmpty())
        items.mapNotNull { itemToPreset(it) }
    }

    suspend fun getPreset(presetId: String): NodePreset? = withContext(Dispatchers.IO) {
        val item = dynamoDbClient.getItem(
            GetItemRequest.builder()
                .tableName(NODE_PRESETS_TABLE)
                .key(mapOf(PRESET_ID_KEY to AttributeValue.builder().s(presetId).build()))
                .build()
        ).item()
        if (item.isNullOrEmpty()) null else itemToPreset(item)
    }

    suspend fun putPreset(preset: NodePreset) = withContext(Dispatchers.IO) {
        val now = Instant.now().toString()
        val item = buildMap {
            put(PRESET_ID_KEY, AttributeValue.builder().s(preset.presetId).build())
            put(PRESET_NAME_KEY, AttributeValue.builder().s(preset.name).build())
            put(PRESET_NODE_TYPE_KEY, AttributeValue.builder().s(preset.nodeType).build())
            put(PRESET_DESCRIPTION_KEY, AttributeValue.builder().s(preset.description).build())
            put(PRESET_CONFIG_KEY, AttributeValue.builder().s(preset.config).build())
            put(
                PRESET_REQUIRED_ATTRIBUTES_KEY,
                AttributeValue.builder()
                    .l(preset.requiredAttributes.map { AttributeValue.builder().s(it).build() })
                    .build()
            )
            put(PRESET_SORT_ORDER_KEY, AttributeValue.builder().n(preset.sortOrder.toString()).build())
            put("createdAt", AttributeValue.builder().s(preset.createdAt ?: now).build())
            put("updatedAt", AttributeValue.builder().s(now).build())
        }
        dynamoDbClient.putItem(PutItemRequest.builder().tableName(NODE_PRESETS_TABLE).item(item).build())
        logger.info("Saved node preset ${preset.presetId} ('${preset.name}', ${preset.nodeType})")
    }

    suspend fun deletePreset(presetId: String) = withContext(Dispatchers.IO) {
        dynamoDbClient.deleteItem(
            DeleteItemRequest.builder()
                .tableName(NODE_PRESETS_TABLE)
                .key(mapOf(PRESET_ID_KEY to AttributeValue.builder().s(presetId).build()))
                .build()
        )
        logger.info("Deleted node preset $presetId")
    }

    private fun itemToPreset(item: Map<String, AttributeValue>): NodePreset? {
        return NodePreset(
            presetId = item[PRESET_ID_KEY]?.s() ?: return null,
            name = item[PRESET_NAME_KEY]?.s() ?: return null,
            nodeType = item[PRESET_NODE_TYPE_KEY]?.s() ?: return null,
            description = item[PRESET_DESCRIPTION_KEY]?.s() ?: "",
            config = item[PRESET_CONFIG_KEY]?.s() ?: "{}",
            requiredAttributes = item[PRESET_REQUIRED_ATTRIBUTES_KEY]?.l()?.map { it.s() } ?: emptyList(),
            sortOrder = item[PRESET_SORT_ORDER_KEY]?.n()?.toIntOrNull() ?: 0,
            createdAt = item["createdAt"]?.s(),
            updatedAt = item["updatedAt"]?.s(),
        )
    }
}
