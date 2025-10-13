package models

import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextResponse(
    val text: String?
)