package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.CustomerAIProviderConfig
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.SystemAIProviderConfig
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * The single execution path for request agents: every candidate attempt runs
 * the published graph on the retrieval server. Pinned here:
 *
 *  * candidates are tried in priority order with their own keys
 *  * BLANK graph output counts as a provider failure and advances failover
 *    (the defect that silently killed memory extraction)
 *  * a parse failure advances failover the same way
 *  * customer-key candidates run durable; the admin-panel system-key fallback
 *    runs plain (durable resolves creds from the customer's stored keys)
 *  * derived candidates: the agent's model preference first, then other keyed
 *    vendors on the seeded per-vendor default models
 *  * keyless non-admin customers degrade to empty output, never system keys
 */
class GenerationAgentExecutorTest {

    private val credentials = mockk<CustomerCredentialsService>()
    private val systemKeys = mockk<SystemApiKeyService>()
    private val profiles = mockk<CustomerProfileRepository> {
        coEvery { getCustomerProfileByCustomerId(any()) } returns null
    }
    private val retrievalClient = mockk<com.genflowly.providers.RetrievalServerClient>()
    private val executor =
        GenerationAgentExecutor(credentials, RequestAgentSeeds(), systemKeys, profiles, retrievalClient)

    private fun agent(modelPreference: AIConfig? = AIConfig(AIVendor.OPENAI, "gpt-5")) = ResolvedAgent(
        requestType = RequestType.NOTE_TITLE,
        mapKey = "k",
        graphId = "GRP1",
        outputFormat = AgentOutputFormat.TEXT,
        modelPreference = modelPreference,
        maxTokens = 2000
    )

    private fun graphResult(text: String?) = RetrievalResult(
        text = text, inputTokens = 1, outputTokens = 2, totalTokens = 3, tokensReadFromCache = null
    )

    private val configuredProviders = listOf(
        CustomerAIProviderConfig(AIVendor.OPENAI, "gpt-5", "key-1", 1),
        CustomerAIProviderConfig(AIVendor.CLAUDE, "claude-fable-5", "key-2", 2)
    )

    @Test
    fun `configured providers run the graph in priority order with their own keys`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = "GRP1", customerId = "CU1", variables = any(),
                llmCredentials = mapOf("openai_api_key" to "key-1"),
                llmProvider = "openai", llmModel = "gpt-5", llmMaxTokens = 2000,
                modelType = any(), modelName = any(), responseSchema = any(),
                requestSource = "note_title", durable = true
            )
        } throws IllegalStateException("rate limited")
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = "GRP1", customerId = "CU1", variables = any(),
                llmCredentials = mapOf("anthropic_api_key" to "key-2"),
                llmProvider = "anthropic", llmModel = "claude-fable-5", llmMaxTokens = 2000,
                modelType = any(), modelName = any(), responseSchema = any(),
                requestSource = "note_title", durable = true
            )
        } returns graphResult("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(),
            variables = mapOf("noteContent" to "..."),
            customerId = "CU1",
            conversationId = "note-title-generation"
        )

        assertEquals("A Title", out.text)
    }

    @Test
    fun `blank graph output advances to the next provider instead of counting as success`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            retrievalClient.executeAgentGraph(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns graphResult("") andThen graphResult("recovered")

        val out = executor.executeWithCustomerFailover(
            agent = agent(),
            variables = emptyMap(),
            customerId = "CU1",
            conversationId = "conv",
            operationName = "test-op"
        ) { it }

        assertEquals("recovered", out)
        coVerify(exactly = 2) {
            retrievalClient.executeAgentGraph(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        }
    }

    @Test
    fun `parse failure counts as provider failure and advances to the next provider`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            retrievalClient.executeAgentGraph(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns graphResult("bad") andThen graphResult("good")

        val out = executor.executeWithCustomerFailover(
            agent = agent(),
            variables = emptyMap(),
            customerId = "CU1",
            conversationId = "conv",
            operationName = "test-op"
        ) { text -> if (text == "bad") throw IllegalStateException("unparseable") else text }

        assertEquals("good", out)
    }

    @Test
    fun `all providers failing throws CustomerAIFailoverException with the reasons`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            retrievalClient.executeAgentGraph(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
            )
        } returns graphResult(null)

        val e = assertFailsWith<CustomerAIFailoverException> {
            executor.executeWithCustomerFailover(
                agent = agent(), variables = emptyMap(), customerId = "CU1",
                conversationId = "conv", operationName = "test-op"
            ) { it }
        }
        assertEquals(2, e.failures.size)
    }

    @Test
    fun `without configs the agent's preference leads and other keyed vendors use seeded defaults`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns mapOf(
            AIVendor.OPENAI to "key-o", AIVendor.CLAUDE to "key-c"
        )
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = any(), customerId = any(), variables = any(),
                llmCredentials = any(), llmProvider = "openai", llmModel = "gpt-5",
                llmMaxTokens = any(), modelType = any(), modelName = any(),
                responseSchema = any(), requestSource = any(), durable = any()
            )
        } throws IllegalStateException("down")
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = any(), customerId = any(), variables = any(),
                llmCredentials = any(), llmProvider = "anthropic", llmModel = "claude-haiku-4-5",
                llmMaxTokens = any(), modelType = any(), modelName = any(),
                responseSchema = any(), requestSource = any(), durable = any()
            )
        } returns graphResult("ok")

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        // CLAUDE fell back to the manifest's vendor default model
        assertEquals("ok", out.text)
    }

    @Test
    fun `keyless non-admin customers degrade to empty output, never system keys`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns emptyMap()

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("", out.text)
        coVerify(exactly = 0) { systemKeys.getPrioritizedProviderConfigs() }
    }

    @Test
    fun `admin-panel accounts fall back to system keys and run NON-durable`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("ADM1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("ADM1") } returns emptyMap()
        coEvery { profiles.getCustomerProfileByCustomerId("ADM1") } returns mapOf(
            "client" to AttributeValue.builder().s(com.genflowly.config.AppConfig.CLIENT_ADMIN_PANEL).build()
        )
        coEvery { systemKeys.getPrioritizedProviderConfigs() } returns listOf(
            SystemAIProviderConfig(AIVendor.OPENAI, "gpt-5", "sys-key", 1)
        )
        coEvery {
            retrievalClient.executeAgentGraph(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), durable = false
            )
        } returns graphResult("system ok")

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "ADM1", conversationId = "conv"
        )

        assertEquals("system ok", out.text)
        coVerify {
            retrievalClient.executeAgentGraph(
                any(), any(), any(), llmCredentials = mapOf("openai_api_key" to "sys-key"),
                any(), any(), any(), any(), any(), any(), any(), durable = false
            )
        }
    }
}
