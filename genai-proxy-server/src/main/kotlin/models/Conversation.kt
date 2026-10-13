package com.genflowly.models

import java.util.UUID

data class Conversation(
    val conversationId: String = UUID.randomUUID().toString(),
    val customerId: String,
    val client: String,
    // Project the conversation is born into (sidebar grouping); assignable
    // later via the assign/unassign-project endpoints
    val projectId: String? = null
)