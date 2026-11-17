package com.genflowly.models

import com.genflowly.models.AIVendor
import java.util.UUID

data class Message(
    val messageId: String = UUID.randomUUID().toString(),
    val conversationId: String,
    val text: String,
    /** Image attachments referenced by this message; bytes live in S3 */
    val attachments: List<AttachmentRef> = emptyList(),
    /**
     * Assistant messages: JSON array of tool calls the model made —
     * [{"id","name","args"}]. Needed to replay tool-use turns to the vendors.
     */
    val toolCallsJson: String? = null,
    /**
     * User messages: JSON array of caller-executed tool results —
     * [{"tool_call_id","content"}] — answering the previous assistant's calls.
     */
    val toolResultsJson: String? = null,
    /**
     * Assistant messages: JSON array of web-search sources backing the [n]
     * citation markers in the text — [{"index","title","url"}]. Null when no
     * WEB_SEARCH node ran for the turn.
     */
    val webSourcesJson: String? = null,
    val client: String,
    val role: String,
    val customerId: String,
    var sequence: Int? = 0,
    val systemPrompt: String,
    val aiConfig: List<AIConfig>,
    val previousMessageId: String?,
    val instructionId: String? = null,
    val instructionVersion: String? = null,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val totalTokens: Int? = null,
    val tokensReadFromCache: Int? = null,
    /** Prompt-cache write (cache_creation) tokens for this turn; billed at the cache-write rate. */
    val tokensWrittenToCache: Int? = null,
    /**
     * Reasoning/thinking tokens for this turn — a subset of [outputTokens]
     * (already included in it and in costUsd), broken out for spend
     * granularity. Null for pre-feature records and non-reasoning models.
     */
    val reasoningTokens: Int? = null,
    /**
     * Exact USD cost of this turn: the vendor-reported token buckets (text /
     * audio / cached, from the API response) priced at the AIModelCatalog
     * rates. Null when the model has no catalog pricing at persist time.
     */
    val costUsd: Double? = null,
    /**
     * USD spent on the [reasoningTokens] subset (output rate × reasoning
     * tokens). Already included in [costUsd] — never add the two.
     */
    val reasoningCostUsd: Double? = null,
    /**
     * Facts learned about the user from this exchange, written by the async
     * memory extraction: JSON [{"memoryId","text"},...]. null = extraction
     * still pending (or never triggered); "[]" = terminal, nothing learned.
     */
    val learnedFactsJson: String? = null,
    /**
     * How long the retrieval server "thought" before response generation began
     * (request receipt → first generated token), in milliseconds. Assistant
     * messages only; null for user messages and pre-feature records.
     */
    val thinkingDurationMs: Long? = null,
    /**
     * Assistant messages: the agent graph's thinking-step events for the turn,
     * as streamed ("ks" chunks) — JSON [{"node","name","kind","status",...}].
     * Raw running+done events; clients fold them into the per-node step list.
     * Null for user messages and records predating the feature.
     */
    val thinkingStepsJson: String? = null,
    /**
     * Assistant messages: the vendor's raw finish reason for the turn
     * (end_turn / stop / max_tokens / refusal / content_filter / …), streamed
     * as the "sr" chunk and persisted so a reload can still explain why
     * generation ended — a refusal has empty text, so this is the only record
     * of it. "cancelled" when the user stopped it (the text may be empty).
     * Null for user messages and records predating the feature.
     */
    val stopReason: String? = null,
    /**
     * ISO-8601 instant stamped by the repository's withTimestamps on write.
     * Read-only: populated when loading from DDB, ignored on create (the
     * provider always stamps its own value).
     */
    val createdAt: String? = null
)