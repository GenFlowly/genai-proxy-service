package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * Coarse grouping of agents by what they power, stored on the graph's live
 * row and surfaced on every AgentResponse. Pickers filter on it: the chat
 * sidebar only offers CONVERSATION agents, the Agents page groups its
 * sidebar sections by it.
 *
 * Customers choose a category when creating/editing their own agents
 * (default CONVERSATION); forks inherit the source agent's category; the
 * seeder stamps request-type agents via [categoryForRequestType].
 */
@Serializable
enum class AgentCategory {
    CONVERSATION,
    MEMORY,
    TITLE_CREATOR,
    INSTRUCTIONS;

    companion object {
        /** Parses a client-supplied category. @throws IllegalArgumentException with a 400-friendly message. */
        fun parse(value: String): AgentCategory =
            entries.find { it.name == value }
                ?: throw IllegalArgumentException(
                    "category must be one of ${entries.joinToString("|") { it.name }}"
                )

        /**
         * The category implied by the request type a graph is mapped to, used
         * both by the seeder and as a read-time fallback for graphs created
         * before categories existed (so an un-backfilled memory agent never
         * leaks into the conversation picker).
         */
        fun categoryForRequestType(requestTypeName: String): AgentCategory? = when (requestTypeName) {
            RequestType.CONVERSATION_TITLE.name, RequestType.NOTE_TITLE.name -> TITLE_CREATOR
            RequestType.MEMORY_EXTRACTION.name -> MEMORY
            RequestType.INSTRUCTION_PERSONA.name -> INSTRUCTIONS
            else -> null
        }
    }
}
