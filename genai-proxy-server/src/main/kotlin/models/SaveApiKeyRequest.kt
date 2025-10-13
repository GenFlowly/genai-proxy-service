package models

import kotlinx.serialization.Serializable

@Serializable
data class SaveApiKeyRequest(
    val vendor: String,
    val apiKey: String
)