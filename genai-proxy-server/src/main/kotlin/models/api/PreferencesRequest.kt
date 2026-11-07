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
    val embeddingModel: String? = null,
    // Per-category default embedding models. Resolution order at each consumer:
    // category-specific -> legacy embeddingModel -> platform default.
    val embeddingModelConversations: String? = null,
    val embeddingModelNotes: String? = null,
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
