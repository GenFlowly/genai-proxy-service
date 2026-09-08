package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * A single node within an agent graph, fully hydrated from DDB.
 */
@Serializable
data class AgentNodeResponse(
    val nodeId: String,
    val nodeType: String,
    val name: String,
    val config: String,
    /** Display name of the instruction referenced by config.instruction_id, when present and resolvable. */
    val instructionName: String? = null,
)

/**
 * A customer's agent — a graph with its nodes fully hydrated (not just IDs).
 */
@Serializable
data class AgentResponse(
    val graphId: String,
    val name: String,
    val isDefault: Boolean,
    val entryPoint: String,
    val maxIterations: Int,
    val edges: String,
    val nodes: List<AgentNodeResponse>,
    /** Editor canvas layout JSON ({"positions":{...}}); null when never saved from the editor. */
    val layout: String? = null,
    /**
     * True when this is an admin-published System-owned agent, visible to every
     * customer read-only. Editing it forks it into a customer-owned copy (the
     * response carries the new graphId).
     */
    val isSystem: Boolean = false,
    /**
     * Non-null when this graph backs an internal request flow (RequestAgentMap):
     * e.g. CONVERSATION_TITLE, NOTE_TITLE, INSTRUCTION_PERSONA, MEMORY_EXTRACTION.
     * Pickers for conversation agents should exclude these.
     */
    val requestType: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

/**
 * Top-level response for GET /api/v1/agents.
 */
@Serializable
data class GetCustomerAgentsResponse(
    val agents: List<AgentResponse>,
)
