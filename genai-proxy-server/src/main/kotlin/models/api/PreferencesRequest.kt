package com.genflowly.models.api

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
    // Embedding delivery for notes: "realtime" (synchronous /encode-notes) or
    // "batch" (swept from CustomerNotes into a Voyage batch job). Defaults to
    // realtime when unset. embeddingModel names the batch model (e.g. voyage-4-large).
    val embeddingMode: String? = null,
    // One embedding model for all of the customer's data, chosen once and then
    // locked (a different model on a later save is refused with 409). Saving
    // writes it to all three attributes; the per-category fields are still
    // accepted from older clients as the same single choice.
    val embeddingModel: String? = null,
    val embeddingModelConversations: String? = null,
    val embeddingModelNotes: String? = null,
    // Read-only: when the embedding model was first chosen (ISO-8601). Null
    // for a model chosen before locking existed. Ignored on save.
    val embeddingModelChosenAt: String? = null,
    // Preferred conversation agent (graphId). Empty string clears the
    // preference (revert to the server-side default agent); null leaves it
    // unchanged.
    val preferredAgentId: String? = null,
    // Memory switches (Settings > Defaults > Learned facts). Null = never set,
    // which means on; null on a save leaves the stored value unchanged.
    val memoryLearnFromChats: Boolean? = null,
    val memoryLearnFromNotes: Boolean? = null,
    val memoryUseInReplies: Boolean? = null,
    // Index chats for search (Settings > Defaults > Search index). Null =
    // never set, which means off; null on a save leaves the stored value
    // unchanged.
    val indexChats: Boolean? = null,
)
