package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.GRAPH_ENTRY_POINT_KEY
import com.genflowly.DynamoDBConstants.NODE_CONFIG_KEY
import com.genflowly.DynamoDBConstants.NODE_TYPE_KEY
import com.genflowly.GENERATION_NODE_TYPE
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.GenerationNodeConfig
import com.genflowly.observability.Metrics
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Thrown when no enabled published agent serves a request type — the admin
 * disabled the mapping, or a fresh environment's seeding failed. Internal
 * actions fail loudly on this instead of silently running hidden defaults:
 * the published agent in DynamoDB is the ONE source of truth.
 */
class RequestAgentUnresolvedException(requestType: RequestType) :
    RuntimeException(
        "No enabled agent is published for ${requestType.name} — " +
                "publish or re-enable one in the admin panel (Request Agents)"
    )

/**
 * Resolves a [RequestType] to the published agent serving it:
 *
 *   RequestAgentMap entry → agent graph → [ResolvedAgent] (always executed on
 *   the retrieval server's LangGraph runtime).
 *
 * Resolution order: the customer's own override (written when they point an
 * action at their agent in Settings) → the global SYSTEM mapping. There is NO
 * code-shipped runtime fallback: when neither scope has a usable (enabled,
 * well-formed) entry, resolution throws [RequestAgentUnresolvedException] and
 * counts `request_agent_unresolved_total`. Fresh environments get their
 * SYSTEM entries from [RequestAgentSeeder] at startup; afterwards the admin
 * panel is the only authority.
 *
 * Resolutions are cached ~60s per (scope, requestType), including the negative
 * "no DDB entry" result. Admin writes call [invalidate] for immediate effect on
 * the instance that served them; on other instances staleness is bounded by
 * the TTL.
 */
