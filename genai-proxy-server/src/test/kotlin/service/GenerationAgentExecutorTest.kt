package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgent
import com.genflowly.models.ResolvedAgentSource
import com.genflowly.models.SystemAIProviderConfig
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class GenerationAgentExecutorTest {

    private val utility = mockk<UtilityGenerationService>()
    private val systemApiKeyService = mockk<SystemApiKeyService>()
    private val executor = GenerationAgentExecutor(utility, SystemAIFailoverService(systemApiKeyService))

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

    private val providers = listOf(
        SystemAIProviderConfig(AIVendor.OPENAI, "gpt-5", "key-1", 1),
        SystemAIProviderConfig(AIVendor.CLAUDE, "claude-fable-5", "key-2", 2)
    )

    @Test
    fun `template error surfaces before any provider attempt`() = runTest {
        coEvery { systemApiKeyService.getPrioritizedProviderConfigs() } returns providers

        assertFailsWith<IllegalArgumentException> {
            executor.executeWithSystemFailover(
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
        coEvery { systemApiKeyService.getPrioritizedProviderConfigs() } returns providers
        coEvery {
            utility.generateTextWithApiKey(any(), any(), any(), any(), any(), any())
        } returns result("bad") andThen result("good")

        val out = executor.executeWithSystemFailover(
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
    fun `customer-key execution renders templates and uses the agent model preference`() = runTest {
        coEvery {
            utility.generateText(AIVendor.OPENAI, "gpt-5", any(), "System x", "CU1", null)
        } returns result("A Title")

        val out = executor.executeWithCustomerKey(
            agent = agent(),
            variables = mapOf("a" to "x", "b" to "y"),
            customerId = "CU1",
            conversationId = "note-title-generation"
        )

        assertEquals("A Title", out.text)
        coVerify {
            utility.generateText(
                AIVendor.OPENAI, "gpt-5",
                match { it.single().text == "User y" && it.single().conversationId == "note-title-generation" },
                "System x", "CU1", null
            )
        }
    }

    @Test
    fun `customer-key execution requires a model preference`() = runTest {
        assertFailsWith<IllegalArgumentException> {
            executor.executeWithCustomerKey(
                agent = agent(modelPreference = null),
                variables = mapOf("a" to "x", "b" to "y"),
                customerId = "CU1",
                conversationId = "conv"
            )
        }
    }
}
