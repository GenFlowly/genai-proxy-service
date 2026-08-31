package com.genflowly.models.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import com.genflowly.models.AIConfig

@Serializable
data class PreferencesRequest(
    val aiConfigPreferences: AIConfigPreferences? = null,
    val otherPreferences: Map<String, String>? = null
)

@Serializable
data class AIConfigPreferences(
    val preferredModels: List<AIConfig>? = null,
    val preferredGenerativeMode: AIMode? = null,
    // Embedding delivery for notes: "realtime" (synchronous /encode-notes) or
    // "batch" (swept from CustomerNotes into a Voyage batch job). Defaults to
    // realtime when unset. embeddingModel names the batch model (e.g. voyage-4-large).
    val embeddingMode: String? = null,
    val embeddingModel: String? = null,
    // Fallback instruction when a request selects none:
    // instructionFallbackMode = "preferred" -> use preferredInstructionId;
    // "lastUsed" -> use the customer's most-recently-used instruction.
    // Either way, resolution ultimately falls back to the SYSTEM default.
    val preferredInstructionId: String? = null,
    val instructionFallbackMode: String? = null,
)

@Serializable
enum class AIMode {
    @SerialName("FACTUAL")
    FACTUAL,
    @SerialName("CREATIVE")
    CREATIVE
}
