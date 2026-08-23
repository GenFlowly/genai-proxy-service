package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * Internal generation flows that resolve their agent (graph + system prompt)
 * through the RequestAgentMap instead of hardcoded prompts. New configurable
 * flows (conversation, conversation management, ...) are added here plus an
 * entry in config/request-agent-defaults.json.
 */
@Serializable
enum class RequestType {
    INSTRUCTION_PERSONA,
    CONVERSATION_TITLE,
    NOTE_TITLE
}
