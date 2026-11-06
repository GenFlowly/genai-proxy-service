package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.CopyMemoryRequest
import com.genflowly.models.api.CreateMemoryRequest
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.EditMemoryRequest
import com.genflowly.models.api.GetMemoriesResponse
import com.genflowly.models.api.MemoryChange
import com.genflowly.models.api.MemoryChangeType
import com.genflowly.models.api.MemoryDetailResponse
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.api.MemoryUsagePage
import com.genflowly.models.api.MoveMemoryRequest
import com.genflowly.models.api.isProfile
import com.genflowly.observability.Metrics
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MemoryChangeCause
import com.genflowly.repository.MemoryRepository
import com.genflowly.repository.ProjectRepository
import com.genflowly.repository.PurgeRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

class MemoryNotFoundException(memoryId: String) : Exception("Memory $memoryId not found")

/** The memory changed since the caller read it; reload and try again. */
class MemoryConflictException(message: String) : Exception(message)

/** The request doesn't make sense for this memory (wrong place, already there, bad text). */
class MemoryRequestException(message: String) : Exception(message)

/** The customer's memory switches, resolved: true means the customer allows it. */
data class MemorySettings(
    val learnFromChats: Boolean,
    val learnFromNotes: Boolean,
    val useInReplies: Boolean,
) {
    companion object {
        val OFF = MemorySettings(learnFromChats = false, learnFromNotes = false, useInReplies = false)
    }
}

/**
 * User-facing memory management and the governance check for memory use.
 * Learning (extraction) lives in [MemoryExtractionService]; generation-time
 * injection lives in the retrieval server's MEMORY graph node — the Kotlin
 * layer only decides IF memories may be used (consent), never HOW.
 *
 * A memory applies in Profile or in one or more projects. Moves change where
 * it applies; copies (project to project only) add another project that
 * shares the same memory. Neither touches its versions or change log.
 */
