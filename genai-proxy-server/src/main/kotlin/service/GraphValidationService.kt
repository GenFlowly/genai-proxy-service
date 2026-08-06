package com.genflowly.service

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Stateless validator for LangGraph agent (graph + node) structural invariants.
 *
 * All checks run in-process against the *merged* (post-patch) state and throw
 * [IllegalArgumentException] with a descriptive message on the first violation.
 * The activity layer maps these to HTTP 400 Bad Request.
 *
 * Rules enforced (numbered to match the implementation plan):
 *  1. entryPoint must be in nodeIds.
 *  2. Every edge `from` must be in nodeIds.
 *  3. Every edge `to` must be in nodeIds or "__end__".
 *  4. Every conditional edge `from` must be in nodeIds; every route target must
 *     be in nodeIds or "__end__".
 *  5. condition_key must be a known RetrievalState field.
 *  6. Cycle safety: if conditional_edges is non-empty, at least one node must
 *     be of type RESPONSE_GENERATOR_WITH_REFLECTION.
 *  7. Every nodeId is reachable from the entryPoint.
 *  8. maxIterations in [1, 100].
 *  9. Node config must be valid JSON when provided.
 * 10. name must be non-blank when provided.
 * 11. isDefault=false guard when there is only one graph.
 */
object GraphValidationService {

    /** RetrievalState fields that are legal condition_key values in conditional edges. */
    private val VALID_CONDITION_KEYS = setOf(
        "needs_rewrite",
        "needs_more_context",
        "retrieval_results",    // used with condition_type=list_empty
        "error",
    )

    private val jsonParser = Json { ignoreUnknownKeys = true }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Validate a proposed agent update.
     *
     * @param nodeIds          The current (unchanged) nodeIds of the graph.
     * @param nodeTypeById     Map of nodeId → nodeType for all nodes in the graph.
     * @param entryPoint       The merged entryPoint (after applying the patch).
     * @param edgesJson        The merged edges JSON string (after applying the patch).
     * @param maxIterations    The merged maxIterations value.
     * @param name             The merged name (null if unchanged, validated only if non-null).
     * @param isDefault        Whether the agent is being set as default.
     * @param isOnlyGraph      True when the customer has exactly one graph.
     * @param nodePatchConfigs Map of nodeId → proposed config JSON (only patched nodes).
     */
    fun validateAgentUpdate(
        nodeIds: List<String>,
        nodeTypeById: Map<String, String>,
        entryPoint: String,
        edgesJson: String,
        maxIterations: Int,
        name: String?,
        isDefault: Boolean?,
        isOnlyGraph: Boolean,
        nodePatchConfigs: Map<String, String>,
    ) {
        val nodeIdSet = nodeIds.toSet()

        validateName(name)
        validateMaxIterations(maxIterations)
        validateIsDefault(isDefault, isOnlyGraph)
        validateNodeConfigs(nodePatchConfigs)

        // Parse the edges blob once — all structural checks use it.
        val edgesObj = parseEdgesJson(edgesJson)

        validateEntryPoint(entryPoint, nodeIdSet)
        validateEdges(edgesObj, nodeIdSet)
        validateConditionalEdges(edgesObj, nodeIdSet)
        validateCycleSafety(edgesObj, nodeTypeById)
        validateReachability(entryPoint, nodeIdSet, edgesObj)
    }

    // ── Individual rule implementations ──────────────────────────────────────

    /** Rule 10: name must be non-blank when provided. */
    private fun validateName(name: String?) {
        if (name != null) {
            require(name.isNotBlank()) { "Agent name must not be blank." }
        }
    }

    /** Rule 8: maxIterations must be in [1, 100]. */
    private fun validateMaxIterations(maxIterations: Int) {
        require(maxIterations in 1..100) {
            "maxIterations must be between 1 and 100 (got $maxIterations)."
        }
    }

    /** Rule 11: cannot unset isDefault when this is the customer's only graph. */
    private fun validateIsDefault(isDefault: Boolean?, isOnlyGraph: Boolean) {
        if (isDefault == false && isOnlyGraph) {
            throw IllegalArgumentException(
                "Cannot set isDefault to false — this is the customer's only graph. " +
                "At least one graph must remain the default."
            )
        }
    }

    /** Rule 9: every patched node config must be valid JSON. */
    private fun validateNodeConfigs(nodePatchConfigs: Map<String, String>) {
        nodePatchConfigs.forEach { (nodeId, config) ->
            try {
                jsonParser.parseToJsonElement(config)
            } catch (e: Exception) {
                throw IllegalArgumentException(
                    "Node '$nodeId' has an invalid config (not valid JSON): ${e.message}"
                )
            }
        }
    }

    /** Rule 1: entryPoint must be a known nodeId. */
    private fun validateEntryPoint(entryPoint: String, nodeIdSet: Set<String>) {
        require(entryPoint in nodeIdSet) {
            "entryPoint '$entryPoint' is not in the graph's nodeIds."
        }
    }

