package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.config.AppConfig
import com.genflowly.models.AIConfig
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.CustomerAIProviderConfig
import com.genflowly.models.Message
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.toCredentialKey
import com.genflowly.models.toProviderString
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.utils.PromptTemplateRenderer
import kotlinx.coroutines.CancellationException
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/** Thrown when the customer has no valid AI vendor API key at all. */
class NoCustomerAIKeyException(message: String) : RuntimeException(message)

/**
 * Thrown when every candidate customer provider failed for an operation.
 * [failures] holds one "VENDOR/model: reason" entry per attempted provider.
 */
class CustomerAIFailoverException(
    message: String,
    val failures: List<String>
) : RuntimeException(message)

/**
 * Executes a [ResolvedAgent] (a 1-node generation graph) for internal flows
 * (titles, personas, memory extraction) — always on the CUSTOMER's stored
 * vendor keys, never the system keys: customers pay for their own activity.
 * The one deliberate exception: ADMIN_PANEL accounts with no keys of their
 * own fall back to the system keys, since admin operations are ours to pay
 * for and the admin panel only manages the system key store.
 *
 * Provider candidates, in order:
 *  1. The customer's own prioritized (vendor, model, priority) configs from
 *     their settings, when any are set.
 *  2. Otherwise, derived from whichever vendors they have a valid key for:
 *     the agent's preferred vendor first (with the agent's model), then the
 *     remaining keyed vendors with the bundled per-vendor default model — so
 *     a customer who only has, say, a CLAUDE key still gets titles even when
 *     the agent prefers OPENAI.
 *  3. For keyless ADMIN_PANEL accounts only: the system provider configs.
 *
 * Candidates are tried in order; any generation (or parse) failure moves on
 * to the next one. Templates render eagerly, before any provider call, so a
 * template error surfaces immediately instead of burning failover attempts.
 */
