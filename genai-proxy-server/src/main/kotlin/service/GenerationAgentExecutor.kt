package com.genflowly.service

import com.genflowly.EmbeddingConstants
import com.genflowly.config.AppConfig
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.CustomerAIProviderConfig
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.toCredentialKey
import com.genflowly.models.toProviderString
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerProfileRepository
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
 * Executes a [ResolvedAgent] (a published request-agent graph) for internal
 * flows (titles, personas, memory extraction) — always through the retrieval
 * server's LangGraph runtime (the single execution path for request agents),
 * and always on the CUSTOMER's stored vendor keys, never the system keys:
 * customers pay for their own activity. The one deliberate exception:
 * ADMIN_PANEL accounts with no keys of their own fall back to the system
 * keys, since admin operations are ours to pay for and the admin panel only
 * manages the system key store.
 *
 * Customer keys run on ONE provider, the customer's primary (their priority-1
 * key, else the key they added first), so the content of a background task
 * never reaches a vendor the customer didn't rank first, and there is no
 * failover to their other keys. The model is the vendor's small default from
 * the request-agent manifest, unless the customer pointed this action at
 * their own agent on that vendor, which keeps its model. Keyless
 * ADMIN_PANEL accounts use the system provider configs instead.
 *
 * Candidates are tried in order; any generation failure — including BLANK
 * output and a parse failure — moves on to the next one, so only the
 * system-key list ever has more than one. Customer-key
 * candidates run durably (DBOS) when the retrieval server has the durable
 * runtime configured; system-key candidates always run plain, because the
 * durable path resolves credentials server-side from the customer's stored
 * keys.
 */
class GenerationAgentExecutor(
    private val customerCredentialsService: CustomerCredentialsService,
    private val requestAgentSeeds: RequestAgentSeeds,
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
            runWithFailover(agent, variables, customerId, agent.requestType.name) { it }
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
     * Generate and [parse] the response text on the customer's primary
     * provider. A parse failure (e.g. unparseable persona or
     * memory-operations JSON) counts as a provider failure. THROWS ([NoCustomerAIKeyException] /
     * [CustomerAIFailoverException]) when no candidate succeeds, so callers
     * can react.
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
    ): T = runWithFailover(agent, variables, customerId, operationName, responseSchema) { parse(it.text) }

    private suspend fun <T> runWithFailover(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        operationName: String,
        responseSchema: kotlinx.serialization.json.JsonObject? = null,
        transform: (AIGenerateResult) -> T
    ): T {
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
                            "(priority ${candidate.priority}, graph=${agent.graphId}, systemKey=${candidate.systemKey})"
                }
                val result = executeGraph(agent, variables, customerId, candidate, responseSchema)
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
     * Runs the agent's graph through the retrieval server's LangGraph runtime
     * — the same engine that serves customer chat — so every node (single
     * GENERATION agents included) actually executes there: one template
     * dialect, node-level thinking control, and DBOS durability all apply.
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
            graphId = agent.graphId,
            customerId = customerId,
            variables = variables,
            llmCredentials = mapOf(candidate.aiVendor.toCredentialKey() to candidate.apiKey),
            llmProvider = candidate.aiVendor.toProviderString(),
            llmModel = candidate.model,
            llmMaxTokens = agent.maxTokens ?: 4096,
            modelType = EmbeddingConstants.MODEL_TYPE,
            modelName = EmbeddingConstants.MODEL_NAME,
            responseSchema = responseSchema,
            requestSource = agent.requestType.name.lowercase(),
            // Durable execution resolves credentials from the customer's
            // stored keys server-side — meaningless for a system key.
            durable = !candidate.systemKey
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

    /** The customer's primary provider; system keys only for keyless ADMIN_PANEL accounts. */
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
        val primary = customerCredentialsService.getPrimaryProvider(customerId) ?: return emptyList()
        // A SYSTEM agent's model preference names a vendor the customer never
        // chose, so only the customer's own agent can pick the model.
        val ownAgentModel = agent.modelPreference
            ?.takeIf { agent.customerOverride && it.aiVendor == primary.aiVendor }
            ?.model
        val model = ownAgentModel
            ?: requestAgentSeeds.vendorDefaultModels[primary.aiVendor]
            ?: primary.chatModel
        if (model == null) {
            logger.warn { "${agent.requestType}: primary vendor ${primary.aiVendor} has no model for customer $customerId" }
            return emptyList()
        }
        return listOf(CustomerAIProviderConfig(primary.aiVendor, model, primary.apiKey, priority = 1))
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
            CustomerAIProviderConfig(it.aiVendor, it.model, it.apiKey, it.priority, systemKey = true)
        }
    }

    private fun emptyResult() = AIGenerateResult(
        text = "", inputTokens = null, outputTokens = null, totalTokens = null, tokensReadFromCache = null
    )
}
