package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.PrimaryAIProvider
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.SystemAIProviderConfig
import com.genflowly.models.retrieval.RetrievalResult
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.MockKMatcherScope
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
 *  * customer keys run on ONE provider, the primary, with its own key and the
 *    vendor's small default model: background content never reaches a
 *    vendor the customer didn't rank first, whatever the agent prefers
 *  * no failover to the customer's other keys: a failure, BLANK output (the
 *    defect that silently killed memory extraction) or a parse failure ends
 *    the attempt
 *  * the customer's own agent keeps its model on the primary vendor
 *  * customer-key candidates run durable; the admin-panel system-key fallback
 *    runs plain (durable resolves creds from the customer's stored keys)
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

    private fun agent(
        modelPreference: AIConfig? = AIConfig(AIVendor.OPENAI, "gpt-5"),
        customerOverride: Boolean = false
    ) = ResolvedAgent(
        requestType = RequestType.NOTE_TITLE,
        mapKey = "k",
        graphId = "GRP1",
        outputFormat = AgentOutputFormat.TEXT,
        modelPreference = modelPreference,
        maxTokens = 2000,
        customerOverride = customerOverride
    )

    private fun graphResult(text: String?) = RetrievalResult(
        text = text, inputTokens = 1, outputTokens = 2, totalTokens = 3, tokensReadFromCache = null
    )

    private fun primary(vendor: AIVendor, key: String = "key-p", chatModel: String? = "chat-model") {
        coEvery { credentials.getPrimaryProvider("CU1") } returns PrimaryAIProvider(vendor, key, chatModel)
    }

    private suspend fun MockKMatcherScope.graphCalls() = retrievalClient.executeAgentGraph(
        any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any()
    )

    @Test
    fun `runs on the primary provider's small model with its own key, whatever the agent prefers`() = runTest {
        primary(AIVendor.CLAUDE, key = "key-c", chatModel = "claude-opus-4-1")
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = "GRP1", customerId = "CU1", variables = any(),
                llmCredentials = mapOf("anthropic_api_key" to "key-c"),
                llmProvider = "anthropic", llmModel = "claude-haiku-4-5", llmMaxTokens = 2000,
                modelType = any(), modelName = any(), responseSchema = any(),
                requestSource = "note_title", durable = true
            )
        } returns graphResult("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(AIConfig(AIVendor.OPENAI, "gpt-5")),
            variables = mapOf("noteContent" to "..."),
            customerId = "CU1",
            conversationId = "note-title-generation"
        )

        assertEquals("A Title", out.text)
        coVerify(exactly = 1) { graphCalls() }
    }

    @Test
    fun `a failing primary is not retried on another vendor`() = runTest {
        primary(AIVendor.CLAUDE)
        coEvery { graphCalls() } throws IllegalStateException("rate limited")

        val e = assertFailsWith<CustomerAIFailoverException> {
            executor.executeWithCustomerFailover(
                agent = agent(), variables = emptyMap(), customerId = "CU1",
                conversationId = "conv", operationName = "test-op"
            ) { it }
        }

        assertEquals(1, e.failures.size)
        coVerify(exactly = 1) { graphCalls() }
    }

    @Test
    fun `blank output counts as a failure and degrades to empty text`() = runTest {
        primary(AIVendor.OPENAI)
        coEvery { graphCalls() } returns graphResult("")

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("", out.text)
        coVerify(exactly = 1) { graphCalls() }
    }

    @Test
    fun `a parse failure counts as a provider failure`() = runTest {
        primary(AIVendor.OPENAI)
        coEvery { graphCalls() } returns graphResult("bad")

        assertFailsWith<CustomerAIFailoverException> {
            executor.executeWithCustomerFailover(
                agent = agent(), variables = emptyMap(), customerId = "CU1",
                conversationId = "conv", operationName = "test-op"
            ) { text -> if (text == "bad") throw IllegalStateException("unparseable") else text }
        }
    }

    @Test
    fun `the customer's own agent keeps its model on the primary vendor`() = runTest {
        primary(AIVendor.CLAUDE)
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = any(), customerId = any(), variables = any(), llmCredentials = any(),
                llmProvider = "anthropic", llmModel = "claude-sonnet-4-5", llmMaxTokens = any(),
                modelType = any(), modelName = any(), responseSchema = any(),
                requestSource = any(), durable = any()
            )
        } returns graphResult("ok")

        val out = executor.executeWithCustomerKey(
            agent = agent(AIConfig(AIVendor.CLAUDE, "claude-sonnet-4-5"), customerOverride = true),
            variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("ok", out.text)
    }

    @Test
    fun `the customer's own agent on another vendor still runs on the primary`() = runTest {
        primary(AIVendor.CLAUDE)
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = any(), customerId = any(), variables = any(), llmCredentials = any(),
                llmProvider = "anthropic", llmModel = "claude-haiku-4-5", llmMaxTokens = any(),
                modelType = any(), modelName = any(), responseSchema = any(),
                requestSource = any(), durable = any()
            )
        } returns graphResult("ok")

        val out = executor.executeWithCustomerKey(
            agent = agent(AIConfig(AIVendor.OPENAI, "gpt-5"), customerOverride = true),
            variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("ok", out.text)
    }

    @Test
    fun `a vendor without a small default runs on the customer's chat model`() = runTest {
        primary(AIVendor.of("groq"), chatModel = "llama-3.3-70b-versatile")
        coEvery {
            retrievalClient.executeAgentGraph(
                graphId = any(), customerId = any(), variables = any(),
                llmCredentials = mapOf("groq_api_key" to "key-p"),
                llmProvider = "groq", llmModel = "llama-3.3-70b-versatile", llmMaxTokens = any(),
                modelType = any(), modelName = any(), responseSchema = any(),
                requestSource = any(), durable = any()
            )
        } returns graphResult("ok")

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("ok", out.text)
    }

    @Test
    fun `a primary with no known model degrades to empty output`() = runTest {
        primary(AIVendor.of("groq"), chatModel = null)

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("", out.text)
        coVerify(exactly = 0) { graphCalls() }
    }

    @Test
    fun `keyless non-admin customers degrade to empty output, never system keys`() = runTest {
        coEvery { credentials.getPrimaryProvider("CU1") } returns null

        val out = executor.executeWithCustomerKey(
            agent = agent(), variables = emptyMap(), customerId = "CU1", conversationId = "conv"
        )

        assertEquals("", out.text)
        coVerify(exactly = 0) { systemKeys.getPrioritizedProviderConfigs() }
    }

    @Test
    fun `admin-panel accounts fall back to system keys and run NON-durable`() = runTest {
        coEvery { credentials.getPrimaryProvider("ADM1") } returns null
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
