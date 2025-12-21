package com.genflowly.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import models.AIConfig

@Serializable
data class AIConfigPreferencesRequest(
    val preferredModels: List<AIConfig>? = null,
    val preferredGenerativeMode: AIMode? = null,
    val otherPreferences: Map<String, String>? = null
)

@Serializable
enum class AIMode {
    @SerialName("FACTUAL")
    FACTUAL,
    @SerialName("CREATIVE")
    CREATIVE
}