    /** Rules 2–3: standard (non-conditional) edges. */
    private fun validateEdges(edgesObj: JsonObject, nodeIdSet: Set<String>) {
        edgesObj["edges"]?.jsonArray?.forEach { el ->
            val edge = el.jsonObject
            val from = edge["from"]?.jsonPrimitive?.content
                ?: throw IllegalArgumentException("Edge is missing 'from' field.")
            val to = edge["to"]?.jsonPrimitive?.content
                ?: throw IllegalArgumentException("Edge is missing 'to' field.")

            require(from in nodeIdSet) { "Edge 'from' references unknown nodeId '$from'." }
            require(to in nodeIdSet || to == "__end__") {
                "Edge 'to' references unknown nodeId '$to' (use '__end__' to terminate)."
            }
        }
    }

    /** Rules 4–5: conditional edges — structure, targets, and condition_key validity. */
    private fun validateConditionalEdges(edgesObj: JsonObject, nodeIdSet: Set<String>) {
        edgesObj["conditional_edges"]?.jsonArray?.forEach { el ->
            val cond = el.jsonObject

            val from = cond["from"]?.jsonPrimitive?.content
                ?: throw IllegalArgumentException("Conditional edge is missing 'from' field.")
            require(from in nodeIdSet) {
                "Conditional edge 'from' references unknown nodeId '$from'."
            }

            val conditionKey = cond["condition_key"]?.jsonPrimitive?.content
                ?: throw IllegalArgumentException("Conditional edge is missing 'condition_key'.")
            require(conditionKey in VALID_CONDITION_KEYS) {
                "Unknown condition_key '$conditionKey'. " +
                "Valid keys: ${VALID_CONDITION_KEYS.joinToString()}."
            }

            val routes = cond["routes"]?.jsonObject
                ?: throw IllegalArgumentException(
                    "Conditional edge from '$from' is missing 'routes' map."
                )
            routes.values.forEach { routeVal ->
                val target = routeVal.jsonPrimitive.content
                require(target in nodeIdSet || target == "__end__") {
                    "Conditional edge route target '$target' is unknown (use a nodeId or '__end__')."
                }
            }
        }
    }

    /**
     * Rule 6: Cycle safety.
     * If the graph has any conditional edges (which can create cycles), at least
     * one node must be RESPONSE_GENERATOR_WITH_REFLECTION — that is the only node
     * that writes `needs_more_context` (the cycle-exit signal).
     */
    private fun validateCycleSafety(
        edgesObj: JsonObject,
        nodeTypeById: Map<String, String>,
    ) {
        val conditionalEdges = edgesObj["conditional_edges"]?.jsonArray ?: return
        if (conditionalEdges.isEmpty()) return

        val hasReflection = nodeTypeById.values.any {
            it == "RESPONSE_GENERATOR_WITH_REFLECTION"
        }
        require(hasReflection) {
            "A graph with conditional (cyclic) edges must contain a " +
            "RESPONSE_GENERATOR_WITH_REFLECTION node to provide a safe cycle-exit signal."
        }
    }

    /**
     * Rule 7: Every nodeId must be reachable from the entryPoint.
     * Uses a simple BFS over the combined edge set (regular + all conditional routes).
     */
    private fun validateReachability(
        entryPoint: String,
        nodeIdSet: Set<String>,
        edgesObj: JsonObject,
    ) {
        // Build adjacency list: nodeId -> set of reachable nodeIds
        val adjacency = mutableMapOf<String, MutableSet<String>>()

        edgesObj["edges"]?.jsonArray?.forEach { el ->
            val edge = el.jsonObject
            val from = edge["from"]?.jsonPrimitive?.content ?: return@forEach
            val to = edge["to"]?.jsonPrimitive?.content ?: return@forEach
            if (to != "__end__") adjacency.getOrPut(from) { mutableSetOf() }.add(to)
        }

        edgesObj["conditional_edges"]?.jsonArray?.forEach { el ->
            val cond = el.jsonObject
            val from = cond["from"]?.jsonPrimitive?.content ?: return@forEach
            cond["routes"]?.jsonObject?.values?.forEach { routeVal ->
                val target = routeVal.jsonPrimitive.content
                if (target != "__end__") adjacency.getOrPut(from) { mutableSetOf() }.add(target)
            }
        }

        // BFS from entryPoint
        val visited = mutableSetOf<String>()
        val queue = ArrayDeque<String>()
        queue.add(entryPoint)
        while (queue.isNotEmpty()) {
            val current = queue.removeFirst()
            if (visited.add(current)) {
                adjacency[current]?.forEach { neighbour ->
                    if (neighbour !in visited) queue.add(neighbour)
                }
            }
        }

        val unreachable = nodeIdSet - visited
        if (unreachable.isNotEmpty()) {
            throw IllegalArgumentException(
                "The following nodes are unreachable from entryPoint '$entryPoint': " +
                unreachable.joinToString() + ". " +
                "Connect them to the graph or remove them via the graph-node API."
            )
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun parseEdgesJson(edgesJson: String): JsonObject {
        return try {
            jsonParser.parseToJsonElement(edgesJson).jsonObject
        } catch (e: Exception) {
            throw IllegalArgumentException(
                "edges is not valid JSON: ${e.message}"
            )
        }
    }
}
