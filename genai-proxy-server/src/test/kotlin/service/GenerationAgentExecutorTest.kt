package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.CustomerAIProviderConfig
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.ResolvedAgentSource
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class GenerationAgentExecutorTest {

    private val utility = mockk<UtilityGenerationService>()
    private val credentials = mockk<CustomerCredentialsService>()
    private val executor = GenerationAgentExecutor(utility, credentials, RequestAgentDefaultsLoader())

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
        coVerify(exactly = 0) { utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `parse failure counts as provider failure and advances to the next provider`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any())
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
        coVerify(exactly = 2) { utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `configured customer providers are used in priority order with their own keys`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(AIVendor.OPENAI, "gpt-5", any(), "System x", "key-1", null)
        } throws IllegalStateException("rate limited")
        coEvery {
            utility.generateTextWithApiKey(AIVendor.CLAUDE, "claude-fable-5", any(), "System x", "key-2", null)
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
                "System x", "key-2", null
            )
        }
    }

    @Test
    fun `without configs the agent's preferred vendor is used when the customer has its key`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns emptyList()
        coEvery { credentials.getUsableVendorKeys("CU1") } returns mapOf(AIVendor.OPENAI to "key-o")
        coEvery {
            utility.generateTextWithApiKey(AIVendor.OPENAI, "gpt-5", any(), "System x", "key-o", null)
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
            utility.generateTextWithApiKey(AIVendor.CLAUDE, "claude-haiku-4-5", any(), "System x", "key-c", null)
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
        coVerify(exactly = 0) { utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `all providers failing throws with per-provider reasons`() = runTest {
        coEvery { credentials.getPrioritizedProviderConfigs("CU1") } returns configuredProviders
        coEvery {
            utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any())
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
