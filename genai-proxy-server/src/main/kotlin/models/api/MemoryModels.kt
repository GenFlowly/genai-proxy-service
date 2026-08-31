package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * One long-term memory learned about a customer from their conversations or
 * notes. `kind` decides how it reaches generation: CORE memories are injected
 * into every system prompt; EPISODIC memories are only embedded for semantic
 * recall through the RAG pipeline.
 */
@Serializable
data class CustomerMemory(
    val memoryId: String,
    val text: String,
    val kind: MemoryKind,
    val category: String? = null,
    val sourceType: MemorySourceType,
    val sourceId: String? = null,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
enum class MemoryKind { CORE, EPISODIC }

@Serializable
enum class MemorySourceType { CONVERSATION, NOTE }

@Serializable
data class GetMemoriesResponse(val memories: List<CustomerMemory>)

@Serializable
data class DeleteMemoryResponse(val status: String)
