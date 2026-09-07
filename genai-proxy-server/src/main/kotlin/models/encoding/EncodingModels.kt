package com.genflowly.models.encoding

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
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

/**
 * Body for /create-collections. The model determines the vector dimension the
 * collections are created with, so it must match the model used for encoding.
 */
@Serializable
data class EncodingCreateCollectionsRequest(
    val modelType: String,
    val modelName: String
)

/**
 * Wire format for a memory pushed into the embedding pipeline. Same dual-case
 * convention as [EncodingNoteData] for the server's mixed readers.
 */
@Serializable
data class EncodingMemoryData(
    val memory_key: String,
    val memoryKey: String,
    val memory_value: String,
    val memoryValue: String,
    val title: String,
    val created_at: String,
    val createdAt: String
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class EncodingSaveMemoryRequest(
    @EncodeDefault val dataType: String = "MEMORY",
    val client: String,
    val modelType: String? = null,
    val modelName: String? = null,
    val data: EncodingMemoryData
)

/**
 * Wire format for a conversation exchange pushed into the embedding pipeline.
 * Same dual-case convention as [EncodingNoteData] for the server's mixed
 * readers. conversation_key groups all of a conversation's chunk rows;
 * message_key (the assistant message id) keys this exchange's chunks.
 */
@Serializable
data class EncodingConversationData(
    val conversation_key: String,
    val conversationKey: String,
    val message_key: String,
    val messageKey: String,
    val text: String,
    val title: String,
    val created_at: String,
    val createdAt: String
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class EncodingSaveConversationRequest(
    @EncodeDefault val dataType: String = "CONVERSATION",
    val client: String,
    val modelType: String? = null,
    val modelName: String? = null,
    val data: EncodingConversationData
)

/**
 * Wire format for an instruction (persona) version pushed into the embedding
 * pipeline. Same dual-case convention as [EncodingNoteData] for the server's
 * mixed readers. Only the latest version is indexed — the encoding server
 * replaces the instruction's prior chunks on every push.
 */
@Serializable
data class EncodingInstructionData(
    val instruction_id: String,
    val instructionId: String,
    val version: Int,
    val name: String,
    val instructions: String,
    val category: String? = null,
    val tags: List<String>? = null,
    val created_at: String,
    val createdAt: String
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class EncodingSaveInstructionRequest(
    @EncodeDefault val dataType: String = "INSTRUCTION",
    val client: String,
    val modelType: String? = null,
    val modelName: String? = null,
    val data: EncodingInstructionData
)

@Serializable
data class EncodingSaveNoteRequest(
    val dataType: String,
    val client: String,
    val modelType: String? = null,
    val modelName: String? = null,
    // Optional chunking overrides (tokens); unset means the encoding server
    // resolves per-model values from its EmbeddingModelRegistry table
    val chunkSize: Int? = null,
    val chunkOverlap: Int? = null,
    val data: EncodingNoteData
)
