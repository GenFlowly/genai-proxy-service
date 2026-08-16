package models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextRequest(
    val aiConfig: List<AIConfig>,
    val prompt: Prompt,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String,
    // false → direct LLM generation: skip the agent graph (no retrieval/RAG)
    val agentic: Boolean = true,
    /** Caller-defined tools the model may call; works across all vendors */
    val tools: List<ToolDefinition> = emptyList(),
    /** "auto" (default), "required", or a specific tool name */
    val toolChoice: String? = null,
    /** Results for the previous assistant message's tool calls — continues the turn */
    val toolResults: List<ToolResult> = emptyList()
)

/**
 * Tool the model may call. Two flavors:
 * - Function tool (type=null): `parameters` is a JSON Schema object; works on all vendors.
 * - Native Anthropic tool (type set, e.g. "computer_20250124"): passed through untranslated
 *   with `options` (e.g. display_width_px/display_height_px) merged in. Claude only.
 */
@Serializable
data class ToolDefinition(
    val name: String,
    val description: String = "",
    val parameters: kotlinx.serialization.json.JsonObject? = null,
    val type: String? = null,
    val options: kotlinx.serialization.json.JsonObject? = null
)

/** Caller-executed result of a tool call from a previous assistant message. */
@Serializable
data class ToolResult(
    val toolCallId: String,
    val content: String,
    /** Images in the result (e.g. computer-use screenshots). Claude only. */
    val images: List<ToolResultImage> = emptyList()
)

/**
 * Image in a tool result. Provide either base64 [data] directly, or an [s3Key]
 * of an object uploaded via POST /attachments.
 */
@Serializable
data class ToolResultImage(
    val data: String? = null,
    val s3Key: String? = null,
    val mediaType: String = "image/png"
)

@Serializable
data class AIConfig(
    val aiVendor: AIVendor,
    val model: String,
    val maxTokens: Int? = null
)


@Serializable
data class Prompt(
    val instructionId: String,
    val instructionVersion: String,
    val prompt: String,
    val attachments: List<AttachmentRef> = emptyList(),
)