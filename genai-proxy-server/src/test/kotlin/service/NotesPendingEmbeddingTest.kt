package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.CustomerEntitlements
import com.genflowly.models.api.NoteData
import com.genflowly.models.api.SaveNoteRequest
import com.genflowly.providers.EncodingServerClient
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.NotesRepository
import com.genflowly.repository.PendingVectorType
import com.genflowly.repository.VectorSyncPendingRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * A note sent for embedding is recorded as pending (so search keyword-matches
 * it until its vectors land); autosaves are not, and a customer without a
 * vector DB or an embedding key gets nothing sent at all; deleting a note
 * forgets its row.
 */
class NotesPendingEmbeddingTest {

    private val encoding = mockk<EncodingServerClient>(relaxed = true)
    private val notesRepository = mockk<NotesRepository>(relaxed = true)
    private val profiles = mockk<CustomerProfileRepository>()
    private val pending = mockk<VectorSyncPendingRepository>(relaxed = true)
    private val contentDeletion = mockk<ContentDeletionService>(relaxed = true)
    private val service = NotesService(
        encoding, contentDeletion, notesRepository, mockk(relaxed = true),
        mockk(relaxed = true), mockk(relaxed = true), mockk(relaxed = true),
        CustomerEntitlementService(profiles, mockk(), mockk()), pending, AppScope()
    )

    private fun request(encode: Boolean) = SaveNoteRequest(
        client = "web",
        data = NoteData(note_key = "N1", note_value = "Deduct the home office", title = "Taxes", created_at = "t"),
        encode = encode
    )

    private fun entitled(vectorDb: Boolean = true, embedding: Boolean = true) {
        coEvery { profiles.getEntitlements("CU1") } returns CustomerEntitlements(
            isVectorDbStoringEnabled = vectorDb, isEmbeddingCreationEnabled = embedding
        )
    }

    private fun assertNothingSent() {
        Thread.sleep(100)
        coVerify(exactly = 0) { pending.markPending(any(), any(), any(), any(), any()) }
        coVerify(exactly = 0) { encoding.encodeNote(any(), any()) }
    }

    @Test
    fun `a note sent for embedding is recorded as pending`() = runTest {
        entitled()

        service.saveNoteAsync("CU1", request(encode = true), "token")

        coVerify { pending.markPending("CU1", PendingVectorType.NOTE, "N1", null, null) }
        coVerify(timeout = 2000) { encoding.encodeNote(any(), "token") }
    }

    @Test
    fun `an autosave is not`() = runTest {
        entitled()

        service.saveNoteAsync("CU1", request(encode = false), "token")

        assertNothingSent()
    }

    @Test
    fun `a customer without a vector DB gets nothing sent`() = runTest {
        entitled(vectorDb = false)

        service.saveNoteAsync("CU1", request(encode = true), "token")

        assertNothingSent()
    }

    @Test
    fun `a customer without an embedding key gets nothing sent`() = runTest {
        entitled(embedding = false)

        service.saveNoteAsync("CU1", request(encode = true), "token")

        assertNothingSent()
    }

    @Test
    fun `deleting a note deletes it permanently`() = runTest {
        coEvery { notesRepository.getNote("CU1", "N1") } returns mapOf("noteKey" to AttributeValue.builder().s("N1").build())

        service.deleteNote("CU1", "N1")

        coVerify { contentDeletion.requestNoteDeletion("CU1", "N1") }
    }

    @Test
    fun `deleting a note that doesn't exist is a not-found`() = runTest {
        coEvery { notesRepository.getNote("CU1", "N1") } returns null

        assertFailsWith<NoteNotFoundException> { service.deleteNote("CU1", "N1") }

        coVerify(exactly = 0) { contentDeletion.requestNoteDeletion(any(), any()) }
    }
}
