package models

import com.genflowly.aicallerlib.models.AIVendor
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
    /**
     * How long the retrieval server "thought" before response generation began
     * (request receipt → first generated token), in milliseconds. Assistant
     * messages only; null for user messages and pre-feature records.
     */
    val thinkingDurationMs: Long? = null,
    /**
     * ISO-8601 instant stamped by DynamoDBProvider.withTimestamps on write.
     * Read-only: populated when loading from DDB, ignored on create (the
     * provider always stamps its own value).
     */
    val createdAt: String? = null
)