package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.Message
import com.genflowly.models.ResolvedAgent
import com.genflowly.utils.PromptTemplateRenderer

/**
 * Executes a [ResolvedAgent] (a 1-node generation graph) for internal flows.
 *
 * Which credential store pays — the customer's stored vendor key vs the
 * admin-configured system keys — is deliberately call-site policy, NOT agent
 * data: an admin-editable map must not be able to silently shift customer
 * traffic onto system keys or vice versa. The agent contributes the prompt
 * templates and (for customer-key flows) the vendor/model preference.
 *
 * Both paths render the templates eagerly, before any provider call, so a
 * template error (e.g. unresolved placeholder) surfaces immediately instead of
 * burning one failover attempt per configured system provider.
 */
class GenerationAgentExecutor(
    private val utilityGenerationService: UtilityGenerationService,
    private val systemAIFailoverService: SystemAIFailoverService
) {

    /**
     * Generates with the customer's stored vendor key using the agent's model
     * preference. Failures yield empty text (see [UtilityGenerationService.generateText]),
     * so callers treat blank output as "no result".
     */
    suspend fun executeWithCustomerKey(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        conversationId: String
    ): AIGenerateResult {
        val modelPreference = requireNotNull(agent.modelPreference) {
            "Agent '${agent.mapKey}' (${agent.requestType}) has no model preference; " +
                    "customer-key execution requires one"
        }
        val systemPrompt = PromptTemplateRenderer.render(agent.systemPromptTemplate, variables)
        val userMessage = PromptTemplateRenderer.render(agent.userMessageTemplate, variables)

        return utilityGenerationService.generateText(
            aiVendor = modelPreference.aiVendor,
            model = modelPreference.model,
            messages = listOf(
                buildMessage(conversationId, userMessage, customerId, modelPreference)
            ),
            systemPrompt = systemPrompt,
            customerId = customerId,
            maxTokens = agent.maxTokens
        )
    }

    /**
     * Generates on the system keys with provider failover: vendor/model come
     * from each prioritized system provider config, not the agent. [parse]
     * runs inside the failover block so a malformed response (e.g. unparseable
     * persona JSON) counts as a provider failure and advances to the next one.
     */
    suspend fun <T> executeWithSystemFailover(
        agent: ResolvedAgent,
        variables: Map<String, String>,
        customerId: String,
        conversationId: String,
        operationName: String,
        parse: (String) -> T
    ): T {
        val systemPrompt = PromptTemplateRenderer.render(agent.systemPromptTemplate, variables)
        val userMessage = PromptTemplateRenderer.render(agent.userMessageTemplate, variables)

        return systemAIFailoverService.executeWithFailover(operationName) { config ->
            val responseText = utilityGenerationService.generateTextWithApiKey(
                aiVendor = config.aiVendor,
                model = config.model,
                messages = listOf(
                    buildMessage(
                        conversationId, userMessage, customerId,
                        AIConfig(config.aiVendor, config.model)
                    )
                ),
                systemPrompt = systemPrompt,
                apiKey = config.apiKey,
                maxTokens = agent.maxTokens
            ).text
            parse(responseText)
        }
    }

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
