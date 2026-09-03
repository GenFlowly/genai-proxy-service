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
     * Exact USD cost of this turn: the vendor-reported token buckets (text /
     * audio / cached, from the API response) priced at the AIModelCatalog
     * rates. Null when the model has no catalog pricing at persist time.
     */
    val costUsd: Double? = null,
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
     * ISO-8601 instant stamped by the repository's withTimestamps on write.
     * Read-only: populated when loading from DDB, ignored on create (the
     * provider always stamps its own value).
     */
    val createdAt: String? = null
)