class GenerationAgentExecutor(
    private val utilityGenerationService: UtilityGenerationService,
    private val customerCredentialsService: CustomerCredentialsService,
    private val defaultsLoader: RequestAgentDefaultsLoader,
    private val systemApiKeyService: SystemApiKeyService,
    private val customerProfileRepository: CustomerProfileRepository,
    private val retrievalServerClient: RetrievalServerClient
) {

    /**
     * Generate and give back the raw result, degrading gracefully: failures
     * yield empty text (never an error message as text), so callers treat
     * blank output as "no result". Each failure mode is logged distinctly —
     * no-key vs all-providers-failed — never silently.
     */
    suspend fun executeWithCustomerKey(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        conversationId: String
    ): AIGenerateResult {
        return try {
            runWithFailover(agent, variables, customerId, conversationId, agent.requestType.name) { it }
        } catch (e: NoCustomerAIKeyException) {
            logger.warn { "${agent.requestType}: skipped for customer $customerId — ${e.message}" }
            emptyResult()
        } catch (e: CustomerAIFailoverException) {
            logger.warn { "${agent.requestType}: all providers failed for customer $customerId — ${e.failures}" }
            emptyResult()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.warn(e) { "${agent.requestType}: generation failed for customer $customerId" }
            emptyResult()
        }
    }

    /**
     * Generate and [parse] the response text, with provider failover on the
     * customer's keys. A parse failure (e.g. unparseable persona JSON) counts
     * as a provider failure and advances to the next candidate. THROWS
     * ([NoCustomerAIKeyException] / [CustomerAIFailoverException]) when no
     * candidate succeeds, so callers can react.
     */
    suspend fun <T> executeWithCustomerFailover(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        conversationId: String,
        operationName: String,
        /** JSON Schema for vendor-enforced structured output — makes [parse] failures near-impossible */
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        parse: (String) -> T
    ): T = runWithFailover(agent, variables, customerId, conversationId, operationName, responseSchema) { parse(it.text) }

    private suspend fun <T> runWithFailover(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        conversationId: String,
        operationName: String,
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        transform: (AIGenerateResult) -> T
    ): T {
        val systemPrompt = PromptTemplateRenderer.render(agent.systemPromptTemplate, variables)
        val userMessage = PromptTemplateRenderer.render(agent.userMessageTemplate, variables)

        val candidates = buildCandidates(agent, customerId)
        if (candidates.isEmpty()) {
            throw NoCustomerAIKeyException(
                "no valid AI vendor API key stored (operation: $operationName)"
            )
        }

        val failures = mutableListOf<String>()
        for (candidate in candidates) {
            try {
                logger.info {
                    "[$operationName] Trying customer provider ${candidate.aiVendor}/${candidate.model} " +
                            "(priority ${candidate.priority}, graph=${agent.executeAsGraph})"
                }
                val result = if (agent.executeAsGraph && agent.graphId != null) {
                    executeGraph(agent, variables, customerId, candidate, responseSchema)
                } else {
                    utilityGenerationService.generateTextWithApiKey(
                        aiVendor = candidate.aiVendor,
                        model = candidate.model,
                        messages = listOf(
                            buildMessage(
                                conversationId, userMessage, customerId,
                                AIConfig(candidate.aiVendor, candidate.model)
                            )
                        ),
                        systemPrompt = systemPrompt,
                        apiKey = candidate.apiKey,
                        maxTokens = agent.maxTokens,
                        responseSchema = responseSchema,
                        requestSource = agent.requestType.name.lowercase()
                    )
                }
                return transform(result)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logger.warn(e) {
                    "[$operationName] Customer provider ${candidate.aiVendor}/${candidate.model} failed — trying next"
                }
                failures.add("${candidate.aiVendor}/${candidate.model}: ${e.message}")
            }
        }

        throw CustomerAIFailoverException(
            "All ${candidates.size} customer AI provider(s) failed for $operationName: " +
                    failures.joinToString("; "),
            failures = failures
        )
    }

    /**
     * Multi-node request agents run through the retrieval server's LangGraph
     * runtime — the same engine that serves customer chat — so every node the
     * user added (retrieval, ranking, extra generations) actually executes.
     * A blank response counts as a provider failure and advances failover.
     */
    private suspend fun executeGraph(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        candidate: CustomerAIProviderConfig,
        responseSchema: kotlinx.serialization.json.JsonObject?
    ): AIGenerateResult {
        val result = retrievalServerClient.executeAgentGraph(
            graphId = requireNotNull(agent.graphId),
            customerId = customerId,
            variables = variables,
            llmCredentials = mapOf(candidate.aiVendor.toCredentialKey() to candidate.apiKey),
            llmProvider = candidate.aiVendor.toProviderString(),
            llmModel = candidate.model,
            llmMaxTokens = agent.maxTokens ?: 4096,
            modelType = EmbeddingConstants.MODEL_TYPE,
            modelName = EmbeddingConstants.MODEL_NAME,
            responseSchema = responseSchema,
            requestSource = agent.requestType.name.lowercase()
        )
        val text = result.text
        check(!text.isNullOrBlank()) {
            "agent graph ${agent.graphId} produced no response"
        }
        return AIGenerateResult(
            text = text,
            inputTokens = result.inputTokens,
            outputTokens = result.outputTokens,
            totalTokens = result.totalTokens,
            tokensReadFromCache = result.tokensReadFromCache
        )
    }

    /**
     * Explicit customer configs win outright; the derived fallback only
     * applies when the customer configured nothing, so their settings fully
     * control which vendors/models internal generations use (and pay for).
     */
    private suspend fun buildCandidates(
        agent: ResolvedAgent,
        customerId: String
    ): List<CustomerAIProviderConfig> {
        val ownCandidates = buildOwnKeyCandidates(agent, customerId)
        if (ownCandidates.isNotEmpty()) return ownCandidates
        return systemCandidatesForAdminPanelAccount(customerId)
    }

    private suspend fun buildOwnKeyCandidates(
        agent: ResolvedAgent,
        customerId: String
    ): List<CustomerAIProviderConfig> {
        val configured = customerCredentialsService.getPrioritizedProviderConfigs(customerId)
        if (configured.isNotEmpty()) return configured

        val usableKeys = customerCredentialsService.getUsableVendorKeys(customerId)
        if (usableKeys.isEmpty()) return emptyList()

        val preference = agent.modelPreference
            ?: defaultsLoader.defaults[agent.requestType]?.modelPreference

        return buildList {
            val preferredKey = preference?.let { usableKeys[it.aiVendor] }
            if (preference != null && preferredKey != null) {
                add(CustomerAIProviderConfig(preference.aiVendor, preference.model, preferredKey, priority = 1))
            }
            usableKeys
                .filterKeys { it != preference?.aiVendor }
                .forEach { (vendor, key) ->
                    val model = defaultsLoader.vendorDefaultModels[vendor] ?: return@forEach
                    add(CustomerAIProviderConfig(vendor, model, key, priority = size + 1))
                }
        }
    }

    /**
     * System-key fallback, restricted to ADMIN_PANEL accounts: the admin
     * panel manages the system key store rather than per-customer keys, and
     * its internal generations are ours to pay for. Any other account gets
     * an empty list — customers never silently run on system keys.
     */
    private suspend fun systemCandidatesForAdminPanelAccount(
        customerId: String
    ): List<CustomerAIProviderConfig> {
        val client = customerProfileRepository.getCustomerProfileByCustomerId(customerId)
            ?.get("client")?.s()
        if (client != AppConfig.CLIENT_ADMIN_PANEL) return emptyList()

        val systemConfigs = systemApiKeyService.getPrioritizedProviderConfigs()
        if (systemConfigs.isNotEmpty()) {
            logger.info {
                "Admin-panel account $customerId has no own AI keys — " +
                        "falling back to ${systemConfigs.size} system provider config(s)"
            }
        }
        return systemConfigs.map {
            CustomerAIProviderConfig(it.aiVendor, it.model, it.apiKey, it.priority)
        }
    }

    private fun emptyResult() = AIGenerateResult(
        text = "", inputTokens = null, outputTokens = null, totalTokens = null, tokensReadFromCache = null
    )

    private fun buildMessage(
        conversationId: String,
        text: String,
        customerId: String,
        aiConfig: AIConfig
    ) = Message(
        conversationId = conversationId,
        text = text,
        client = "internal",
        role = "user",
        customerId = customerId,
        systemPrompt = "",
        aiConfig = listOf(aiConfig),
        previousMessageId = null
    )
}
