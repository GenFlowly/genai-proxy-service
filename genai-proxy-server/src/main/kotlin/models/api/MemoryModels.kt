package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * One long-term memory learned about a customer from their conversations or
 * notes, or added by them. [placements] says where it applies: Profile (every
 * conversation) or one or more projects, each with its own kind. CORE
 * memories are injected into every system prompt where they apply; EPISODIC
 * memories are recalled by semantic search. [kind] is the first placement's
 * kind, kept for clients that predate placements.
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
    val updatedAt: String,
    val placements: List<MemoryPlacement> = emptyList(),
    val version: Int = 1,
    /**
     * False for memories stored before versions were recorded: their history
     * starts at the current text, as version 1.
     */
    val tracked: Boolean = false,
    val hitCount: Long = 0,
    val lastUsedAt: String? = null,
    /** Write counter for optimistic concurrency; never sent to clients. */
    @kotlinx.serialization.Transient
    val rev: Long = 0,
)

/** Where a memory applies: a project, or Profile when [projectId] is null. */
@Serializable
data class MemoryPlacement(val projectId: String? = null, val kind: MemoryKind)

/** Placements, falling back to Profile with [CustomerMemory.kind] for rows that have none. */
fun CustomerMemory.effectivePlacements(): List<MemoryPlacement> =
    placements.ifEmpty { listOf(MemoryPlacement(projectId = null, kind = kind)) }

fun CustomerMemory.isProfile(): Boolean = effectivePlacements().any { it.projectId == null }

fun CustomerMemory.projectIds(): List<String> = effectivePlacements().mapNotNull { it.projectId }

@Serializable
enum class MemoryKind { CORE, EPISODIC }

@Serializable
enum class MemorySourceType { CONVERSATION, NOTE, USER }

/**
 * What happened to a memory. LEARNED, UPDATED, ADDED_BY_YOU and EDITED_BY_YOU
 * create a version; MOVED, COPIED and REMOVED_FROM_PROJECT only change where
 * it applies. LEGACY is the starting point of a memory stored before changes
 * were recorded.
 */
@Serializable
enum class MemoryChangeType {
    LEARNED, UPDATED, ADDED_BY_YOU, EDITED_BY_YOU, MOVED, COPIED, REMOVED_FROM_PROJECT, LEGACY
}

/**
 * One immutable change-log entry. [version], [text] and [previousText] are set
 * when the text changed. [conversationTitle], [conversationAvailable] and
 * [youSaid] are read live when the log is served, so deleting the source
 * conversation also takes them out of the log.
 */
@Serializable
data class MemoryChange(
    val changeId: String,
    val type: MemoryChangeType,
    val createdAt: String,
    val version: Int? = null,
    val text: String? = null,
    val previousText: String? = null,
    val sourceType: MemorySourceType? = null,
    val conversationId: String? = null,
    val messageId: String? = null,
    val noteKey: String? = null,
    val reason: String? = null,
    val from: List<MemoryPlacement>? = null,
    val to: List<MemoryPlacement>? = null,
    val conversationTitle: String? = null,
    val conversationAvailable: Boolean? = null,
    val youSaid: String? = null,
)

/** One reply the memory was sent to the model for. [how]: core, recalled or search. */
@Serializable
data class MemoryUsage(
    val conversationId: String,
    val messageId: String,
    val usedAt: String,
    val how: String,
    val conversationTitle: String? = null,
    val conversationAvailable: Boolean = true,
)

@Serializable
data class GetMemoriesResponse(val memories: List<CustomerMemory>)

@Serializable
data class MemoryResponse(val memory: CustomerMemory)

/** A memory with its versions (newest first) and its full change log (newest first). */
@Serializable
data class MemoryDetailResponse(
    val memory: CustomerMemory,
    val versions: List<MemoryChange>,
    val changes: List<MemoryChange>,
)

@Serializable
data class MemoryUsagePage(val items: List<MemoryUsage>, val nextCursor: String? = null, val total: Long)

/** [projectId] null adds it to Profile. */
@Serializable
data class CreateMemoryRequest(val text: String, val kind: MemoryKind, val projectId: String? = null)

/** [baseVersion] is the version the edit started from; a newer stored version refuses the save. */
@Serializable
data class EditMemoryRequest(val text: String, val baseVersion: Int)

/** Null project ids mean Profile. */
@Serializable
data class MoveMemoryRequest(val fromProjectId: String? = null, val toProjectId: String? = null, val kind: MemoryKind)

@Serializable
data class CopyMemoryRequest(val fromProjectId: String, val toProjectId: String, val kind: MemoryKind)

@Serializable
data class DeleteMemoryResponse(val status: String, val deleted: Boolean = true)

@Serializable
data class DeleteAllMemoriesResponse(val status: String, val deleted: Int)

/** One fact learned about the user from an exchange (a created memory). */
@Serializable
data class LearnedFactView(val memoryId: String, val text: String)

/**
 * Async memory-extraction outcome for a message. status "pending" while
 * extraction has not written its marker yet; "done" with the facts (possibly
 * empty — nothing learned) once terminal.
 */
@Serializable
data class LearnedFactsResponse(
    val status: String,
    val facts: List<LearnedFactView> = emptyList(),
)
