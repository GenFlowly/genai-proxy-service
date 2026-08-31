package com.genflowly.models.api

import kotlinx.serialization.Serializable

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
    val encode: Boolean = true,
    // Optional chunking overrides (tokens) forwarded to the encoding server
    // for experimentation; when unset, the per-model defaults from the
    // EmbeddingModelRegistry table apply.
    val chunkSize: Int? = null,
    val chunkOverlap: Int? = null
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
