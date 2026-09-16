package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * Registry of internal generation flows ("default actions") that resolve
 * their agent (graph + system prompt) through the RequestAgentMap instead of
 * hardcoded prompts. New configurable flows are added here plus an entry in
 * config/request-agent-defaults.json — the admin panel renders this registry
 * (label + template variables) straight from the map-status API, so a new
 * value shows up there automatically.
 */
@Serializable
enum class RequestType(
    /** Human-readable action name shown in the admin panel. */
    val displayName: String,
    /** Template variables the server supplies to this action's prompts. */
    val templateVariables: List<String>,
) {
    INSTRUCTION_PERSONA(
        "Instruction Persona Creation",
        listOf("{{categoryJson}}", "{{instructionText}}")
    ),
    CONVERSATION_TITLE(
        "Conversation Title Generation",
        listOf("{{instructionName}}", "{{prompt}}")
    ),
    NOTE_TITLE(
        "Note Title Generation",
        listOf("{{noteContent}}")
    ),
    MEMORY_EXTRACTION(
        "Learn about User",
        listOf("{{existingMemories}}", "{{sourceType}}", "{{content}}")
    )
}
