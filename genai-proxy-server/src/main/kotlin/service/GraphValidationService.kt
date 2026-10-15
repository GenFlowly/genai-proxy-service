package com.genflowly.service

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
 *  5. condition_key must be non-blank (any state field or custom node
 *     output_key is legal — custom keys land in the runtime's scratch
 *     channel). condition_type bool/list_empty needs exactly true+false
 *     routes; "value" needs at least one route.
 *  6. Cycle safety: if the graph contains a directed cycle (over plain and
 *     conditional edges combined), at least one node must be of type
 *     RESPONSE_GENERATOR_WITH_REFLECTION (the cycle-exit signal writer).
 *     Acyclic branching needs no reflection node. Cycles closed only through
 *     tool_route conditional edges are exempt: the tool loop terminates by
 *     construction (no tool calls → "none"/"caller" route), with the graph's
 *     maxIterations recursion limit as backstop.
 *  7. Every nodeId is reachable from the entryPoint.
 *  8. maxIterations in [1, 100].
 *  9. Node config must be valid JSON when provided.
 * 10. name must be non-blank when provided.
 * 11. isDefault=false guard when there is only one graph.
 * 12. A node config's tool_settings.generate_pdf (the PDF letterhead, plan
 *     6.1/6.2) holds only its known keys, each with a valid value.
 */
object GraphValidationService {

    private val BOOLEAN_CONDITION_TYPES = setOf("bool", "list_empty")

    private val jsonParser = Json { ignoreUnknownKeys = true }

    // Rule 12: what retrieval-server's generate_pdf accepts (generate_pdf.py
    // _render_options / pdf_typst.py); anything else would be dropped there.
    private val PDF_PAGE_SIZES = setOf("A4", "Letter", "Legal")
    private val PDF_ACCENT_COLOR = Regex("^#[0-9A-Fa-f]{6}$")
    private val PDF_LOGO_ID = Regex("^[A-Za-z0-9-]{8,64}$")
    private val PDF_TEXT_LIMITS = mapOf("company_name" to 120, "footer_text" to 200)

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

    /** Rule 9: every patched node config must be valid JSON (and pass rule 12). */
    private fun validateNodeConfigs(nodePatchConfigs: Map<String, String>) {
        nodePatchConfigs.forEach { (nodeId, config) ->
            val parsed = try {
                jsonParser.parseToJsonElement(config)
            } catch (e: Exception) {
                throw IllegalArgumentException(
                    "Node '$nodeId' has an invalid config (not valid JSON): ${e.message}"
                )
            }
            validatePdfToolSettings(nodeId, parsed)
        }
    }

