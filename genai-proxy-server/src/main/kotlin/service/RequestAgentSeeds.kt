package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.RequestType
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
private data class RequestAgentSeedManifest(
    val defaults: List<RequestAgentSeedEntry>,
    val vendorDefaultModels: Map<String, String> = emptyMap()
)

@Serializable
private data class RequestAgentSeedEntry(
    val requestType: String,
    val mapKey: String,
    val outputFormat: AgentOutputFormat,
    val modelPreference: AIConfig? = null,
    val maxTokens: Int? = null,
    /** Reasoning effort pinned on the seeded node ("none"|"low"|"medium"|"high"), or null for vendor default. */
    val thinkingLevel: String? = null,
    val systemPromptResource: String,
    val userMessageResource: String
)

/** Everything needed to publish one request type's initial System agent. */
data class RequestAgentSeed(
    val requestType: RequestType,
    val mapKey: String,
    val outputFormat: AgentOutputFormat,
    val modelPreference: AIConfig?,
    val maxTokens: Int?,
    val thinkingLevel: String?,
    val systemPrompt: String,
    val userMessageTemplate: String,
)

/**
 * Loads the bundled SEED manifest from
 * resources/config/request-agent-defaults.json. This is bootstrap data, not a
 * runtime fallback: [RequestAgentSeeder] publishes each entry as a System
 * instruction + graph + RequestAgentMap row ONCE, for request types a fresh
 * environment has no entry for — after that, DynamoDB (edited via the admin
 * panel) is the only source of truth and this manifest is never consulted for
 * a live request.
 *
 * [vendorDefaultModels] is the one piece read at runtime: the fallback model
 * per vendor for failover candidates when a customer has a valid key for a
 * vendor but never selected a model — it parameterizes failover, never agent
 * behavior.
 *
 * Fails fast (throws) on a missing/incomplete manifest or prompt resource so a
 * broken bundle breaks startup, not the first seeding attempt.
 */
class RequestAgentSeeds {

    private val json = Json { ignoreUnknownKeys = true }

    val seeds: Map<RequestType, RequestAgentSeed> by lazy { load() }

    /**
     * Fallback model per vendor for internal generations, used when a customer
     * has a valid key for a vendor but never selected a model for it. Fails
     * fast at startup when a known vendor is missing from the manifest.
     */
    val vendorDefaultModels: Map<com.genflowly.models.AIVendor, String> by lazy { loadVendorDefaults() }

    fun loadVendorDefaults(): Map<com.genflowly.models.AIVendor, String> {
        val manifest = json.decodeFromString<RequestAgentSeedManifest>(readResource(MANIFEST_RESOURCE))
        val parsed = manifest.vendorDefaultModels.mapKeys { (vendorName, _) ->
            try {
                com.genflowly.models.AIVendor.valueOf(vendorName)
            } catch (e: IllegalArgumentException) {
                throw IllegalStateException("Unknown vendor '$vendorName' in vendorDefaultModels of $MANIFEST_RESOURCE", e)
            }
        }
        val missing = com.genflowly.models.AIVendor.entries.filter { it !in parsed }
        check(missing.isEmpty()) {
            "$MANIFEST_RESOURCE vendorDefaultModels is missing vendors: $missing"
        }
        return parsed
    }

    fun load(): Map<RequestType, RequestAgentSeed> {
        val manifestText = readResource(MANIFEST_RESOURCE)
        val manifest = json.decodeFromString<RequestAgentSeedManifest>(manifestText)

        val loaded = manifest.defaults.associate { entry ->
            val requestType = try {
                RequestType.valueOf(entry.requestType)
            } catch (e: IllegalArgumentException) {
                throw IllegalStateException(
                    "Unknown requestType '${entry.requestType}' in $MANIFEST_RESOURCE", e
                )
            }
            requestType to RequestAgentSeed(
                requestType = requestType,
                mapKey = entry.mapKey,
                outputFormat = entry.outputFormat,
                modelPreference = entry.modelPreference,
                maxTokens = entry.maxTokens,
                thinkingLevel = entry.thinkingLevel,
                systemPrompt = readResource(entry.systemPromptResource).removeSuffix("\n"),
                userMessageTemplate = readResource(entry.userMessageResource).removeSuffix("\n"),
            )
        }

        val missing = RequestType.entries.filter { it !in loaded }
        check(missing.isEmpty()) {
            "$MANIFEST_RESOURCE is missing seed agents for request types: $missing"
        }
        return loaded
    }

    private fun readResource(path: String): String =
        checkNotNull(javaClass.classLoader.getResourceAsStream(path)) {
            "Bundled resource '$path' not found on the classpath"
        }.bufferedReader(Charsets.UTF_8).use { it.readText() }

    companion object {
        private const val MANIFEST_RESOURCE = "config/request-agent-defaults.json"
    }
}
