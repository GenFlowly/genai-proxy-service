package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.ResolvedAgentSource
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@Serializable
private data class RequestAgentDefaultsManifest(
    val defaults: List<RequestAgentDefaultEntry>,
    val vendorDefaultModels: Map<String, String> = emptyMap()
)

@Serializable
private data class RequestAgentDefaultEntry(
    val requestType: String,
    val mapKey: String,
    val outputFormat: AgentOutputFormat,
    val modelPreference: AIConfig? = null,
    val maxTokens: Int? = null,
    val systemPromptResource: String,
    val userMessageResource: String
)

/**
 * Loads the bundled default agents for every [RequestType] from
 * resources/config/request-agent-defaults.json. These are the fallback used
 * whenever the RequestAgentMap table yields no usable mapping — which is the
 * normal state until the admin panel seeds DDB entries.
 *
 * Fails fast (throws) on a missing/incomplete manifest or prompt resource so a
 * broken bundle breaks startup, not the first user request.
 */
class RequestAgentDefaultsLoader {

    private val json = Json { ignoreUnknownKeys = true }

    val defaults: Map<RequestType, ResolvedAgent> by lazy { load() }

    /**
     * Fallback model per vendor for internal generations, used when a customer
     * has a valid key for a vendor but never selected a model for it. Fails
     * fast at startup when a known vendor is missing from the manifest.
     */
    val vendorDefaultModels: Map<com.genflowly.models.AIVendor, String> by lazy { loadVendorDefaults() }

    fun loadVendorDefaults(): Map<com.genflowly.models.AIVendor, String> {
        val manifest = json.decodeFromString<RequestAgentDefaultsManifest>(readResource(MANIFEST_RESOURCE))
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

    fun load(): Map<RequestType, ResolvedAgent> {
        val manifestText = readResource(MANIFEST_RESOURCE)
        val manifest = json.decodeFromString<RequestAgentDefaultsManifest>(manifestText)

        val loaded = manifest.defaults.associate { entry ->
            val requestType = try {
                RequestType.valueOf(entry.requestType)
            } catch (e: IllegalArgumentException) {
                throw IllegalStateException(
                    "Unknown requestType '${entry.requestType}' in $MANIFEST_RESOURCE", e
                )
            }
            requestType to ResolvedAgent(
                requestType = requestType,
                source = ResolvedAgentSource.CONFIG,
                mapKey = entry.mapKey,
                systemPromptTemplate = readResource(entry.systemPromptResource).removeSuffix("\n"),
                userMessageTemplate = readResource(entry.userMessageResource).removeSuffix("\n"),
                outputFormat = entry.outputFormat,
                modelPreference = entry.modelPreference,
                maxTokens = entry.maxTokens
            )
        }

        val missing = RequestType.entries.filter { it !in loaded }
        check(missing.isEmpty()) {
            "$MANIFEST_RESOURCE is missing default agents for request types: $missing"
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
