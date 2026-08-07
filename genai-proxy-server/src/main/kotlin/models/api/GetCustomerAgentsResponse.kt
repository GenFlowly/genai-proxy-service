package models.api

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
