package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.NotesRepository
import com.genflowly.providers.EncodingNoteData
import com.genflowly.providers.EncodingSaveNoteRequest
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import org.slf4j.LoggerFactory

@Serializable
data class NoteData(
    val note_key: String = "default_key",
    val note_value: String,
    val title: String = "Untitled",
    val created_at: String
)

@Serializable
data class SaveNoteRequest(
    val client: String,
    val data: NoteData,
    // Autosaves send encode=false to skip the embedding pipeline; only the
    // final save of an editing session (idle/blur/tab close) encodes.
    val encode: Boolean = true
)

@Serializable
data class CustomerNote(
    val noteKey: String,
    val noteValue: String,
    val title: String,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
data class GetNotesResponse(
    val notes: List<CustomerNote>
)

@Serializable
data class SaveNoteResponse(
    val status: String,
    // The note's effective title: the one sent by the client, or the one
    // generated during this save; null when the note has no real title yet
    val title: String? = null
)

@Serializable
data class DeleteNoteResponse(
    val status: String
)

class NoteNotFoundException(noteKey: String) : Exception("Note $noteKey not found")

class NotesService(
    private val encodingServerClient: EncodingServerClient,
    private val retrievalServerClient: RetrievalServerClient,
    private val notesRepository: NotesRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val aiRequestManager: AIRequestManager,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(NotesService::class.java)

    suspend fun getNotes(customerId: String): GetNotesResponse {
        val items = notesRepository.getNotes(customerId)
        val notes = items.map { item ->
            CustomerNote(
                noteKey = item["noteKey"]?.s() ?: "",
                noteValue = item["noteValue"]?.s() ?: "",
                title = item["title"]?.s() ?: "Untitled",
                // noteCreatedAt is the client-supplied creation time; createdAt is the DDB write time
                createdAt = item["noteCreatedAt"]?.s() ?: item["createdAt"]?.s() ?: "",
                updatedAt = item["updatedAt"]?.s() ?: ""
            )
        }.sortedByDescending { it.createdAt }
        return GetNotesResponse(notes = notes)
    }

    // Generate a title only for notes still on the default title and with
    // enough content to say something meaningful about
    private fun shouldGenerateTitle(title: String, content: String): Boolean =
        (title.isBlank() || title == "Untitled") && content.trim().length >= 15

    suspend fun saveNoteAsync(customerId: String, request: SaveNoteRequest, token: String): String? {
        val requestTitle = request.data.title.takeIf { it.isNotBlank() && it != "Untitled" }

        // 1. Save to DynamoDB
        notesRepository.saveNote(
            customerId = customerId,
            noteKey = request.data.note_key,
            noteValue = request.data.note_value,
            title = request.data.title,
            createdAt = request.data.created_at
        )

        // Intermediate autosaves stop here; encoding and title generation only
        // run on the final save of an editing session (idle/blur/tab close)
        if (!request.encode) {
            return requestTitle
        }

        // 2. Title generation via the retrieval server, only while the note
        // still has no real title. Awaited so the response carries the title
        // back to the client, which updates its header and sidebar from it.
        var effectiveTitle = requestTitle
        if (shouldGenerateTitle(request.data.title, request.data.note_value)) {
            try {
                val title = aiRequestManager.createNoteTitle(customerId, request.data.note_value)
                if (!title.isNullOrBlank()) {
                    notesRepository.updateNoteTitle(customerId, request.data.note_key, title)
                    logger.info("Generated title for note ${request.data.note_key}: '$title'")
                    effectiveTitle = title
                }
            } catch (e: Exception) {
                logger.error("Error generating note title for ${request.data.note_key}", e)
            }
        }

        // 3. Delivery to embedding. Batch-mode customers are swept from
        // CustomerNotes by the encoding server's accumulator, so we just flag the
        // note here and skip the synchronous /encode-notes call. Realtime
        // customers keep the existing async push.
        val prefs = try {
            customerProfileRepository.getAIConfigPreferences(customerId)
        } catch (e: Exception) {
            logger.error("Could not read embedding preferences for $customerId; defaulting to realtime", e)
            null
        }
        if (prefs?.embeddingMode == "batch") {
            val model = prefs.embeddingModel ?: "voyage-4-large"
            try {
                notesRepository.markNotePendingEmbedding(customerId, request.data.note_key, "voyage", model)
                logger.info("Flagged note ${request.data.note_key} for batch embedding ($model)")
            } catch (e: Exception) {
                logger.error("Failed to flag note ${request.data.note_key} for batch embedding", e)
            }
            return effectiveTitle
        }

        // Realtime: async call to encoding server
        val encodingRequest = EncodingSaveNoteRequest(
            dataType = "NOTE",
            client = request.client,
            data = EncodingNoteData(
                note_key = request.data.note_key,
                noteKey = request.data.note_key,
                note_id = request.data.note_key,
                note_value = request.data.note_value,
                noteValue = request.data.note_value,
                title = effectiveTitle ?: request.data.title,
                created_at = request.data.created_at,
                createdAt = request.data.created_at
            )
        )
        appScope.launch {
            encodingServerClient.encodeNote(encodingRequest, token)
        }

        return effectiveTitle
    }

    /**
     * Delete a note: soft delete in DynamoDB (is_delete=true, item kept) and a
     * hard delete of its embeddings in the vector DB via the retrieval server.
     * Throws NoteNotFoundException when the note doesn't exist.
     */
    suspend fun deleteNote(customerId: String, noteKey: String) {
        // 1. Soft delete in DynamoDB — the authoritative state for listings
        val existed = notesRepository.softDeleteNote(customerId, noteKey)
        if (!existed) {
            throw NoteNotFoundException(noteKey)
        }

        // 2. Hard-delete the note's vectors asynchronously (same fire-and-forget
        // convention as the encoding call on save); a failure leaves orphaned
        // vectors behind but never blocks or fails the delete itself
        appScope.launch {
            try {
                retrievalServerClient.deleteNoteVectors(customerId, noteKey)
            } catch (e: Exception) {
                logger.error("Error deleting vectors for note $noteKey", e)
            }
        }
    }
}
