package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * Request body for POST /api/v1/agents/graph — creates a multi-node agent
 * graph authored in the visual editor.
 *
 * Nodes are identified by client-chosen tempIds ("new-1", ...); [entryPoint],
 * [edges], and [layout] reference those tempIds. The server generates real
 * nodeIds, substitutes them everywhere, and validates the full structure
 * before writing anything.
 */
@Serializable
data class CreateGraphAgentRequest(
    val name: String,
    val maxIterations: Int = 10,
    /** tempId of the entry node. */
    val entryPoint: String,
    /** Edges JSON (same shape as [UpdateAgentRequest.edges]) referencing tempIds. */
    val edges: String,
    /** Editor canvas layout JSON referencing tempIds; optional. */
    val layout: String? = null,
    val isDefault: Boolean = false,
    /** [com.genflowly.models.AgentCategory] name; null (older clients) defaults to CONVERSATION. */
    val category: String? = null,
    val nodes: List<NewAgentNode>,
)
