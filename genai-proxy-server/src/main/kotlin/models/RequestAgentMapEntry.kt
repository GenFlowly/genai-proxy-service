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
 * A fully resolved agent for a request type: prompt templates plus generation
 * preferences, ready to be rendered and executed. Built either from DynamoDB
 * (map entry → graph → GENERATION node → instruction) or from the bundled
 * config fallback when no usable DDB mapping exists.
 */
data class ResolvedAgent(
    val requestType: RequestType,
    val source: ResolvedAgentSource,
    val mapKey: String,
    val systemPromptTemplate: String,
    val userMessageTemplate: String,
    val outputFormat: AgentOutputFormat,
    val modelPreference: AIConfig? = null,
    val maxTokens: Int? = null
)

enum class ResolvedAgentSource { DDB, CONFIG }

/**
 * Config JSON stored on a GENERATION graph node (snake_case, matching the
 * other node config shapes seeded by GraphService).
 */
@Serializable
data class GenerationNodeConfig(
    @SerialName("instruction_id") val instructionId: String,
    // null = follow the instruction's latest version; an int = pinned
    @SerialName("instruction_version") val instructionVersion: Int? = null,
    @SerialName("input_template") val inputTemplate: String = "",
    @SerialName("output_format") val outputFormat: String = "text",
    @SerialName("model_preference") val modelPreference: NodeModelPreference? = null,
    @SerialName("max_tokens") val maxTokens: Int? = null
)

@Serializable
data class NodeModelPreference(
    val vendor: String,
    val model: String
)