class MemoryService(
    private val memoryRepository: MemoryRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val memoryVectorService: MemoryVectorService,
    private val purgeRepository: PurgeRepository,
    private val projectRepository: ProjectRepository,
    private val conversationService: ConversationService,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger(MemoryService::class.java)

    /**
     * Each switch is on unless the customer turned it off, or turned memory
     * off as a whole with the legacy otherPreferences.memoryEnabled = "false".
     * A failed read turns everything off for that call: memory runs only
     * when the customer's consent is confirmed.
     */
    suspend fun getMemorySettings(customerId: String): MemorySettings = try {
        val stored = customerProfileRepository.getMemoryPreferences(customerId)
        val memoryOn = stored.legacyMemoryEnabled != "false"
        MemorySettings(
            learnFromChats = memoryOn && stored.learnFromChats != false,
            learnFromNotes = memoryOn && stored.learnFromNotes != false,
            useInReplies = memoryOn && stored.useInReplies != false,
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Metrics.count("memory_settings_read_failure_total")
        logger.warn("Could not read memory settings for $customerId; memory is off for this call", e)
        MemorySettings.OFF
    }

    suspend fun getMemories(customerId: String): GetMemoriesResponse =
        GetMemoriesResponse(memories = memoryRepository.getMemories(customerId).sortedByDescending { it.updatedAt })

    suspend fun getMemory(customerId: String, memoryId: String): CustomerMemory =
        memoryRepository.getMemory(customerId, memoryId) ?: throw MemoryNotFoundException(memoryId)

    /** A memory the customer wrote: version 1, applying in Profile or one project. */
    suspend fun createMemory(customerId: String, request: CreateMemoryRequest): CustomerMemory {
        val text = validText(request.text)
        request.projectId?.let { requireProject(customerId, it) }
        val memory = memoryRepository.createMemory(
            customerId = customerId,
            text = text,
            placements = listOf(MemoryPlacement(request.projectId, request.kind)),
            category = null,
            sourceType = MemorySourceType.USER,
            sourceId = null,
            cause = MemoryChangeCause(MemoryChangeType.ADDED_BY_YOU),
        )
        Metrics.count("memory_user_change_total", 1.0, "operation" to "create")
        appScope.launch { memoryVectorService.encode(customerId, memory) }
        return memory
    }

    /** Saves the customer's text as a new version; earlier versions are never changed. */
    suspend fun editMemory(customerId: String, memoryId: String, request: EditMemoryRequest): CustomerMemory {
        val memory = getMemory(customerId, memoryId)
        val text = validText(request.text)
        if (request.baseVersion != memory.version) {
            throw MemoryConflictException("Version ${memory.version} was saved after the one you edited")
        }
        if (text == memory.text) return memory
        if (!memoryRepository.updateMemoryText(customerId, memory, text, MemoryChangeCause(MemoryChangeType.EDITED_BY_YOU))) {
            throw refusal(customerId, memoryId)
        }
        Metrics.count("memory_user_change_total", 1.0, "operation" to "edit")
        val updated = getMemory(customerId, memoryId)
        appScope.launch { memoryVectorService.encode(customerId, updated) }
        return updated
    }

    /**
     * Changes where the memory applies. Moving to Profile drops every project
     * it was in, since Profile already applies everywhere; moving between
     * projects replaces [MoveMemoryRequest.fromProjectId] with the target.
     */
    suspend fun moveMemory(customerId: String, memoryId: String, request: MoveMemoryRequest): CustomerMemory {
        val memory = getMemory(customerId, memoryId)
        val current = memory.placements
        val from = current.firstOrNull { it.projectId == request.fromProjectId }
            ?: throw MemoryRequestException("The memory doesn't apply there")
        request.toProjectId?.let { requireProject(customerId, it) }
        val target = MemoryPlacement(request.toProjectId, request.kind)
        val next = when {
            target.projectId == null -> listOf(target)
            from.projectId == null -> listOf(target)
            else -> current.filter { it.projectId != from.projectId && it.projectId != target.projectId } + target
        }
        if (next.toSet() == current.toSet()) throw MemoryRequestException("The memory already applies there")
        val moved = if (target.projectId == null) current else listOf(from)
        if (!memoryRepository.setPlacements(
                customerId, memory, next, MemoryChangeCause(MemoryChangeType.MOVED), from = moved, to = listOf(target)
            )
        ) {
            throw refusal(customerId, memoryId)
        }
        Metrics.count("memory_user_change_total", 1.0, "operation" to "move")
        return getMemory(customerId, memoryId)
    }

    /**
     * Adds another project to a project memory. The projects share the one
     * memory: its text, versions, change log and hit counter.
     */
    suspend fun copyMemory(customerId: String, memoryId: String, request: CopyMemoryRequest): CustomerMemory {
        val memory = getMemory(customerId, memoryId)
        if (memory.isProfile()) throw MemoryRequestException("Profile memories already apply in every project")
        val from = memory.placements.firstOrNull { it.projectId == request.fromProjectId }
            ?: throw MemoryRequestException("The memory doesn't apply there")
        if (memory.placements.any { it.projectId == request.toProjectId }) {
            throw MemoryRequestException("The memory already applies in that project")
        }
        requireProject(customerId, request.toProjectId)
        val target = MemoryPlacement(request.toProjectId, request.kind)
        if (!memoryRepository.setPlacements(
                customerId, memory, memory.placements + target,
                MemoryChangeCause(MemoryChangeType.COPIED), from = listOf(from), to = listOf(target)
            )
        ) {
            throw refusal(customerId, memoryId)
        }
        Metrics.count("memory_user_change_total", 1.0, "operation" to "copy")
        return getMemory(customerId, memoryId)
    }

    /**
     * With [projectId] on a memory shared by several projects, removes it from
     * that project only and returns false. Otherwise deletes it everywhere —
     * the memory, its change and usage logs, its vectors — and returns true.
     * [cause] is set when extraction, not the customer, made the call.
     */
    suspend fun deleteMemory(
        customerId: String,
        memoryId: String,
        projectId: String? = null,
        cause: MemoryChangeCause? = null,
    ): Boolean {
        val memory = getMemory(customerId, memoryId)
        if (projectId != null) {
            val placement = memory.placements.firstOrNull { it.projectId == projectId }
                ?: throw MemoryRequestException("The memory doesn't apply in that project")
            if (memory.placements.size > 1) {
                if (!memoryRepository.setPlacements(
                        customerId, memory, memory.placements - placement,
                        cause ?: MemoryChangeCause(MemoryChangeType.REMOVED_FROM_PROJECT),
                        from = listOf(placement), to = emptyList()
                    )
                ) {
                    throw refusal(customerId, memoryId)
                }
                if (cause == null) Metrics.count("memory_user_change_total", 1.0, "operation" to "remove_from_project")
                return false
            }
        }
        deleteEverywhere(customerId, memoryId)
        if (cause == null) Metrics.count("memory_user_change_total", 1.0, "operation" to "delete")
        return true
    }

    /**
     * Forget everything: hard-deletes every memory and its change and usage
     * logs, then their embeddings asynchronously. Returns how many memories
     * were deleted.
     */
    suspend fun deleteAllMemories(customerId: String): Int {
        val memoryIds = memoryRepository.getMemories(customerId)
            .map { it.memoryId }
            .filter { memoryRepository.deleteMemory(customerId, it) }
        appScope.launch {
            try {
                purgeRepository.deleteAllMemoryHistory(customerId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logger.error("Error deleting memory history for $customerId", e)
            }
            memoryIds.forEach { memoryVectorService.delete(customerId, it) }
        }
        logger.info("Deleted {} memories for customer {}", memoryIds.size, customerId)
        return memoryIds.size
    }

    /**
     * A project is being deleted: each memory in it loses that project, and
     * a memory left in no project is deleted.
     */
    suspend fun removeProject(customerId: String, projectId: String) {
        memoryRepository.getMemories(customerId)
            .filter { memory -> memory.placements.any { it.projectId == projectId } }
            .forEach { memory ->
                try {
                    deleteMemory(customerId, memory.memoryId, projectId)
                } catch (e: MemoryConflictException) {
                    deleteMemory(customerId, memory.memoryId, projectId)
                } catch (e: MemoryNotFoundException) {
                    // Deleted meanwhile: nothing left to remove.
                }
            }
    }

    /**
     * The memory with its versions and change log, newest first. The source
     * conversation's title and the user's own words are read live, so they
     * disappear with the conversation.
     */
    suspend fun getMemoryDetail(customerId: String, memoryId: String): MemoryDetailResponse {
        val memory = getMemory(customerId, memoryId)
        val stored = memoryRepository.getChanges(customerId, memoryId)
        val changes = if (memory.tracked) stored else listOf(legacyBaseline(memory)) + stored
        val conversations = conversationInfo(customerId, changes.mapNotNull { it.conversationId })
        val enriched = coroutineScope {
            changes.map { change ->
                async {
                    val info = change.conversationId?.let { conversations[it] }
                    change.copy(
                        conversationTitle = info?.title,
                        conversationAvailable = info?.available,
                        youSaid = if (info?.available == true) youSaid(customerId, change) else null,
                    )
                }
            }.awaitAll()
        }.reversed()
        return MemoryDetailResponse(
            memory = memory,
            versions = enriched.filter { it.version != null }.sortedByDescending { it.version },
            changes = enriched,
        )
    }

    /** One page of the replies the memory was used in, newest first. */
    suspend fun getUsagePage(customerId: String, memoryId: String, limit: Int, cursor: String?): MemoryUsagePage {
        val memory = getMemory(customerId, memoryId)
        val (items, next) = memoryRepository.getUsagePage(customerId, memoryId, limit.coerceIn(1, MAX_USAGE_PAGE), cursor)
        val conversations = conversationInfo(customerId, items.map { it.conversationId })
        return MemoryUsagePage(
            items = items.map { usage ->
                val info = conversations[usage.conversationId]
                usage.copy(conversationTitle = info?.title, conversationAvailable = info?.available ?: false)
            },
            nextCursor = next,
            total = memory.hitCount,
        )
    }

    private suspend fun deleteEverywhere(customerId: String, memoryId: String) {
        if (!memoryRepository.deleteMemory(customerId, memoryId)) throw MemoryNotFoundException(memoryId)
        appScope.launch {
            try {
                purgeRepository.deleteMemoryHistory(customerId, memoryId)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                logger.error("Error deleting history of memory $memoryId", e)
            }
            memoryVectorService.delete(customerId, memoryId)
        }
    }

    /** Why a conditional write was refused: the memory is gone, or it changed. */
    private suspend fun refusal(customerId: String, memoryId: String): Exception =
        if (memoryRepository.getMemory(customerId, memoryId) == null) MemoryNotFoundException(memoryId)
        else MemoryConflictException("The memory changed while you were editing it")

    private suspend fun requireProject(customerId: String, projectId: String) {
        projectRepository.getProject(customerId, projectId)
            ?: throw MemoryRequestException("Project $projectId not found")
    }

    private fun validText(text: String): String {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) throw MemoryRequestException("A memory needs some text")
        if (trimmed.length > MAX_TEXT_CHARS) throw MemoryRequestException("A memory is at most $MAX_TEXT_CHARS characters")
        return trimmed
    }

    private data class ConversationInfo(val title: String?, val available: Boolean)

    /** Title and availability of each conversation, read once per id. */
    private suspend fun conversationInfo(customerId: String, conversationIds: List<String>): Map<String, ConversationInfo> =
        coroutineScope {
            conversationIds.distinct().map { id ->
                async {
                    id to try {
                        ConversationInfo(conversationService.getConversationTitle(id, customerId), available = true)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        ConversationInfo(title = null, available = false)
                    }
                }
            }.awaitAll().toMap()
        }

    /** The user's own message that caused the change, shortened. Other people's words are never quoted. */
    private suspend fun youSaid(customerId: String, change: MemoryChange): String? {
        val conversationId = change.conversationId ?: return null
        val messageId = change.messageId ?: return null
        val message = try {
            conversationService.getMessage(conversationId, messageId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.warn("Could not read message $messageId for memory change ${change.changeId}: ${e.message}")
            null
        } ?: return null
        if (message.customerId != customerId || message.role != "user") return null
        val text = message.text.trim()
        return if (text.length <= MAX_QUOTE_CHARS) text else text.take(MAX_QUOTE_CHARS).trimEnd() + "…"
    }

    private fun legacyBaseline(memory: CustomerMemory) = MemoryChange(
        changeId = LEGACY_CHANGE_ID,
        type = MemoryChangeType.LEGACY,
        createdAt = memory.createdAt,
        version = 1,
        text = memory.text,
        sourceType = memory.sourceType,
        conversationId = memory.sourceId.takeIf { memory.sourceType == MemorySourceType.CONVERSATION },
        noteKey = memory.sourceId.takeIf { memory.sourceType == MemorySourceType.NOTE },
    )

    companion object {
        const val MAX_TEXT_CHARS = 500
        const val MAX_QUOTE_CHARS = 280
        const val MAX_USAGE_PAGE = 50
        const val LEGACY_CHANGE_ID = "legacy"
    }
}
