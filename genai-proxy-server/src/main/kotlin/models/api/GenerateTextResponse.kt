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
    /**
     * True while a durable run is still generating this response — the assistant
     * message isn't persisted yet, so `text` is empty and token/cost are null.
     * Surfaced on the last turn when the conversation has a pendingRunId so a
     * reloading client renders the in-flight card and reattaches to the run's
     * stream (by this deterministic messageId) instead of treating an empty
     * response as "nothing generated". Always false for persisted responses.
     */
    val inFlight: Boolean = false,
    /** For an in-flight placeholder: the durable run to reattach to for this
     *  response. One per vendor, so a multi-vendor turn returns several. Null on
     *  persisted responses. */
    val runId: String? = null,
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
     * The agent graph's thinking-step events for this turn, as streamed ("ks"
     * chunks): [{"node","name","kind","status",...}]. Raw running+done events —
     * clients fold them into the per-node step list. Null for records
     * predating the feature.
     */
    val thinkingSteps: kotlinx.serialization.json.JsonElement? = null,
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
    val webSources: kotlinx.serialization.json.JsonElement? = null,
    /**
     * Facts learned about the user from this exchange (async memory
     * extraction): [{"memoryId","text"}]. null = still pending/unknown;
     * empty array = terminal, nothing learned.
     */
    val learnedFacts: kotlinx.serialization.json.JsonElement? = null,
    /**
     * Files built-in tools produced during the turn (e.g. PDFs from
     * generate_pdf), persisted as attachments on the assistant message. Fetch
     * a download URL via GET /attachments/{attachmentId}/url.
     */
    val generatedAttachments: List<AttachmentRef> = emptyList()
)