package com.genflowly.models.encoding

import kotlinx.serialization.Serializable

/**
 * Wire format the encoding server expects for a note. Carries both snake_case
 * and camelCase copies of every field for compatibility with the server's
 * mixed readers — do not trim without coordinating with encoding-server.
 */
@Serializable
data class EncodingNoteData(
    val note_key: String,
    val noteKey: String,
    val note_id: String,
    val note_value: String,
    val noteValue: String,
    val title: String,
    val created_at: String,
    val createdAt: String
)

@Serializable
data class EncodingSaveNoteRequest(
    val dataType: String,
    val client: String,
    val data: EncodingNoteData
)
