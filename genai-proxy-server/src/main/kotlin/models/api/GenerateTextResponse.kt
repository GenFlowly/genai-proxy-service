package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextResponse(
    val text: String?,
    val aiVendor: String?,
    /** Model that generated this response (e.g. "gpt-4o"), from the message's aiConfig */
    val model: String? = null,
    val conversationId: String?,
    val messageId: String?,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null,
    /**
     * Exact USD cost of this turn (vendor-reported token buckets × catalog
     * rates). Null for messages persisted before cost tracking or when the
     * model had no catalog pricing.
     */
    val costUsd: Double? = null,
    /** Retrieval-server thinking time (request receipt → first generated token), ms */
    val thinkingDurationMs: Long? = null,
    /**
     * Tool calls the model made: [{"id","name","args"}]. Execute them and send the
     * results back via toolResults on the next generate request (with
     * selectedResponseId set to this messageId) to continue the turn.
     */
    val toolCalls: kotlinx.serialization.json.JsonElement? = null,
    /**
     * Web-search sources backing the [n] citation markers in the text:
     * [{"index","title","url"}]. Null when no web search ran for the turn.
     */
    val webSources: kotlinx.serialization.json.JsonElement? = null
)