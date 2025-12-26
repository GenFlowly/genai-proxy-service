package com.genflowly.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import models.AIConfig

@Serializable
data class PreferencesRequest(
    val aiConfigPreferences: AIConfigPreferences? = null,
    val otherPreferences: Map<String, String>? = null
)

@Serializable
data class AIConfigPreferences(
    val preferredModels: List<AIConfig>? = null,
    val preferredGenerativeMode: AIMode? = null,
)

@Serializable
enum class AIMode {
    @SerialName("FACTUAL")
    FACTUAL,
    @SerialName("CREATIVE")
    CREATIVE
}
