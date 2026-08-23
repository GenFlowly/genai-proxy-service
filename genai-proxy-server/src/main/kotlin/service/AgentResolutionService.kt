package com.genflowly.service

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
import com.genflowly.models.ResolvedAgentSource
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import com.genflowly.models.GenerationNodeConfig
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Resolves a [RequestType] to the agent serving it:
 *
 *   RequestAgentMap entry → agent graph → GENERATION entry node → instruction
 *   (system-prompt template) → [ResolvedAgent].
 *
 * When DynamoDB has no usable mapping — no entry, entry disabled, or any part
 * of the referenced chain missing/malformed — resolution falls back to the
 * bundled defaults from [RequestAgentDefaultsLoader] (with a WARN for the
 * malformed cases), so a bad admin edit degrades to the defaults instead of
 * breaking persona/title generation.
 *
 * Resolutions are cached ~60s per (scope, requestType), including the negative
 * "no DDB entry" result. Admin writes call [invalidate] for immediate effect on
 * the instance that served them; on other instances staleness is bounded by
 * the TTL.
 */
class AgentResolutionService(
    private val requestAgentMapRepository: RequestAgentMapRepository,
    private val graphRepository: GraphRepository,
    private val instructionRepository: InstructionRepository,
    private val defaultsLoader: RequestAgentDefaultsLoader
) {

    private data class CacheEntry(val agent: ResolvedAgent?, val fetchedAt: Long)

    private val cache = ConcurrentHashMap<String, CacheEntry>()

    suspend fun resolve(requestType: RequestType, customerId: String? = null): ResolvedAgent {
        // Per-customer overrides are a future addition: they will do a first
        // lookup with scope = customerId before falling through to SYSTEM.
        val scope = SYSTEM_SCOPE
        val cacheKey = "$scope#${requestType.name}"

        cache[cacheKey]?.let { cached ->
            if (System.currentTimeMillis() - cached.fetchedAt < CACHE_TTL_MS) {
                return cached.agent ?: fallback(requestType)
            }
        }

        val resolved = try {
            resolveFromDynamo(scope, requestType)
        } catch (e: Exception) {
            // Transient DDB errors: fall back without caching so a healthy
            // table is used again on the next request.
            logger.warn(e) { "Request-agent resolution failed for $scope/$requestType — using bundled default" }
            return fallback(requestType)
        }

        cache[cacheKey] = CacheEntry(resolved, System.currentTimeMillis())
        return resolved ?: fallback(requestType)
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
                        "is unusable: ${e.message} — using bundled default"
            }
            null
        }
    }

    /**
     * Builds a [ResolvedAgent] from a graph, verifying the whole chain
     * (graph → GENERATION entry node → valid config → existing instruction).
     * Graph ownership is NOT checked here — the admin write path verifies the
     * mapping admin owns the graph before an entry is accepted. Throws
     * [IllegalArgumentException] with the broken link as the message — also
     * used by the admin endpoints to validate a graph before accepting a map
     * entry.
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
        require(nodeItem[NODE_TYPE_KEY]?.s() == GENERATION_NODE_TYPE) {
            "entry node $entryPoint is not a $GENERATION_NODE_TYPE node"
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
            source = ResolvedAgentSource.DDB,
            mapKey = mapKey,
            systemPromptTemplate = instruction.instructions,
            userMessageTemplate = config.inputTemplate,
            outputFormat = if (config.outputFormat.equals("json", ignoreCase = true)) {
                AgentOutputFormat.JSON
            } else {
                AgentOutputFormat.TEXT
            },
            modelPreference = modelPreference,
            maxTokens = config.maxTokens
        )
    }

    private fun fallback(requestType: RequestType): ResolvedAgent =
        defaultsLoader.defaults.getValue(requestType)

    companion object {
        private const val CACHE_TTL_MS = 60_000L
        private val json = Json { ignoreUnknownKeys = true }
    }
}
