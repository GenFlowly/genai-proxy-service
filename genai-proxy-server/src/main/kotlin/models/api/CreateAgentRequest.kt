package com.genflowly.models.api

import com.genflowly.models.AIConfig
import kotlinx.serialization.Serializable

/**
 * Creates a 1-node GENERATION agent: a graph owned by the caller whose single
 * node references the instruction holding the system-prompt template.
 */
@Serializable
data class CreateAgentRequest(
    val name: String,
    val instructionId: String,
    // null = follow the instruction's latest version; an int = pinned
    val instructionVersion: Int? = null,
    val outputFormat: String = "text",
    val modelPreference: AIConfig? = null,
    val inputTemplate: String = "",
    val maxTokens: Int? = null
)
