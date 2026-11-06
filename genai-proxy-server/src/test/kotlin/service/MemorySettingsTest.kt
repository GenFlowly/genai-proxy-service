package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemorySourceType
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.StoredMemoryPreferences
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The memory switches in Settings > Defaults > Learned facts: on until the
 * customer turns one off, all off under the legacy master switch, and all off
 * when they can't be read, because memory runs only with confirmed consent.
 */
class MemorySettingsTest {

    private val memoryRepo = mockk<MemoryRepository>()
    private val profiles = mockk<CustomerProfileRepository>()
    private val retrieval = mockk<RetrievalServerClient>()
    private val purge = mockk<com.genflowly.repository.PurgeRepository>(relaxed = true)
    private val service = MemoryService(
        memoryRepo, profiles,
        MemoryVectorService(memoryRepo, profiles, retrieval, mockk(relaxed = true)),
        purge, mockk(), mockk(), AppScope()
    )

    private fun stored(prefs: StoredMemoryPreferences) {
        coEvery { profiles.getMemoryPreferences("CU1") } returns prefs
    }

    @Test
    fun `every switch is on when the customer never set one`() = runTest {
        stored(StoredMemoryPreferences())

        assertEquals(MemorySettings(true, true, true), service.getMemorySettings("CU1"))
    }

    @Test
    fun `each switch turns off on its own`() = runTest {
        stored(StoredMemoryPreferences(learnFromNotes = false))
        assertEquals(MemorySettings(true, false, true), service.getMemorySettings("CU1"))

        stored(StoredMemoryPreferences(learnFromChats = false, useInReplies = true))
        assertEquals(MemorySettings(false, true, true), service.getMemorySettings("CU1"))

        stored(StoredMemoryPreferences(useInReplies = false))
        assertEquals(MemorySettings(true, true, false), service.getMemorySettings("CU1"))
    }

    @Test
    fun `the legacy master switch turns everything off`() = runTest {
        stored(StoredMemoryPreferences(learnFromChats = true, legacyMemoryEnabled = "false"))

        assertEquals(MemorySettings.OFF, service.getMemorySettings("CU1"))
    }

    @Test
    fun `a failed read turns memory off`() = runTest {
        coEvery { profiles.getMemoryPreferences("CU1") } throws IllegalStateException("throttled")

        assertEquals(MemorySettings.OFF, service.getMemorySettings("CU1"))
    }

    @Test
    fun `deleting all memories removes each one and its vectors`() = runTest {
        coEvery { memoryRepo.getMemories("CU1") } returns listOf(memory("MEM#1"), memory("MEM#2"))
        coEvery { memoryRepo.deleteMemory("CU1", any()) } returns true
        coEvery { retrieval.deleteMemoryVectors("CU1", any()) } returns true

        assertEquals(2, service.deleteAllMemories("CU1"))

        coVerify { memoryRepo.deleteMemory("CU1", "MEM#1") }
        coVerify { memoryRepo.deleteMemory("CU1", "MEM#2") }
        coVerify(timeout = 5_000) { retrieval.deleteMemoryVectors("CU1", "MEM#1") }
        coVerify(timeout = 5_000) { retrieval.deleteMemoryVectors("CU1", "MEM#2") }
        coVerify(timeout = 5_000) { purge.deleteAllMemoryHistory("CU1") }
    }

    @Test
    fun `deleting all memories with none stored touches no vectors`() = runTest {
        coEvery { memoryRepo.getMemories("CU1") } returns emptyList()

        assertEquals(0, service.deleteAllMemories("CU1"))

        coVerify(exactly = 0) { retrieval.deleteMemoryVectors(any(), any()) }
    }

    private fun memory(id: String) = CustomerMemory(
        memoryId = id, text = "fact", kind = MemoryKind.EPISODIC,
        sourceType = MemorySourceType.CONVERSATION, createdAt = "t", updatedAt = "t"
    )
}
