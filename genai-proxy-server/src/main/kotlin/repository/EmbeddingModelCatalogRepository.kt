package com.genflowly.repository

import com.genflowly.DynamoDBConstants.CUSTOMER_EMBEDDING_MODELS_TABLE
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.VENDOR_KEY
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest

/** One vendor's probed model list for a customer. */
data class ProbedModels(
    val models: List<String>,
    val lastProbedAt: Instant?,
    /** sha256 prefix of the key the list was probed with — a rotation invalidates it. */
    val keyFingerprint: String?,
    /** True when the probe's vendor rejected the key itself (auth) — the key can't embed at all. */
    val authFailed: Boolean = false
)

/**
 * Data access for the CustomerEmbeddingModels table: per (customerId, vendor)
 * the list of embedding models the customer's key actually embeds, discovered
 * by [com.genflowly.service.EmbeddingModelCatalogService]. PK = customerId,
 * SK = vendor. A sentinel row ([SWEEP_LEASE_PK]) holds the weekly-sweep lease.
 */
class EmbeddingModelCatalogRepository(
    private val dynamoDbClient: DynamoDbClient,
    private val logger: KLogger
) {
    companion object {
        // Sentinel partition for the singleton weekly-sweep lease — a customerId
        // can never collide with it (real ids are "CU…").
        const val SWEEP_LEASE_PK = "__SWEEP__"
        const val SWEEP_LEASE_SK = "LEASE"
        private const val MODELS_ATTR = "models"
        private const val LAST_PROBED_ATTR = "lastProbedAt"
        private const val KEY_FINGERPRINT_ATTR = "keyFingerprint"
        private const val AUTH_FAILED_ATTR = "authFailed"
        private const val LEASE_UNTIL_ATTR = "leaseUntil"
    }

    suspend fun getProbed(customerId: String, vendor: String): ProbedModels? =
        withContext(Dispatchers.IO) {
            val response = dynamoDbClient.getItem(
                GetItemRequest.builder()
                    .tableName(CUSTOMER_EMBEDDING_MODELS_TABLE)
                    .key(
                        mapOf(
                            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
                            VENDOR_KEY to AttributeValue.builder().s(vendor).build()
                        )
                    )
                    .build()
            )
            val item = response.item() ?: return@withContext null
            if (item.isEmpty()) return@withContext null
            ProbedModels(
                models = item[MODELS_ATTR]?.l()?.mapNotNull { it.s() } ?: emptyList(),
                lastProbedAt = item[LAST_PROBED_ATTR]?.s()?.let { runCatching { Instant.parse(it) }.getOrNull() },
                keyFingerprint = item[KEY_FINGERPRINT_ATTR]?.s(),
                authFailed = item[AUTH_FAILED_ATTR]?.bool() ?: false
            )
        }

    suspend fun putProbed(
        customerId: String,
        vendor: String,
        models: List<String>,
        keyFingerprint: String,
        authFailed: Boolean = false
    ) = withContext(Dispatchers.IO) {
        val item = mapOf(
            CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build(),
            VENDOR_KEY to AttributeValue.builder().s(vendor).build(),
            MODELS_ATTR to AttributeValue.builder()
                .l(models.map { AttributeValue.builder().s(it).build() }).build(),
            LAST_PROBED_ATTR to AttributeValue.builder().s(Instant.now().toString()).build(),
            KEY_FINGERPRINT_ATTR to AttributeValue.builder().s(keyFingerprint).build(),
            AUTH_FAILED_ATTR to AttributeValue.builder().bool(authFailed).build()
        )
        dynamoDbClient.putItem(
            PutItemRequest.builder()
                .tableName(CUSTOMER_EMBEDDING_MODELS_TABLE)
                .item(item)
                .build()
        )
        Unit
    }

    /**
     * Best-effort mutual exclusion for the weekly sweep across proxy instances:
     * writes the lease sentinel only if it's absent or expired. Returns true to
     * the single winner. A crashed holder's lease self-heals once [leaseMillis]
     * elapses. Never throws — a DDB hiccup just means "didn't get the lease".
     */
    suspend fun tryAcquireSweepLease(leaseMillis: Long): Boolean = withContext(Dispatchers.IO) {
        val now = System.currentTimeMillis()
        return@withContext try {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(CUSTOMER_EMBEDDING_MODELS_TABLE)
                    .item(
                        mapOf(
                            CUSTOMER_ID_KEY to AttributeValue.builder().s(SWEEP_LEASE_PK).build(),
                            VENDOR_KEY to AttributeValue.builder().s(SWEEP_LEASE_SK).build(),
                            LEASE_UNTIL_ATTR to AttributeValue.builder().n((now + leaseMillis).toString()).build()
                        )
                    )
                    .conditionExpression("attribute_not_exists(#pk) OR #lease < :now")
                    .expressionAttributeNames(mapOf("#pk" to CUSTOMER_ID_KEY, "#lease" to LEASE_UNTIL_ATTR))
                    .expressionAttributeValues(mapOf(":now" to AttributeValue.builder().n(now.toString()).build()))
                    .build()
            )
            true
        } catch (e: ConditionalCheckFailedException) {
            false
        } catch (e: Exception) {
            logger.warn(e) { "Sweep-lease acquisition failed; skipping this cycle" }
            false
        }
    }

    /**
     * After a successful sweep, push the lease out by [cooldownMillis] so the
     * next sweep can't start until ~a week from now — the lease doubles as the
     * weekly-cadence gate. (On a crashed/failed sweep this is NOT called, so the
     * short acquisition lease just expires and another instance retries soon.)
     */
    suspend fun markSweepComplete(cooldownMillis: Long) = withContext(Dispatchers.IO) {
        val until = System.currentTimeMillis() + cooldownMillis
        runCatching {
            dynamoDbClient.putItem(
                PutItemRequest.builder()
                    .tableName(CUSTOMER_EMBEDDING_MODELS_TABLE)
                    .item(
                        mapOf(
                            CUSTOMER_ID_KEY to AttributeValue.builder().s(SWEEP_LEASE_PK).build(),
                            VENDOR_KEY to AttributeValue.builder().s(SWEEP_LEASE_SK).build(),
                            LEASE_UNTIL_ATTR to AttributeValue.builder().n(until.toString()).build()
                        )
                    )
                    .build()
            )
        }.onFailure { logger.warn(it) { "Failed to record sweep completion" } }
        Unit
    }
}
