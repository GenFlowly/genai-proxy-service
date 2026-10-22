package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.AIGenerateResult
import com.genflowly.models.Conversation
import com.genflowly.models.ShareRole
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame

/**
 * Title generation dedup: the orchestrator's server-side kickoff and the
 * clients' POST /conversation/title must share one generation per
 * conversation via the in-flight registry, and the POST must prefer
 * in-flight > stored > fresh generation.
 *
 * runBlocking (not runTest): generations run on a real AppScope (Dispatchers.IO),
 * and runTest's virtual clock would fire the endpoint's 45s await-timeout
 * before the IO coroutine gets a chance to complete.
 */
class ConversationTitleGenerationTest {

    private val conv = "conv-1"
    private val cust = "cust-1"
    private val prompt = "How do I bake bread?"

    private val conversationService = mockk<ConversationService>()
    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val executor = mockk<GenerationAgentExecutor>()
    private val service = ConversationManagementService(
        conversationService, conversationRepo, mockk<ShareRepository>(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        mockk<AgentResolutionService> { coEvery { resolve(any(), any()) } returns mockk(relaxed = true) },
        executor,
        AppScope()
    )

    private fun stubOwnerAccess() {
        coEvery { conversationService.getConversationRole(conv, cust) } returns ShareRole.OWNER
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conv, cust, "REACT_APP")
    }

    private fun stubGeneration(text: String = "\"Baking Bread\"") {
        coEvery { executor.executeWithCustomerKey(any(), any(), any(), any()) } returns
            AIGenerateResult(text, null, null, null, null)
    }

    /** Gate the executor so a generation stays in-flight until the test releases it. */
    private fun gateGeneration(gate: CompletableDeferred<Unit>, text: String = "\"Baking Bread\"") {
        coEvery { executor.executeWithCustomerKey(any(), any(), any(), any()) } coAnswers {
            gate.await()
            AIGenerateResult(text, null, null, null, null)
        }
    }

    @Test
    fun `launch generates, stores and returns the title`() = runBlocking {
        stubOwnerAccess()
        stubGeneration()

        val title = service.launchTitleGenerationAsync(conv, cust, prompt, "Coach").await()

        assertEquals("Baking Bread", title)
        coVerify(exactly = 1) { conversationRepo.updateConversationTitle(conv, cust, "Baking Bread") }
    }

    @Test
    fun `concurrent launches for one conversation generate exactly once`() = runBlocking {
        stubOwnerAccess()
        val gate = CompletableDeferred<Unit>()
        gateGeneration(gate)

        val first = service.launchTitleGenerationAsync(conv, cust, prompt)
        val second = service.launchTitleGenerationAsync(conv, cust, prompt)
        assertSame(first, second)

        gate.complete(Unit)
        assertEquals("Baking Bread", first.await())
        coVerify(exactly = 1) { executor.executeWithCustomerKey(any(), any(), any(), any()) }
    }

    @Test
    fun `registry entry is removed after completion`() = runBlocking {
        stubOwnerAccess()
        stubGeneration()

        service.launchTitleGenerationAsync(conv, cust, prompt).await()
        service.launchTitleGenerationAsync(conv, cust, prompt).await()

        coVerify(exactly = 2) { executor.executeWithCustomerKey(any(), any(), any(), any()) }
    }

    @Test
    fun `createConversationTitle awaits an in-flight generation instead of regenerating`() = runBlocking {
        stubOwnerAccess()
        val gate = CompletableDeferred<Unit>()
        gateGeneration(gate)

        service.launchTitleGenerationAsync(conv, cust, prompt)
        val pending = async { service.createConversationTitle(conv, cust, prompt) }
        delay(50) // let the endpoint call reach the in-flight await
        gate.complete(Unit)

        assertEquals("Baking Bread", pending.await())
        coVerify(exactly = 1) { executor.executeWithCustomerKey(any(), any(), any(), any()) }
    }

    @Test
    fun `createConversationTitle returns the stored title without generating`() = runBlocking {
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conv, cust, "REACT_APP")
        coEvery { conversationRepo.getConversationTitle(conv, cust) } returns "Existing Title"

        assertEquals("Existing Title", service.createConversationTitle(conv, cust, prompt))
        coVerify(exactly = 0) { executor.executeWithCustomerKey(any(), any(), any(), any()) }
    }

    @Test
    fun `createConversationTitle falls back to generation when nothing stored or in-flight`() = runBlocking {
        stubOwnerAccess()
        coEvery { conversationRepo.getConversationTitle(conv, cust) } returns null
        stubGeneration()

        assertEquals("Baking Bread", service.createConversationTitle(conv, cust, prompt))
        coVerify(exactly = 1) { executor.executeWithCustomerKey(any(), any(), any(), any()) }
        coVerify(exactly = 1) { conversationRepo.updateConversationTitle(conv, cust, "Baking Bread") }
    }

    @Test
    fun `generation failure returns null and clears the registry`() = runBlocking {
        stubOwnerAccess()
        coEvery { executor.executeWithCustomerKey(any(), any(), any(), any()) } throws RuntimeException("vendor down")

        assertNull(service.launchTitleGenerationAsync(conv, cust, prompt).await())

        // registry cleared: a fresh launch invokes the executor again
        stubGeneration()
        assertEquals("Baking Bread", service.launchTitleGenerationAsync(conv, cust, prompt).await())
        coVerify(exactly = 2) { executor.executeWithCustomerKey(any(), any(), any(), any()) }
    }
}
