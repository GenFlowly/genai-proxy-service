package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.AIConfig
import com.genflowly.models.Message
import com.genflowly.models.ShareRole
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository
import org.slf4j.LoggerFactory

/**
 * Conversation lifecycle administration: titles (manual and AI-generated),
 * archiving, paginated listing and sharing. The conversational content itself
 * (history, messages, role resolution) lives in ConversationService.
 */
class ConversationManagementService(
    private val conversationService: ConversationService,
    private val conversationRepository: ConversationRepository,
    private val shareRepository: ShareRepository,
    private val sharedUsersResolver: SharedUsersResolver,
    private val utilityGenerationService: UtilityGenerationService
) {
    private val logger = LoggerFactory.getLogger("ConversationManagementService")

    private val titleAIModel: String = "gpt-5"
    private val titleAIVendor: AIVendor = AIVendor.OPENAI

    /**
     * Uses AI (via the retrieval-server) to generate and store a short title
     * for the conversation based on the first prompt and instruction name.
     * Returns the title, or null when generation failed or produced nothing
     * usable.
     */
    suspend fun createConversationTitle(
        conversationId: String,
        customerId: String,
        prompt: String,
        instructionName: String? = null
    ): String? {
        return try {
            val titleMessage = Message(
                conversationId = "title-generation",
                text = "I am starting a conversation with $instructionName " +
                        "using" +
                        "this prompt - $prompt. Create a short title for this" +
                        "conversation. Just give the title",
                client = "internal",
                role = "user",
                customerId = customerId,
                systemPrompt = "",
                aiConfig = listOf(AIConfig(titleAIVendor, titleAIModel)),
                previousMessageId = null
            )

            val result = utilityGenerationService.generateText(
                titleAIVendor,
                titleAIModel,
                listOf(titleMessage),
                "",
                customerId
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

    suspend fun getCustomerConversationsPaginated(
        customerId: String,
        pageSize: Int = 10,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse {
        return conversationRepository.getConversationsByCustomerPaginated(customerId, pageSize, exclusiveStartKey)
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

    private suspend fun requireEditOrOwner(conversationId: String, callerCustomerId: String, action: String) {
        val role = conversationService.getConversationRole(conversationId, callerCustomerId)
        if (role == null || !role.canEdit) {
            throw SecurityException("Customer $callerCustomerId cannot $action conversation $conversationId")
        }
    }
}
