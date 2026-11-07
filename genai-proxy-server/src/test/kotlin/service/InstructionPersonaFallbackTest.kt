package com.genflowly.service

import com.genflowly.models.GeneratedPersona
import com.genflowly.models.Instruction
import com.genflowly.repository.InstructionRepository
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * DP-001: when the AI that names and tags an instruction fails (a retired
 * model, no key), the instruction is still saved, keeping the previous
 * version's metadata.
 */
class InstructionPersonaFallbackTest {

    private val repository = mockk<InstructionRepository>(relaxed = true)
    private val executor = mockk<GenerationAgentExecutor>()
    private val service = InstructionService(
        repository, mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), executor, mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true)
    )
    private val saved = slot<Instruction>()

    private fun generationFails() {
        coEvery {
            executor.executeWithCustomerFailover<GeneratedPersona>(any(), any(), any(), any(), any(), any(), any())
        } throws CustomerAIFailoverException("All 1 customer AI provider(s) failed", listOf("OPENAI/gpt-4: model_not_found"))
        coEvery { repository.saveInstruction(capture(saved)) } returns Unit
    }

    @Test
    fun `a new version is saved with the previous version's metadata`() = runTest {
        generationFails()
        val previous = Instruction(
            id = "INS-1", creator = "CU-1", name = "VC", instructions = "old", version = 2,
            icon = "📊", color = "#6d3be5", tags = listOf("startups"), category = "Analysis"
        )
        coEvery { repository.getLatestInstructionVersion("INS-1") } returns 2
        coEvery { repository.getInstruction("INS-1", 2) } returns previous

        val response = service.createInstructionWithGeneratedPersona("CU-1", null, "new text", "INS-1")

        assertEquals(3, response.version)
        assertEquals("VC", saved.captured.name)
        assertEquals("📊", saved.captured.icon)
        assertEquals("#6d3be5", saved.captured.color)
        assertEquals(listOf("startups"), saved.captured.tags)
        assertEquals("Analysis", saved.captured.category)
        assertEquals("new text", saved.captured.instructions)
    }

    @Test
    fun `a new instruction without a name is named after its first line`() = runTest {
        generationFails()

        val response = service.createInstructionWithGeneratedPersona(
            "CU-1", "", "\n## You are a careful code reviewer\nCheck every diff.", null
        )

        assertEquals(1, response.version)
        assertEquals("You are a careful code reviewer", saved.captured.name)
        assertEquals(null, saved.captured.icon)
    }

    @Test
    fun `a name the user typed is kept`() = runTest {
        generationFails()

        service.createInstructionWithGeneratedPersona("CU-1", "Reviewer", "Check every diff.", null)

        assertEquals("Reviewer", saved.captured.name)
    }
}
