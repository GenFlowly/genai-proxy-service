package com.genflowly.repository

import com.genflowly.DynamoDBConstants
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.QueryRequest

/**
 * Data access for UsageRateCard: admin-configurable per-unit USD rates for
 * the usage categories with no real per-request vendor price (vector_db op
 * counts, web_search credits). Priced at READ time — see
 * repository/UsageRollupRepository.kt for why these two categories differ
 * from LLM/embedding, which are priced at write time against AIModelCatalog.
 */
class UsageRateCardRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {

    suspend fun getRate(category: String, rateKey: String): Double? = withContext(Dispatchers.IO) {
        getRates(category)[rateKey]
    }

    /** Every rateKey -> usdRate currently configured for one category. */
    suspend fun getRates(category: String): Map<String, Double> = withContext(Dispatchers.IO) {
        val response = dynamoDbClient.query(
            QueryRequest.builder()
                .tableName(DynamoDBConstants.USAGE_RATE_CARD_TABLE)
                .keyConditionExpression("#cat = :cat")
                .expressionAttributeNames(mapOf("#cat" to DynamoDBConstants.USAGE_CATEGORY_KEY))
                .expressionAttributeValues(mapOf(":cat" to AttributeValue.builder().s(category).build()))
                .build()
        )
        response.items().mapNotNull { item ->
            val rateKey = item[DynamoDBConstants.USAGE_RATE_KEY]?.s() ?: return@mapNotNull null
            val usdRate = item[DynamoDBConstants.USAGE_USD_RATE_KEY]?.n()?.toDoubleOrNull() ?: return@mapNotNull null
            rateKey to usdRate
        }.toMap()
    }

    suspend fun putRate(category: String, rateKey: String, usdRate: Double, updatedBy: String) =
        withContext(Dispatchers.IO) {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(DynamoDBConstants.USAGE_RATE_CARD_TABLE)
                    .item(mapOf(
                        DynamoDBConstants.USAGE_CATEGORY_KEY to AttributeValue.builder().s(category).build(),
                        DynamoDBConstants.USAGE_RATE_KEY to AttributeValue.builder().s(rateKey).build(),
                        DynamoDBConstants.USAGE_USD_RATE_KEY to AttributeValue.builder().n(usdRate.toString()).build(),
                        "updatedAt" to AttributeValue.builder().s(Instant.now().toString()).build(),
                        "updatedBy" to AttributeValue.builder().s(updatedBy).build()
                    ))
                    .build()
            )
            logger.info { "Usage rate card: $category/$rateKey set to \$$usdRate by $updatedBy" }
        }
}
