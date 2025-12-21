package com.genflowly.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import models.AIConfig

@Serializable
data class AIConfigPreferencesRequest(
    val preferredModels: AIConfig? = null,
    val preferredGenerativeMode: AIMode = AIMode.FACTUAL,
    val otherPreferences: Map<String, String> = emptyMap()
)

@Serializable
enum class AIMode {
    @SerialName("factual")
    FACTUAL,
    @SerialName("creative")
    CREATIVE
}