class AgentResolutionService(
    private val requestAgentMapRepository: RequestAgentMapRepository,
    private val graphRepository: GraphRepository,
    private val instructionRepository: InstructionRepository
) {

    private data class CacheEntry(val agent: ResolvedAgent?, val fetchedAt: Long)

    private val cache = ConcurrentHashMap<String, CacheEntry>()

    suspend fun resolve(requestType: RequestType, customerId: String? = null): ResolvedAgent {
        // Per-customer override first (written when a customer forks a System
        // request agent), then the global SYSTEM mapping.
        if (customerId != null) {
            resolveScoped(customerId, requestType)?.let { return it }
        }
        resolveScoped(SYSTEM_SCOPE, requestType)?.let { return it }

        Metrics.count("request_agent_unresolved_total", 1.0, "requestType" to requestType.name)
        logger.error { "Request type ${requestType.name} has no enabled published agent — action disabled" }
        throw RequestAgentUnresolvedException(requestType)
    }

    /**
     * Cached resolution for one scope; null when the scope has no usable
     * (enabled, well-formed) entry. Negative results are cached too; transient
     * DDB errors return null WITHOUT caching so a healthy table is retried.
     */
    private suspend fun resolveScoped(scope: String, requestType: RequestType): ResolvedAgent? {
        val cacheKey = "$scope#${requestType.name}"

        cache[cacheKey]?.let { cached ->
            if (System.currentTimeMillis() - cached.fetchedAt < CACHE_TTL_MS) {
                return cached.agent
            }
        }

        val resolved = try {
            resolveFromDynamo(scope, requestType)
        } catch (e: Exception) {
            logger.warn(e) { "Request-agent resolution failed for $scope/$requestType" }
            return null
        }

        cache[cacheKey] = CacheEntry(resolved, System.currentTimeMillis())
        return resolved
    }

    /** Drops cached resolutions; called by admin write endpoints. */
    fun invalidate(requestType: RequestType? = null) {
        if (requestType == null) {
            cache.clear()
        } else {
            cache.keys.removeIf { it.endsWith("#${requestType.name}") }
        }
    }

    /**
     * Builds the agent from DDB, or null when there is no (enabled) map entry.
     * Malformed data anywhere along the chain also returns null, with a WARN
     * naming the broken link.
     */
    private suspend fun resolveFromDynamo(scope: String, requestType: RequestType): ResolvedAgent? {
        val entry = requestAgentMapRepository.getMapEntry(scope, requestType.name) ?: return null
        if (!entry.enabled) return null

        return try {
            buildAgentFromGraph(entry.graphId, requestType, entry.mapKey)
        } catch (e: IllegalArgumentException) {
            logger.warn {
                "Request-agent map entry '${entry.mapKey}' ($scope/$requestType → graph ${entry.graphId}) " +
                        "is unusable: ${e.message}"
            }
            null
        }
    }

    /**
     * Builds a [ResolvedAgent] from a graph. EVERY agent executes through the
     * retrieval server's LangGraph runtime — one engine, one template dialect,
     * one blank-output check, one durability story. A single-GENERATION-node
     * graph additionally has its whole chain verified here (entry node → valid
     * config → existing instruction) and its generation preferences
     * (model_preference / max_tokens) surfaced so the executor can build
     * provider candidates. Graph ownership is NOT checked here — the admin and
     * customer write paths verify it before a map entry is accepted. Throws
     * [IllegalArgumentException] with the broken link as the message — also
     * used by the mapping endpoints to validate a graph before accepting a
     * map entry.
     */
    suspend fun buildAgentFromGraph(
        graphId: String,
        requestType: RequestType,
        mapKey: String
    ): ResolvedAgent {
        val graphItem = graphRepository.getCustomerGraph(graphId)
        requireNotNull(graphItem) { "graph $graphId not found" }

        val entryPoint = graphItem[GRAPH_ENTRY_POINT_KEY]?.s()?.takeIf { it.isNotBlank() }
        requireNotNull(entryPoint) { "graph $graphId has no entry point" }
        val nodeItem = graphRepository.getCustomerGraphNode(entryPoint)
        requireNotNull(nodeItem) { "entry node $entryPoint not found" }

        val nodeCount = graphItem[DynamoDBConstants.GRAPH_NODE_IDS_KEY]?.l()?.size ?: 1
        if (nodeCount > 1 || nodeItem[NODE_TYPE_KEY]?.s() != GENERATION_NODE_TYPE) {
            // Multi-node (or non-GENERATION-entry) agent: no single node to
            // lift preferences from — candidates derive from the customer's
            // configured providers / keyed vendors.
            return ResolvedAgent(
                requestType = requestType,
                mapKey = mapKey,
                graphId = graphId,
            )
        }

        val config = try {
            json.decodeFromString<GenerationNodeConfig>(nodeItem[NODE_CONFIG_KEY]?.s() ?: "{}")
        } catch (e: Exception) {
            throw IllegalArgumentException(
                "entry node config is not valid $GENERATION_NODE_TYPE config JSON: ${e.message}", e
            )
        }

        val version = config.instructionVersion
            ?: instructionRepository.getLatestInstructionVersion(config.instructionId)
        requireNotNull(version) { "instruction ${config.instructionId} not found" }
        val instruction = instructionRepository.getInstruction(config.instructionId, version)
        requireNotNull(instruction) { "instruction ${config.instructionId} v$version not found" }

        val modelPreference = config.modelPreference?.let { pref ->
            val vendor = try {
                AIVendor.valueOf(pref.vendor)
            } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("unknown model_preference vendor '${pref.vendor}'", e)
            }
            AIConfig(vendor, pref.model)
        }

        return ResolvedAgent(
            requestType = requestType,
            mapKey = mapKey,
            graphId = graphId,
            outputFormat = if (config.outputFormat.equals("json", ignoreCase = true)) {
                AgentOutputFormat.JSON
            } else {
                AgentOutputFormat.TEXT
            },
            modelPreference = modelPreference,
            maxTokens = config.maxTokens
        )
    }

    companion object {
        private const val CACHE_TTL_MS = 60_000L
        private val json = Json { ignoreUnknownKeys = true }
    }
}
