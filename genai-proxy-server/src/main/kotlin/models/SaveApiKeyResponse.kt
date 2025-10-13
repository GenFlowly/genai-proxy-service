package models

import kotlinx.serialization.Serializable

@Serializable
data class SaveApiKeyResponse(
    val status: String
)