    /**
     * Rule 12: tool_settings.generate_pdf, when present, is an object of the
     * letterhead keys only. The logo id names an image under the graph owner's
     * attachments; retrieval-server reads it from that prefix only.
     */
    private fun validatePdfToolSettings(nodeId: String, config: JsonElement) {
        val toolSettings = (config as? JsonObject)?.get("tool_settings") ?: return
        require(toolSettings is JsonObject) { "Node '$nodeId': tool_settings must be an object." }
        val pdf = toolSettings["generate_pdf"] ?: return
        require(pdf is JsonObject) { "Node '$nodeId': tool_settings.generate_pdf must be an object." }
        pdf.forEach { (key, value) ->
            if (value is JsonNull) return@forEach
            val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.content
            val field = "Node '$nodeId': tool_settings.generate_pdf.$key"
            when (key) {
                "default_page_size" -> require(text in PDF_PAGE_SIZES) {
                    "$field must be one of ${PDF_PAGE_SIZES.joinToString()}."
                }
                "accent_color" -> require(text != null && PDF_ACCENT_COLOR.matches(text)) {
                    "$field must be a colour like #1F4E79."
                }
                "logo_attachment_id" -> require(text != null && PDF_LOGO_ID.matches(text)) {
                    "$field must be an attachment id."
                }
                "company_name", "footer_text" -> {
                    val limit = PDF_TEXT_LIMITS.getValue(key)
                    require(text != null && text.length <= limit) {
                        "$field must be text of at most $limit characters."
                    }
                }
                else -> throw IllegalArgumentException(
                    "Node '$nodeId': unknown tool_settings.generate_pdf key '$key' (allowed: " +
                        "default_page_size, company_name, footer_text, accent_color, logo_attachment_id)."
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

            val conditionType = cond["condition_type"]?.jsonPrimitive?.content ?: "bool"
            // tool_route inspects state["tool_calls"], never a condition key —
            // the retrieval-server's router ignores the field entirely, so
            // demanding one here would reject an otherwise valid edge (its
            // runtime learned the same lesson; see _make_condition_router).
            if (conditionType != "tool_route") {
                val conditionKey = cond["condition_key"]?.jsonPrimitive?.content
                    ?: throw IllegalArgumentException("Conditional edge is missing 'condition_key'.")
                require(conditionKey.isNotBlank()) {
                    "Conditional edge from '$from' has a blank condition_key."
                }
            }

            val routes = cond["routes"]?.jsonObject
                ?: throw IllegalArgumentException(
                    "Conditional edge from '$from' is missing 'routes' map."
                )
            if (conditionType in BOOLEAN_CONDITION_TYPES) {
                require(routes.keys == setOf("true", "false")) {
                    "Conditional edge from '$from' ($conditionType) must have exactly " +
                    "'true' and 'false' routes."
                }
            } else {
                require(routes.isNotEmpty()) {
                    "Conditional edge from '$from' needs at least one route."
                }
            }
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
     * Only a graph that actually contains a directed cycle (over plain and
     * conditional edges combined) must carry a RESPONSE_GENERATOR_WITH_REFLECTION
     * node — that is the node that writes `needs_more_context` (the cycle-exit
     * signal). Acyclic branching, multi-way or not, needs no reflection node.
     *
     * tool_route conditional edges are excluded from cycle detection: the
     * agent↔TOOL_EXECUTOR loop they close exits by construction once the model
     * stops emitting built-in tool calls (the "none"/"caller" routes), and the
     * runtime's recursion limit (maxIterations) bounds it regardless.
     */
    private fun validateCycleSafety(
        edgesObj: JsonObject,
        nodeTypeById: Map<String, String>,
    ) {
        if (!hasDirectedCycle(buildAdjacency(edgesObj, includeToolRoutes = false))) return

        val hasReflection = nodeTypeById.values.any {
            it == "RESPONSE_GENERATOR_WITH_REFLECTION"
        }
        require(hasReflection) {
            "This graph contains a cycle, so it must include a " +
            "RESPONSE_GENERATOR_WITH_REFLECTION node to provide a safe cycle-exit signal."
        }
    }

    /**
     * Adjacency over plain + conditional edges, "__end__" targets excluded.
     * With [includeToolRoutes] false, tool_route conditional edges are skipped
     * (cycle detection only — reachability must still traverse them).
     */
    private fun buildAdjacency(
        edgesObj: JsonObject,
        includeToolRoutes: Boolean = true,
    ): Map<String, Set<String>> {
        val adjacency = mutableMapOf<String, MutableSet<String>>()
        edgesObj["edges"]?.jsonArray?.forEach { el ->
            val edge = el.jsonObject
            val from = edge["from"]?.jsonPrimitive?.content ?: return@forEach
            val to = edge["to"]?.jsonPrimitive?.content ?: return@forEach
            if (to != "__end__") adjacency.getOrPut(from) { mutableSetOf() }.add(to)
        }
        edgesObj["conditional_edges"]?.jsonArray?.forEach { el ->
            val cond = el.jsonObject
            val conditionType = cond["condition_type"]?.jsonPrimitive?.content ?: "bool"
            if (!includeToolRoutes && conditionType == "tool_route") return@forEach
            val from = cond["from"]?.jsonPrimitive?.content ?: return@forEach
            cond["routes"]?.jsonObject?.values?.forEach { routeVal ->
                val target = routeVal.jsonPrimitive.content
                if (target != "__end__") adjacency.getOrPut(from) { mutableSetOf() }.add(target)
            }
        }
        return adjacency
    }

    /** Iterative three-color DFS cycle detection. */
    private fun hasDirectedCycle(adjacency: Map<String, Set<String>>): Boolean {
        val visited = mutableSetOf<String>()
        val inStack = mutableSetOf<String>()

        fun dfs(start: String): Boolean {
            val stack = ArrayDeque<Pair<String, Iterator<String>>>()
            stack.addLast(start to (adjacency[start] ?: emptySet()).iterator())
            visited.add(start)
            inStack.add(start)
            while (stack.isNotEmpty()) {
                val (node, neighbours) = stack.last()
                if (neighbours.hasNext()) {
                    val next = neighbours.next()
                    if (next in inStack) return true
                    if (next !in visited) {
                        visited.add(next)
                        inStack.add(next)
                        stack.addLast(next to (adjacency[next] ?: emptySet()).iterator())
                    }
                } else {
                    stack.removeLast()
                    inStack.remove(node)
                }
            }
            return false
        }

        return adjacency.keys.any { it !in visited && dfs(it) }
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
        val adjacency = buildAdjacency(edgesObj)

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
