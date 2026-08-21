package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * Patch for a single node within an agent edit request.
 * [nodeId] is required to identify the target node.
 * Only [name] and [config] are editable; nodeType is intentionally absent
 * because changing node type rewires the LangGraph runtime function and can
 * silently break state contracts.
 */
@Serializable
data class UpdateAgentNodePatch(
    val nodeId: String,
    val name: String? = null,
    val config: String? = null,
)

/**
 * Request body for PUT /api/v1/agents/{graphId}.
 *
 * All fields are optional (partial / PATCH-style update).
 * Fields absent from the body retain their current DDB values.
 *
 * Structural validation is enforced server-side before any write:
 *  - entryPoint must be present in the existing nodeIds list.
 *  - All edge from/to references must be existing nodeIds or "__end__".
 *  - Cycles require a RESPONSE_GENERATOR_WITH_REFLECTION node.
 *  - maxIterations must be in [1, 100].
 */
@Serializable
data class UpdateAgentRequest(
    /** Rename the agent. Must be non-blank if provided. */
    val name: String? = null,

    /** Toggle the default flag. Cannot set to false if this is the customer's only graph. */
    val isDefault: Boolean? = null,

    /** Recursion cap for cyclic graphs. Must be 1–100 if provided. */
    val maxIterations: Int? = null,

    /** Must be a nodeId that exists in the graph's current nodeIds list. */
    val entryPoint: String? = null,

    /**
     * Full replacement of the edges JSON blob.
     * Expected shape mirrors the retrieval-server schema:
     * {
     *   "edges": [{"from": "<nodeId>", "to": "<nodeId|__end__>"}],
     *   "conditional_edges": [{
     *     "from": "<nodeId>",
     *     "condition_key": "<RetrievalState field>",
     *     "condition_type": "bool|list_empty",
     *     "routes": {"true": "<nodeId|__end__>", "false": "<nodeId|__end__>"}
     *   }]
     * }
     */
    val edges: String? = null,

    /** Per-node patches. Only nodes listed here are updated; others are untouched. */
    val nodes: List<UpdateAgentNodePatch>? = null,
)
