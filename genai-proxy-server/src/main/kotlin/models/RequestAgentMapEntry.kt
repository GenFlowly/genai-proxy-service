package com.genflowly.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** One row of the RequestAgentMap table: (scope, requestType) → agent graph. */
@Serializable
data class RequestAgentMapEntry(
    val scope: String,
    val requestType: String,
    val mapKey: String,
    val graphId: String,
    val enabled: Boolean = true,
    val updatedBy: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@Serializable
enum class AgentOutputFormat { JSON, TEXT }

/**
 * A fully resolved agent for a request type, always a published DynamoDB graph
 * (map entry → graph), executed on the retrieval server's LangGraph runtime —
 * the single execution path for request agents. For single-GENERATION-node
 * agents the node config's generation preferences are surfaced here so the
 * executor can build provider candidates and token caps; prompts/templates
 * live in the graph (instruction + node config) and are rendered graph-side.
 */
data class ResolvedAgent(
    val requestType: RequestType,
    val mapKey: String,
    /** The published graph the retrieval server executes for this action. */
    val graphId: String,
    val outputFormat: AgentOutputFormat = AgentOutputFormat.TEXT,
    val modelPreference: AIConfig? = null,
    val maxTokens: Int? = null,
)

/**
 * Config JSON stored on a GENERATION graph node (snake_case, matching the
 * other node config shapes seeded by GraphService). Parsed with
 * ignoreUnknownKeys, so runtime-only keys the retrieval server reads directly
 * (e.g. thinking_level) pass through without being modeled here.
 */
@Serializable
data class GenerationNodeConfig(
    @SerialName("instruction_id") val instructionId: String,
    // null = follow the instruction's latest version; an int = pinned
    @SerialName("instruction_version") val instructionVersion: Int? = null,
    @SerialName("input_template") val inputTemplate: String = "",
    @SerialName("output_format") val outputFormat: String = "text",
    @SerialName("model_preference") val modelPreference: NodeModelPreference? = null,
    @SerialName("max_tokens") val maxTokens: Int? = null,
    /** Reasoning effort the retrieval server applies to this node's calls. */
    @SerialName("thinking_level") val thinkingLevel: String? = null
)

@Serializable
data class NodeModelPreference(
    val vendor: String,
    val model: String
)
