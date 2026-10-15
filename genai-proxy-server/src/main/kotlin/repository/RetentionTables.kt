package com.genflowly.repository

import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

/**
 * Table, index and attribute names of the retention and purge data model.
 * The CDK (genai-proxy-server-cdk/lib/dynamodb-stack.ts) defines the same
 * names; change both together.
 */
object RetentionTables {
    /**
     * Message GSI (customerId, createdAt), KEYS_ONLY: every message a customer
     * wrote, in any conversation. Account deletion reads it to keep the
     * customer's messages in other people's conversations.
     */
    const val MESSAGE_CUSTOMER_GSI = "customerIdIndex"

    /**
     * Sparse Message GSI (claimPending, createdAt), KEYS_ONLY. Only rows whose
     * kept-object claim failed carry claimPending (Number 1), so the index is
     * exactly the reconciler's work queue, oldest first.
     */
    const val MESSAGE_CLAIM_PENDING_GSI = "claimPendingIndex"
    const val CLAIM_PENDING_KEY = "claimPending"

    /** Set on a Conversation row when its purge takes its lease; blocks new messages. */
    const val PURGE_STARTED_AT_KEY = "purgeStartedAt"

    /**
     * Purge work queue. PK [PURGE_JOB_KEY]: "ACCOUNT#{customerId}" for an
     * account deletion, the conversationId for a conversation purge.
     */
    const val PURGE_JOBS_TABLE = "PurgeJobs"
    const val PURGE_JOB_KEY = "jobKey"
    const val ACCOUNT_JOB_PREFIX = "ACCOUNT#"

    /**
     * Sparse GSI (pendingShard, dueAt), same pattern as the memory-extraction
     * queue: only unfinished jobs carry pendingShard.
     */
    const val PURGE_PENDING_INDEX = "pending-purge-index"
    const val PURGE_PENDING_SHARD_KEY = "pendingShard"
    const val PURGE_PENDING_SHARD_VALUE = "PENDING"
    const val PURGE_DUE_AT_KEY = "dueAt"

    /** CustomerProfile sub of a deleted customer's renamed row. */
    const val DELETED_SUB_PREFIX = "DELETED#"
    const val DELETED_USER_NAME = "Deleted User"

    fun accountJobKey(customerId: String): String = "$ACCOUNT_JOB_PREFIX$customerId"
}

/**
 * Opaque, URL-safe page token for a DynamoDB LastEvaluatedKey (string and
 * number attributes only, which covers every key schema here).
 */
internal object PageTokens {
    private val json = Json { ignoreUnknownKeys = true }

    fun encode(key: Map<String, AttributeValue>?): String? {
        if (key.isNullOrEmpty()) return null
        val obj = JsonObject(key.mapValues { (_, v) ->
            when {
                v.s() != null -> JsonObject(mapOf("S" to JsonPrimitive(v.s())))
                v.n() != null -> JsonObject(mapOf("N" to JsonPrimitive(v.n())))
                else -> throw IllegalArgumentException("Unsupported key attribute type")
            }
        })
        return Base64.getUrlEncoder().withoutPadding().encodeToString(obj.toString().toByteArray())
    }

    /** Decodes a token from [encode]; throws IllegalArgumentException when it is not one. */
    fun decode(token: String?): Map<String, AttributeValue>? {
        if (token.isNullOrBlank()) return null
        return try {
            val text = String(Base64.getUrlDecoder().decode(token))
            json.parseToJsonElement(text).jsonObject.mapValues { (_, v) ->
                val typed = v.jsonObject
                typed["S"]?.let { AttributeValue.builder().s(it.jsonPrimitive.content).build() }
                    ?: typed["N"]?.let { AttributeValue.builder().n(it.jsonPrimitive.content).build() }
                    ?: throw IllegalArgumentException("Unsupported key attribute type")
            }
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("Invalid page token")
        } catch (e: Exception) {
            throw IllegalArgumentException("Invalid page token")
        }
    }
}
