package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.RequestType
import com.genflowly.models.ShareRole
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ProjectRepository
import com.genflowly.repository.ShareRepository
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import org.slf4j.LoggerFactory
import java.util.concurrent.ConcurrentHashMap

/**
 * Conversation lifecycle administration: titles (manual and AI-generated),
 * archiving, paginated listing and sharing. The conversational content itself
 * (history, messages, role resolution) lives in ConversationService.
 */
class ConversationManagementService(
    private val conversationService: ConversationService,
    private val conversationRepository: ConversationRepository,
    private val shareRepository: ShareRepository,
    private val projectRepository: ProjectRepository,
    private val sharedUsersResolver: SharedUsersResolver,
    private val agentResolutionService: AgentResolutionService,
    private val generationAgentExecutor: GenerationAgentExecutor,
    private val appScope: AppScope,
    /**
     * Purges a deleted owner's conversation once archive or unshare removed
     * its last share row (plan 3.9 step 8). Null: no purge (tests).
     */
    private val orphanedConversationPurge: OrphanedConversationPurge? = null
) {
    private val logger = LoggerFactory.getLogger("ConversationManagementService")

    /**
     * Title generations currently running, keyed by conversationId, so the
     * server-side kickoff (GenerationOrchestrator, fired the moment a new
     * conversation is created) and the clients' POST /conversation/title
     * dedupe into a single generation. In-memory is sufficient: deployment is
     * single-instance, and a lost entry only costs one extra generation.
     */
    private val inFlightTitles = ConcurrentHashMap<String, Deferred<String?>>()

    /**
     * Start title generation in the background (fire-and-forget) unless one
     * is already running for this conversation. Never throws: the generation
     * body catches everything and resolves to null on failure.
     */
    fun launchTitleGenerationAsync(
        conversationId: String,
        customerId: String,
        prompt: String,
        instructionName: String? = null
    ): Deferred<String?> {
        inFlightTitles[conversationId]?.let { return it }
        // LAZY so the deferred can't complete (and self-deregister) before it
        // has been registered in the map.
        val deferred = appScope.async(start = CoroutineStart.LAZY) {
            generateAndStoreTitle(conversationId, customerId, prompt, instructionName)
        }
        val existing = inFlightTitles.putIfAbsent(conversationId, deferred)
        if (existing != null) {
            deferred.cancel()
            return existing
        }
        deferred.invokeOnCompletion { inFlightTitles.remove(conversationId, deferred) }
        deferred.start()
        return deferred
    }

    /**
     * Idempotent title fetch for POST /conversation/title: awaits the
     * in-flight generation the orchestrator kicked off (the common case for
     * new UI conversations), else returns the stored title, else generates
     * now (old clients, restart mid-generation). Checked in that order — an
     * in-flight job that completes between checks lands in the stored read.
     */
    suspend fun createConversationTitle(
        conversationId: String,
        customerId: String,
        prompt: String,
        instructionName: String? = null
    ): String? {
        inFlightTitles[conversationId]?.let { inFlight ->
            return withTimeoutOrNull(TITLE_AWAIT_TIMEOUT_MS) { inFlight.await() }
        }
        // Title lives on the OWNER's row (the caller may be a shared editor)
        conversationRepository.getConversationById(conversationId)?.let { owner ->
            conversationRepository.getConversationTitle(conversationId, owner.customerId)
                ?.takeIf { it.isNotBlank() }
                ?.let { return it }
        }
        return withTimeoutOrNull(TITLE_AWAIT_TIMEOUT_MS) {
            launchTitleGenerationAsync(conversationId, customerId, prompt, instructionName).await()
        }
    }

    /**
     * Uses AI (via the retrieval-server) to generate and store a short title
     * for the conversation based on the first prompt and instruction name.
     * The prompt template and model come from the CONVERSATION_TITLE agent
     * (the published RequestAgentMap graph). Returns the title, or null
     * when generation failed or produced nothing usable.
     */
    private suspend fun generateAndStoreTitle(
        conversationId: String,
        customerId: String,
        prompt: String,
        instructionName: String? = null
    ): String? {
        return try {
            val agent = agentResolutionService.resolve(RequestType.CONVERSATION_TITLE, customerId)
            val result = generationAgentExecutor.executeWithCustomerKey(
                agent = agent,
                variables = mapOf(
                    "instructionName" to (instructionName ?: "no specific instruction"),
                    "prompt" to prompt
                ),
                customerId = customerId,
                conversationId = "title-generation"
            )

            // Strip any surrounding quotes the LLM may include (e.g. "My Title" -> My Title)
            val title = result.text.trim().removePrefix("\"").removeSuffix("\"").trim().take(200)
            if (title.isNotBlank()) {
                updateConversationTitle(conversationId, customerId, title)
                logger.info("Conversation title set for $conversationId: '$title'")
                title
            } else {
                null
            }
        } catch (e: Exception) {
            logger.warn("Failed to generate conversation title for $conversationId: ${e.message}")
            null
        }
    }

    suspend fun updateConversationTitle(
        conversationId: String,
        customerId: String,
        title: String
    ) {
        // Title update must be authorized by role, then persisted against the true owner
        // (the underlying row is keyed by owner customerId).
        requireEditOrOwner(conversationId, customerId, action = "rename")
        val owner = conversationRepository.getConversationById(conversationId) ?: return
        conversationRepository.updateConversationTitle(conversationId, owner.customerId, title)
    }

    suspend fun archiveConversation(
        conversationId: String,
        customerId: String
    ) {
        requireEditOrOwner(conversationId, customerId, action = "archive")
        val owner = conversationRepository.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        conversationRepository.archiveConversation(conversationId, owner.customerId)
        shareRepository.unshareAllConversationWithCustomer(conversationId)
        // Archive stays a restorable soft delete - unless the owner was deleted,
        // in which case nobody can open the conversation any more
        purgeIfOrphaned(conversationId, owner.customerId)
    }

    /** Best effort: a failure leaves the conversation as it is (an admin can re-run). */
    private suspend fun purgeIfOrphaned(conversationId: String, ownerCustomerId: String) {
        val purge = orphanedConversationPurge ?: return
        try {
            purge.enqueueIfOrphaned(conversationId, ownerCustomerId)
        } catch (e: Exception) {
            logger.warn("Could not check conversation {} for an orphan purge: {}", conversationId, e.message)
        }
    }

    suspend fun unarchiveConversation(
        conversationId: String,
        customerId: String
    ) {
        requireEditOrOwner(conversationId, customerId, action = "unarchive")
        val owner = conversationRepository.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        conversationRepository.unarchiveConversation(conversationId, owner.customerId)
    }

    /**
     * Pinning is owner-only and writes to the caller's own row: pin state is
     * per-customer, and the pinned list is queried on the caller's partition,
     * so pinning on behalf of the owner (as edit-shared actions do) would be
     * both a privacy leak and invisible to the caller.
     */
    suspend fun pinConversation(
        conversationId: String,
        customerId: String
    ) {
        requireOwner(conversationId, customerId, action = "pin")
        conversationRepository.pinConversation(conversationId, customerId)
    }

    suspend fun unpinConversation(
        conversationId: String,
        customerId: String
    ) {
        requireOwner(conversationId, customerId, action = "unpin")
        conversationRepository.unpinConversation(conversationId, customerId)
    }

    /**
     * Puts the conversation into one of the caller's projects (replacing any
     * previous assignment — this is also the move-between-projects path).
     * Owner-only for the same reason as pinning: the assignment is written to
     * the caller's own row and surfaces in the caller's own history sidebar.
     */
    suspend fun assignConversationToProject(
        conversationId: String,
        customerId: String,
        projectId: String
    ) {
        requireOwner(conversationId, customerId, action = "assign-project")
        projectRepository.getProject(customerId, projectId)
            ?: throw ProjectNotFoundException(projectId)
        conversationRepository.setConversationProject(conversationId, customerId, projectId)
    }

    suspend fun unassignConversationFromProject(
        conversationId: String,
        customerId: String
    ) {
        requireOwner(conversationId, customerId, action = "unassign-project")
        conversationRepository.removeConversationProject(conversationId, customerId)
    }

    suspend fun getPinnedConversations(customerId: String): List<ConversationSummary> {
        return enrichWithProjectNames(
            conversationRepository.getPinnedConversationsByCustomer(customerId),
            customerId
        )
    }

    suspend fun getCustomerConversationsPaginated(
        customerId: String,
        pageSize: Int = 10,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse {
        val page = conversationRepository.getConversationsByCustomerPaginated(customerId, pageSize, exclusiveStartKey)
        return page.copy(conversations = enrichWithProjectNames(page.conversations, customerId))
    }

    /**
     * Resolves projectName at read time (names are never denormalized onto
     * conversations, so a rename is immediately visible). One partition Query,
     * and only when the page references a project at all. A dangling projectId
     * resolves to projectName = null — the client falls back to showing the id.
     */
    private suspend fun enrichWithProjectNames(
        summaries: List<ConversationSummary>,
        customerId: String
    ): List<ConversationSummary> {
        if (summaries.none { it.projectId != null }) return summaries
        val namesById = projectRepository.getProjects(customerId).associate { it.projectId to it.name }
        return summaries.map { summary ->
            if (summary.projectId == null) summary
            else summary.copy(projectName = namesById[summary.projectId])
        }
    }

    // ─── Sharing ──────────────────────────────────────────────────────────────

    suspend fun shareConversation(
        conversationId: String,
        targetCustomerId: String,
        sharedByCustomerId: String,
        role: ShareRole
    ) {
        requireEditOrOwner(conversationId, sharedByCustomerId, action = "share")
        val owner = conversationRepository.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        if (conversationRepository.isConversationArchived(conversationId, owner.customerId)) {
            throw ConversationArchivedException("Cannot share an archived conversation")
        }
        shareRepository.shareConversationWithCustomer(conversationId, targetCustomerId, sharedByCustomerId, role)
    }

    suspend fun unshareConversation(
        conversationId: String,
        targetCustomerId: String,
        sharedByCustomerId: String
    ) {
        requireEditOrOwner(conversationId, sharedByCustomerId, action = "unshare")
        shareRepository.unshareConversationWithCustomer(conversationId, targetCustomerId)
        conversationRepository.getConversationById(conversationId)?.let { owner ->
            purgeIfOrphaned(conversationId, owner.customerId)
        }
    }

    suspend fun getSharedUsersForConversation(
        conversationId: String,
        callerCustomerId: String
    ): List<com.genflowly.models.CustomerProfile> {
        requireEditOrOwner(conversationId, callerCustomerId, action = "list-shares")
        return sharedUsersResolver.getUsersWithSharedConversation(conversationId)
    }

    private suspend fun requireOwner(conversationId: String, callerCustomerId: String, action: String) {
        val role = conversationService.getConversationRole(conversationId, callerCustomerId)
        if (role != ShareRole.OWNER) {
            throw SecurityException("Customer $callerCustomerId cannot $action conversation $conversationId")
        }
    }

    private suspend fun requireEditOrOwner(conversationId: String, callerCustomerId: String, action: String) {
        val role = conversationService.getConversationRole(conversationId, callerCustomerId)
        if (role == null || !role.canEdit) {
            throw SecurityException("Customer $callerCustomerId cannot $action conversation $conversationId")
        }
    }

    private companion object {
        // Below the shared HTTP client's 60s request timeout, so a slow
        // generation surfaces as {title: null} instead of a client error.
        const val TITLE_AWAIT_TIMEOUT_MS = 45_000L
    }
}
