package com.genflowly.service

import com.genflowly.models.Instruction
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.SearchNotConfiguredException
import com.genflowly.providers.SearchSetupReason
import com.genflowly.providers.SearchVectorHit
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Instruction search: a failed vector search is passed on instead of answering
 * with no instructions (L2-001); latest versions not yet in the vector index
 * are keyword-matched and listed first; a blank query never searches.
 */
class InstructionSearchErrorTest {

    private val retrievalServerClient = mockk<RetrievalServerClient>()
    private val instructionRepository = mockk<InstructionRepository>()
    private val shareRepository = mockk<ShareRepository>()
    private var entitlements = ALL_ENTITLEMENTS

    private val service = InstructionService(
        instructionRepository, shareRepository, mockk(relaxed = true), mockk(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), retrievalServerClient,
        mockk(relaxed = true),
        CustomerEntitlementService(
            mockk { coEvery { getEntitlements(any()) } answers { entitlements } }, mockk(), mockk()
        ), mockk(relaxed = true), ContentFilter(emptyList())
    )

    private fun instruction(id: String, version: Int, name: String, text: String, synced: Boolean) = Instruction(
        id = id, creator = "CU-1", name = name, instructions = text, version = version, syncedWithVectorDb = synced
    )

    private fun owned(vararg instructions: Instruction) {
        coEvery { instructionRepository.getInstructionsByCreator("CU-1") } returns instructions.toList()
        coEvery { shareRepository.getSharedEntityIdsForCustomer(any(), "INS-") } returns emptyList()
    }

    private fun vectorHits(vararg ids: String) {
        coEvery { retrievalServerClient.search(any(), any(), any(), any(), any()) } returns ids.map {
            SearchVectorHit(type = "instructions", key = it, title = "", score = 0.5, snippet = "", matchedChunks = 1, createdAt = "")
        }
    }

    @Test
    fun `a search that couldn't run is passed on`() = runTest {
        owned(instruction("INS-1", 1, "Tax advisor", "taxes", synced = true))
        coEvery { retrievalServerClient.search(any(), any(), any(), any(), any()) } throws
            SearchNotConfiguredException(SearchSetupReason.VECTOR_DB, "No vector DB")

        val error = assertThrows<SearchNotConfiguredException> { service.searchInstructions("CU-1", "tests") }
        assertEquals(SearchSetupReason.VECTOR_DB, error.reason)
    }

    @Test
    fun `a customer without an embedding key is told before anything is searched`() = runTest {
        owned(instruction("INS-1", 1, "Tax advisor", "taxes", synced = false))
        entitlements = ALL_ENTITLEMENTS.copy(isEmbeddingCreationEnabled = false)

        val error = assertThrows<SearchNotConfiguredException> { service.searchInstructions("CU-1", "taxes") }

        assertEquals(SearchSetupReason.EMBEDDING_KEY, error.reason)
        coVerify(exactly = 0) { retrievalServerClient.search(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a blank query lists every instruction without searching`() = runTest {
        owned(instruction("INS-1", 1, "Tax advisor", "taxes", synced = true))

        assertEquals(listOf("INS-1"), service.searchInstructions("CU-1", "  ").instructions.map { it.id })
        coVerify(exactly = 0) { retrievalServerClient.search(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a latest version not yet indexed is found by keyword, ahead of vector hits`() = runTest {
        owned(
            instruction("INS-new", 2, "Immigration helper", "Explains H1B visa rules", synced = false),
            instruction("INS-new", 1, "Old draft", "unrelated", synced = true),
            instruction("INS-old", 1, "Visa expert", "visa", synced = true),
            instruction("INS-other", 1, "H1B planner", "visa timelines", synced = false)
        )
        vectorHits("INS-old")

        val ids = service.searchInstructions("CU-1", "h1b visa").instructions.map { it.id }

        assertEquals(listOf("INS-new", "INS-other", "INS-old"), ids)
    }

    @Test
    fun `an indexed version is never keyword-matched`() = runTest {
        owned(instruction("INS-1", 1, "Visa expert", "h1b visa", synced = true))
        vectorHits()

        assertEquals(emptyList<String>(), service.searchInstructions("CU-1", "h1b visa").instructions.map { it.id })
    }
}
