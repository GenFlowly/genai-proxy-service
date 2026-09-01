package com.genflowly.service

import com.genflowly.models.Conversation
import com.genflowly.models.GenerateTextResponse
import com.genflowly.models.Message
import com.genflowly.models.Prompt
import com.genflowly.models.ShareRole
import com.genflowly.models.api.GetConversationResponse
import com.genflowly.models.api.PromptAndResponse
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.ShareRepository

class ConversationAccessDeniedException(message: String) : Exception(message)
class ConversationArchivedException(message: String) : Exception(message)

private val webSourcesJsonParser = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

/**
 * The conversational content domain: role resolution, history assembly and
 * message persistence — everything the generation and voice flows need per
 * turn. Lifecycle administration (titles, archiving, listing, sharing) lives
 * in ConversationManagementService.
 */
class ConversationService(
    private val conversationRepository: ConversationRepository,
    private val shareRepository: ShareRepository
) {

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
                                thinkingDurationMs = nextMsg.thinkingDurationMs,
                                webSources = nextMsg.webSourcesJson?.let {
                                    runCatching { webSourcesJsonParser.parseToJsonElement(it) }.getOrNull()
                                }
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

    /**
     * Returns a conversation id the caller may write to: creates a fresh
     * conversation when none is given, otherwise enforces write access
     * (OWNER/EDIT) on the existing one.
     */
    suspend fun resolveWritableConversationId(
        customerId: String,
        client: String,
        conversationId: String? = null
    ): String {
        if (conversationId.isNullOrBlank()) {
            return createConversation(customerId, client)
        }
        // Enforce that the caller can write to this conversation. New conversations
        // just created above have no shares yet, so this check only applies when
        // continuing an existing one.
        val role = getConversationRole(conversationId, customerId)
        if (role == null || !role.canEdit) {
            throw ConversationAccessDeniedException("Customer $customerId cannot write to conversation $conversationId")
        }
        return conversationId
    }

    // ─── Messages ─────────────────────────────────────────────────────────────

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
