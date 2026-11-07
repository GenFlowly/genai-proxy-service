package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** The caller's own use of an instruction. */
@Serializable
data class InstructionUsageResponse(
    /** Conversations that used it, deleted ones included. */
    val usageCount: Int,
    /** When it was last used in a new conversation. */
    val lastUsedAt: String? = null,
    /** The conversations that still exist, newest first; ones without a time last. */
    val conversations: List<InstructionUsageConversation>,
    /** Conversations past the listing limit, not looked up; deleted ones may be among them. */
    val omitted: Int = 0
)

@Serializable
data class InstructionUsageConversation(
    val conversationId: String,
    val title: String? = null,
    /** When the instruction was first used in it. Null on uses from before 2026-11-06. */
    val firstUsedAt: String? = null
)
