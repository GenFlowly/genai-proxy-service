package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.Conversation
import com.genflowly.models.RequestType
import com.genflowly.models.ShareRole
import com.genflowly.models.api.ConversationSummary
import com.genflowly.models.api.ForkConversationResponse
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.models.api.GetPinnedConversationsResponse
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ProjectRepository
import com.genflowly.repository.ShareRepository
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull
import org.slf4j.LoggerFactory
import java.time.Instant
import java.util.UUID
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
    private val conversationIndexingService: ConversationIndexingService,
    private val sharedUsersResolver: SharedUsersResolver,
    private val agentResolutionService: AgentResolutionService,
    private val generationAgentExecutor: GenerationAgentExecutor,
    private val contentDeletionService: ContentDeletionService,
    private val appScope: AppScope
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
                // "content" feeds the merged Title Creator agent; the legacy
                // keys keep pre-merge published templates rendering (extra
                // variables are no-ops in the renderer).
                variables = mapOf(
                    "content" to "Starting a conversation with ${instructionName ?: "no specific instruction"}. First message: $prompt",
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

    enum class DeleteResult {
        /** The owner deleted it, for everyone. */
        DELETED,
        /** Someone it was shared with removed it from their own history; the owner keeps it. */
        LEFT_SHARE
    }

    /**
     * The owner's delete is permanent and reaches everywhere the conversation
     * is stored (see [ContentDeletionService]); anyone it was shared with only
     * removes their own access. Throws [SecurityException] when the caller
     * has no access.
     */
    suspend fun deleteConversation(
        conversationId: String,
        customerId: String
    ): DeleteResult {
        return when (conversationService.getConversationRole(conversationId, customerId)) {
            ShareRole.OWNER -> {
                val parentId = conversationRepository.getConversationAttributes(conversationId, customerId)
                    ?.parentConversationId
                contentDeletionService.requestConversationDeletion(customerId, conversationId, parentId)
                DeleteResult.DELETED
            }
            ShareRole.EDIT, ShareRole.VIEW -> {
                shareRepository.unshareConversationWithCustomer(conversationId, customerId)
                DeleteResult.LEFT_SHARE
            }
            null -> throw SecurityException("Customer $customerId cannot delete conversation $conversationId")
        }
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

    /**
     * Forks [conversationId] at [forkAtMessageId]: creates a brand-new
     * conversation owned by the caller, titled "Forked <source title>",
     * containing a copy of every message up to and including the fork point —
     * nothing after it. The parent id is recorded on the new row so the
     * sidebar can draw the fork tree, and a fork can itself be forked.
     *
     * Any read access (owner, direct share, PUBLIC) suffices — a fork only
     * duplicates content the caller can already see, into the caller's own
     * account. Pin state and project grouping are per-customer, so they are
     * inherited only when the caller owns the source.
     */
    suspend fun forkConversation(
        conversationId: String,
        forkAtMessageId: String,
        callerCustomerId: String,
        bearerToken: String? = null
    ): ForkConversationResponse {
        val role = conversationService.getConversationRole(conversationId, callerCustomerId)
            ?: throw ConversationAccessDeniedException("Conversation not found or access denied")
        val source = conversationRepository.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        val attributes = conversationRepository.getConversationAttributes(conversationId, source.customerId)

        // Same ordering the history endpoint renders (sequence, with createdAt
        // breaking the ties racing parallel vendor streams can produce), so
        // "everything above the fork point" matches what the user saw.
        val messages = conversationRepository.getMessagesForConversation(conversationId)
            .sortedWith(compareBy({ it.sequence ?: 0 }, { it.createdAt ?: "" }))
        val forkIndex = messages.indexOfFirst { it.messageId == forkAtMessageId }
        require(forkIndex >= 0) { "Message $forkAtMessageId not found in conversation $conversationId" }
        val toCopy = messages.subList(0, forkIndex + 1)

        val isOwner = role == ShareRole.OWNER
        val fork = Conversation(
            customerId = callerCustomerId,
            client = source.client,
            projectId = if (isOwner) attributes?.projectId else null
        )
        val title = "Forked ${attributes?.title?.trim().takeUnless { it.isNullOrBlank() } ?: "conversation"}"
            .take(200)
        val pinnedAt = if (isOwner && attributes?.pinnedAt != null) Instant.now().toString() else null
        val now = conversationRepository.createForkedConversation(
            conversation = fork,
            title = title,
            pinnedAt = pinnedAt,
            parentConversationId = conversationId
        )

        // Fresh message ids so vector-index keys and future stream writes can
        // never collide with the source's; previousMessageId chains are
        // remapped onto the new ids. Author customerId is kept as-is so a
        // forked shared conversation still attributes turns correctly.
        val newIdByOldId = toCopy.associate { it.messageId to UUID.randomUUID().toString() }
        for (message in toCopy) {
            conversationRepository.createMessage(
                message.copy(
                    messageId = newIdByOldId.getValue(message.messageId),
                    conversationId = fork.conversationId,
                    previousMessageId = message.previousMessageId
                        ?.takeIf { it.isNotBlank() }
                        ?.let { newIdByOldId[it] }
                        ?: ""
                ),
                preserveCreatedAt = true
            )
        }
        logger.info(
            "Forked conversation $conversationId at $forkAtMessageId into ${fork.conversationId} " +
                "(${toCopy.size} of ${messages.size} messages) for $callerCustomerId"
        )

        // The vector index is keyed by (conversationId, messageId), so the
        // source's entries don't cover the copies — re-index each copied
        // exchange under the fork's ids. Fire-and-forget, like the
        // generation-time indexing.
        var lastUserText: String? = null
        for (message in toCopy) {
            when (message.role) {
                "user" -> lastUserText = message.text
                "assistant" -> lastUserText?.let { userText ->
                    conversationIndexingService.indexExchangeAsync(
                        customerId = callerCustomerId,
                        conversationId = fork.conversationId,
                        client = fork.client,
                        userText = userText,
                        responseMessageId = newIdByOldId.getValue(message.messageId),
                        bearerToken = bearerToken
                    )
                }
            }
        }

        return ForkConversationResponse(
            conversationId = fork.conversationId,
            title = title,
            parentConversationId = conversationId,
            projectId = fork.projectId,
            pinnedAt = pinnedAt,
            createdAt = now,
            updatedAt = now
        )
    }

    suspend fun getPinnedConversations(
        customerId: String,
        pageSize: Int = 50,
        exclusiveStartKey: String? = null
    ): GetPinnedConversationsResponse {
        val page = conversationRepository.getPinnedConversationsByCustomer(customerId, pageSize, exclusiveStartKey)
        return page.copy(conversations = enrichWithProjectNames(page.conversations, customerId))
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
     * One page of the project's conversations via the sparse projectIndex —
     * the ONLY sanctioned read path for "conversations in project X" (never
     * filter-after-read on the customer partition). No projectName
     * enrichment: the caller is rendering inside the project it asked about.
     */
    suspend fun getProjectConversations(
        customerId: String,
        projectId: String,
        pageSize: Int = 50,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse =
        conversationRepository.getConversationsByProject(customerId, projectId, pageSize, exclusiveStartKey)

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
