package models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GenerateTextRequest(
    val aiVendors: List<AIVendor>,
    val model: String,
    val prompt: String,
    val customerId: String,
    val selectedResponseId: String?,
    val conversationId: String?,
    val client: String
)