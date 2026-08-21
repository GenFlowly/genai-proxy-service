package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.ShareRole
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository
import com.genflowly.models.AIConfig
import org.slf4j.LoggerFactory
import com.genflowly.models.api.GetConversationResponse
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.models.api.PromptAndResponse
import com.genflowly.models.Conversation
import com.genflowly.models.GenerateTextResponse
import com.genflowly.models.Message
import com.genflowly.models.Prompt

class ConversationAccessDeniedException(message: String) : Exception(message)
class ConversationArchivedException(message: String) : Exception(message)

class ConversationService(
    private val conversationRepository: ConversationRepository,
    private val shareRepository: ShareRepository,
    private val sharedUsersResolver: SharedUsersResolver,
    private val utilityGenerationService: UtilityGenerationService
) {
    private val logger = LoggerFactory.getLogger("ConversationService")

    private val titleAIModel: String = "gpt-5"
    private val titleAIVendor: AIVendor = AIVendor.OPENAI

    /**
     * Uses AI (direct SDK path) to generate and store a short title for the
     * conversation based on the first prompt and instruction name. Returns the
     * title, or null when generation failed or produced nothing usable.
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

    /**
     * Returns the effective role [callerCustomerId] has on [conversationId]:
     * [ShareRole.OWNER] if they own it, otherwise the role from a direct share,
     * otherwise the PUBLIC role if one exists, otherwise null (no access).
     */
    suspend fun getConversationRole(conversationId: String, callerCustomerId: String): ShareRole? {
        val conversation = conversationRepository.getConversationById(conversationId) ?: return null
        if (conversation.customerId == callerCustomerId) return ShareRole.OWNER

        val directShareRole = shareRepository.getConversationShare(conversationId, callerCustomerId)
        if (directShareRole != null) return directShareRole

        return shareRepository.getConversationShare(conversationId, "PUBLIC")
    }

    suspend fun getConversationHistory(conversationId: String, customerId: String): GetConversationResponse {
        val role = getConversationRole(conversationId, customerId)
            ?: throw ConversationAccessDeniedException("Conversation not found or access denied")

        val owner = conversationRepository.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")

        val messages = conversationRepository.getMessagesForConversation(conversationId)
            .sortedBy { it.sequence }

        val pairs = mutableListOf<PromptAndResponse>()
        // User-message ids of the turn currently being accumulated. A turn can
        // span several persisted user-message copies when parallel per-vendor
        // streams raced each other — those copies chain off this turn's ids and
        // repeat the same prompt, and must merge into a single pair.
        var currentTurnUserIds = mutableSetOf<String>()
        var currentTurnPrompt: String? = null
        var i = 0
        while (i < messages.size) {
            val msg = messages[i]
            if (msg.role == "user") {
                val isParallelDuplicate = pairs.isNotEmpty() &&
                    msg.text == currentTurnPrompt &&
                    currentTurnUserIds.contains(msg.previousMessageId)

                val responses = mutableListOf<GenerateTextResponse>()
                while (i + 1 < messages.size) {
                    val nextMsg = messages[i + 1]
                    if (nextMsg.role == "assistant") {
                        val config = nextMsg.aiConfig.firstOrNull()
                        val vendor = config?.aiVendor?.name
                        responses.add(
                            GenerateTextResponse(
                                text = nextMsg.text,
                                aiVendor = vendor,
                                model = config?.model,
                                conversationId = conversationId,
                                messageId = nextMsg.messageId,
                                inputTokens = nextMsg.inputTokens,
                                outputTokens = nextMsg.outputTokens,
                                totalTokens = nextMsg.totalTokens,
                                tokensReadFromCache = nextMsg.tokensReadFromCache,
                                thinkingDurationMs = nextMsg.thinkingDurationMs
                            )
                        )
                        i++ // consume next message
                    } else {
                        break
                    }
                }

                if (isParallelDuplicate) {
                    currentTurnUserIds.add(msg.messageId)
                    val last = pairs.removeAt(pairs.size - 1)
                    // Keep the first copy's createdAt — it marks when the turn was sent
                    pairs.add(PromptAndResponse(last.prompt, (last.responses ?: emptyList()) + responses, last.promptCreatedAt))
                } else {
                    val prompt = Prompt(instructionId = msg.instructionId ?: "", instructionVersion = msg.instructionVersion ?: "", prompt = msg.text, attachments = msg.attachments)
                    currentTurnUserIds = mutableSetOf(msg.messageId)
                    currentTurnPrompt = msg.text
                    pairs.add(PromptAndResponse(prompt, responses, msg.createdAt))
                }
            }
            i++
        }

        val title = conversationRepository.getConversationTitle(conversationId, owner.customerId)

        return GetConversationResponse(pairs, title, role)
    }

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
        val role = getConversationRole(conversationId, callerCustomerId)
        if (role == null || !role.canEdit) {
            throw SecurityException("Customer $callerCustomerId cannot $action conversation $conversationId")
        }
    }

    suspend fun createConversation(
        customerId: String,
        client: String
    ): String {
        val conversation = Conversation(
            customerId = customerId, client =
            client
        )
        conversationRepository.createConversation(conversation)
        return conversation.conversationId
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

    private suspend fun getMessage(
        conversationId: String,
        previousMessageId: String
    ): Message? {
        return conversationRepository.getMessage(conversationId, previousMessageId)
    }

    suspend fun getMessageUsage(
        conversationId: String,
        messageId: String
    ): Map<String, Int?>? {
        val message = conversationRepository.getMessage(conversationId, messageId) ?: return null
        return mapOf(
            "inputTokens" to message.inputTokens,
            "outputTokens" to message.outputTokens,
            "totalTokens" to message.totalTokens,
            "tokensReadFromCache" to message.tokensReadFromCache
        )
    }

    suspend fun getMessageThread(
        conversationId: String,
        messageId: String
    ): List<Message> {
        val messages = mutableListOf<Message>()
        var currentMessage = getMessage(conversationId, messageId)

        while (currentMessage != null) {
            messages.add(currentMessage)
            val prevId = currentMessage.previousMessageId
            currentMessage = if (!prevId.isNullOrBlank()) {
                getMessage(conversationId, prevId)
            } else null
        }

        return messages.reversed()
    }

    suspend fun addMessageInConversation(
        message: Message
    ): String {
        val updateSequenceMessage =
            updateSequenceOfMessageInConversation(message)
        conversationRepository.createMessage(updateSequenceMessage)
        return updateSequenceMessage.messageId
    }

    private suspend fun updateSequenceOfMessageInConversation(message: Message):
            Message {
        val previousMessage = message.previousMessageId
            ?.takeIf { it.isNotBlank() }
            ?.let { getMessage(message.conversationId, it) }
        if (previousMessage != null) {
            message.sequence = previousMessage.sequence?.plus(1) ?: 1
        }
        return message
    }

    suspend fun getLatestMessageId(conversationId: String): String? {
        val messages = conversationRepository.getMessagesForConversation(conversationId)
        return messages.maxByOrNull { it.sequence ?: 0 }?.messageId
    }

    /**
     * Returns the user message of the turn currently being generated, if the
     * latest message in the conversation is a user message with the given
     * prompt text. Parallel per-vendor stream calls for the same turn must
     * attach to that message instead of each persisting its own copy —
     * otherwise history fragments into one request/response pair per vendor.
     */
    suspend fun findActiveTurnUserMessage(
        conversationId: String,
        promptText: String,
        attachmentIds: List<String> = emptyList(),
        toolResultsJson: String? = null
    ): Message? {
        val messages = conversationRepository.getMessagesForConversation(conversationId)
        val latest = messages.maxByOrNull { it.sequence ?: 0 } ?: return null
        return latest.takeIf {
            it.role == "user" && it.text == promptText &&
                    it.attachments.map { a -> a.attachmentId } == attachmentIds &&
                    it.toolResultsJson == toolResultsJson
        }
    }
}