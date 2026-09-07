package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.CustomerAIProviderConfig
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.ResolvedAgentSource
import com.genflowly.models.SystemAIProviderConfig
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class GenerationAgentExecutorTest {

    private val utility = mockk<UtilityGenerationService>()
    private val credentials = mockk<CustomerCredentialsService>()
    private val systemKeys = mockk<SystemApiKeyService>()
    private val profiles = mockk<CustomerProfileRepository> {
        coEvery { getCustomerProfileByCustomerId(any()) } returns null
    }
    private val retrievalClient = mockk<com.genflowly.providers.RetrievalServerClient>(relaxed = true)
    private val executor =
        GenerationAgentExecutor(utility, credentials, RequestAgentDefaultsLoader(), systemKeys, profiles, retrievalClient)

    private fun profileWithClient(client: String): Map<String, AttributeValue> =
        mapOf("client" to AttributeValue.builder().s(client).build())

    private fun agent(
        systemPrompt: String = "System {{a}}",
        userMessage: String = "User {{b}}",
        modelPreference: AIConfig? = AIConfig(AIVendor.OPENAI, "gpt-5")
    ) = ResolvedAgent(
        requestType = RequestType.NOTE_TITLE,
        source = ResolvedAgentSource.CONFIG,
        mapKey = "k",
        systemPromptTemplate = systemPrompt,
        userMessageTemplate = userMessage,
        outputFormat = AgentOutputFormat.TEXT,
        modelPreference = modelPreference
    )

    private fun result(text: String) =
        AIGenerateResult(text = text, inputTokens = null, outputTokens = null, totalTokens = null, tokensReadFromCache = null)

    private val configuredProviders = listOf(
        CustomerAIProviderConfig(AIVendor.OPENAI, "gpt-5", "key-1", 1),
        CustomerAIProviderConfig(AIVendor.CLAUDE, "claude-fable-5", "key-2", 2)
    )

    @Test
    fun `template error surfaces before any provider attempt`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders

        assertFailsWith<IllegalArgumentException> {
            executor.executeWithCustomerFailover(
                agent = agent(),
                variables = mapOf("a" to "x"), // {{b}} unresolved
                customerId = "CU1",
                conversationId = "conv",
                operationName = "test-op"
            ) { it }
        }
        coVerify(exactly = 0) { utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `parse failure counts as provider failure and advances to the next provider`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any(), any(), any())
        } returns result("bad") andThen result("good")

        val out = executor.executeWithCustomerFailover(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CU1",
            conversationId = "conv",
            operationName = "test-op"
        ) { text ->
            if (text == "bad") throw IllegalStateException("unparseable") else text
        }

        assertEquals("good", out)
        coVerify(exactly = 2) { utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `configured customer providers are used in priority order with their own keys`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(AIVendor.OPENAI, "gpt-5", any(), "System x", "key-1", null, null, "note_title")
        } throws IllegalStateException("rate limited")
        coEvery {
            utility.generateTextWithApiKey(AIVendor.CLAUDE, "claude-fable-5", any(), "System x", "key-2", null, null, "note_title")
        } returns result("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CU1",
            conversationId = "note-title-generation"
        )

        assertEquals("A Title", out.text)
        coVerify {
            utility.generateTextWithApiKey(
                AIVendor.CLAUDE, "claude-fable-5",
                match { it.single().text == "User y" && it.single().conversationId == "note-title-generation" },
                "System x", "key-2", null, null, "note_title"
            )
        }
    }

    @Test
    fun `without configs the agent's preferred vendor is used when the customer has its key`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns mapOf(AIVendor.OPENAI to "key-o")
        coEvery {
            utility.generateTextWithApiKey(AIVendor.OPENAI, "gpt-5", any(), "System x", "key-o", null, null, "note_title")
        } returns result("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CU1",
            conversationId = "conv"
        )

        assertEquals("A Title", out.text)
    }

    @Test
    fun `without configs a customer keyed only for another vendor falls back to it with the bundled default model`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns mapOf(AIVendor.CLAUDE to "key-c")
        // Bundled vendorDefaultModels maps CLAUDE to claude-haiku-4-5
        coEvery {
            utility.generateTextWithApiKey(AIVendor.CLAUDE, "claude-haiku-4-5", any(), "System x", "key-c", null, null, "note_title")
        } returns result("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(), // prefers OPENAI, but the customer has no OPENAI key
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CU1",
            conversationId = "conv"
        )

        assertEquals("A Title", out.text)
    }

    @Test
    fun `no usable key yields empty text from executeWithCustomerKey and throws from the failover variant`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns emptyMap()

        val out = executor.executeWithCustomerKey(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CU1",
            conversationId = "conv"
        )
        assertEquals("", out.text)

        assertFailsWith<NoCustomerAIKeyException> {
            executor.executeWithCustomerFailover(
                agent = agent(),
                variables = mapOf("a" to "x", "b" to "y"),
                customerId = "CU1",
                conversationId = "conv",
                operationName = "test-op"
            ) { it }
        }
        coVerify(exactly = 0) { utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `keyless ADMIN_PANEL account falls back to system provider configs`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CUADMIN") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CUADMIN") } returns emptyMap()
        coEvery { profiles.getCustomerProfileByCustomerId("CUADMIN") } returns profileWithClient("ADMIN_PANEL")
        coEvery { systemKeys.getPrioritizedProviderConfigs() } returns listOf(
            SystemAIProviderConfig(AIVendor.CLAUDE, "claude-fable-5", "sys-key-c", 1),
            SystemAIProviderConfig(AIVendor.OPENAI, "gpt-5", "sys-key-o", 2)
        )
        coEvery {
            utility.generateTextWithApiKey(AIVendor.CLAUDE, "claude-fable-5", any(), "System x", "sys-key-c", null, null, "note_title")
        } returns result("A Persona")

        val out = executor.executeWithCustomerFailover(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CUADMIN",
            conversationId = "conv",
            operationName = "persona-generation"
        ) { it }

        assertEquals("A Persona", out)
    }

    @Test
    fun `ADMIN_PANEL account with its own keys never touches system keys`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CUADMIN") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(AIVendor.OPENAI, "gpt-5", any(), "System x", "key-1", null, null, "note_title")
        } returns result("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CUADMIN",
            conversationId = "conv"
        )

        assertEquals("A Title", out.text)
        coVerify(exactly = 0) { systemKeys.getPrioritizedProviderConfigs() }
    }

    @Test
    fun `keyless non-admin account never gets system keys and still throws`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns emptyMap()
        coEvery { profiles.getCustomerProfileByCustomerId("CU1") } returns profileWithClient("REACT_APP")

        assertFailsWith<NoCustomerAIKeyException> {
            executor.executeWithCustomerFailover(
                agent = agent(),
                variables = mapOf("a" to "x", "b" to "y"),
                customerId = "CU1",
                conversationId = "conv",
                operationName = "test-op"
            ) { it }
        }
        coVerify(exactly = 0) { systemKeys.getPrioritizedProviderConfigs() }
    }

    @Test
    fun `all providers failing throws with per-provider reasons`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any(), any(), any())
        } throws IllegalStateException("boom")

        val e = assertFailsWith<CustomerAIFailoverException> {
            executor.executeWithCustomerFailover(
                agent = agent(),
                variables = mapOf("a" to "x", "b" to "y"),
                customerId = "CU1",
                conversationId = "conv",
                operationName = "test-op"
            ) { it }
        }
        assertEquals(2, e.failures.size)
        assertTrue(e.failures.all { it.contains("boom") })
    }
}
