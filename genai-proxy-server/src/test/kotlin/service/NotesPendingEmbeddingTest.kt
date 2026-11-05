package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.NoteData
import com.genflowly.models.api.SaveNoteRequest
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.NotesRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

/**
 * A note sent for embedding is recorded as pending (so search keyword-matches
 * it until its vectors land); autosaves and customers without a vector DB are
 * not; deleting a note forgets its row.
 */
class NotesPendingEmbeddingTest {

    private val notesRepository = mockk<NotesRepository>(relaxed = true)
    private val credentials = mockk<CustomerCredentialsRepository>()
    private val pending = mockk<VectorSyncPendingRepository>(relaxed = true)
    private val service = NotesService(
        mockk(relaxed = true), mockk(relaxed = true), notesRepository, mockk(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true), credentials, pending, AppScope()
    )

    private fun request(encode: Boolean) = SaveNoteRequest(
        client = "web",
        data = NoteData(note_key = "N1", note_value = "Deduct the home office", title = "Taxes", created_at = "t"),
        encode = encode
    )

    private fun hasVectorDb(has: Boolean) {
        coEvery { credentials.hasVectorDBConfig("CU1") } returns has
    }

    @Test
    fun `a note sent for embedding is recorded as pending`() = runTest {
        hasVectorDb(true)

        service.saveNoteAsync("CU1", request(encode = true), "token")

        coVerify { pending.markPending("CU1", PendingVectorType.NOTE, "N1", null, null) }
    }

    @Test
    fun `an autosave is not`() = runTest {
        hasVectorDb(true)

        service.saveNoteAsync("CU1", request(encode = false), "token")

        coVerify(exactly = 0) { pending.markPending(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a customer without a vector DB is not`() = runTest {
        hasVectorDb(false)

        service.saveNoteAsync("CU1", request(encode = true), "token")

        coVerify(exactly = 0) { pending.markPending(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `deleting a note forgets its pending row`() = runTest {
        coEvery { notesRepository.softDeleteNote("CU1", "N1") } returns true

        service.deleteNote("CU1", "N1")

        coVerify(timeout = 2000) { pending.clear("CU1", PendingVectorType.NOTE, "N1") }
    }
}
