package com.genflowly.service

import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import com.genflowly.models.api.GetConversationResponse
import com.genflowly.models.api.GetCustomerConversationsResponse
import com.genflowly.models.api.PromptAndResponse
import models.Conversation
import models.GenerateTextResponse
import models.Message
import models.Prompt

class ConversationAccessDeniedException(message: String) : Exception(message)
class ConversationArchivedException(message: String) : Exception(message)

class ConversationService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {

    /**
     * Returns the effective role [callerCustomerId] has on [conversationId]:
     * "OWNER" if they own it, otherwise the role from a direct share, otherwise
     * the PUBLIC role if one exists, otherwise null (no access).
     */
    suspend fun getConversationRole(conversationId: String, callerCustomerId: String): String? {
        val conversation = dynamoDBProvider.getConversationById(conversationId) ?: return null
        if (conversation.customerId == callerCustomerId) return "OWNER"

        val directShareRole = dynamoDBProvider.getConversationShare(conversationId, callerCustomerId)
        if (directShareRole != null) return directShareRole

        return dynamoDBProvider.getConversationShare(conversationId, "PUBLIC")
    }

    suspend fun getConversationHistory(conversationId: String, customerId: String): GetConversationResponse {
        val role = getConversationRole(conversationId, customerId)
            ?: throw ConversationAccessDeniedException("Conversation not found or access denied")

        val owner = dynamoDBProvider.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")

        val messages = dynamoDBProvider.getMessagesForConversation(conversationId)
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
                        val vendor = nextMsg.aiConfig.firstOrNull()?.aiVendor?.name
                        responses.add(
                            GenerateTextResponse(
                                text = nextMsg.text,
                                aiVendor = vendor,
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
                    val prompt = Prompt(instructionId = msg.instructionId ?: "", instructionVersion = msg.instructionVersion ?: "", prompt = msg.text)
                    currentTurnUserIds = mutableSetOf(msg.messageId)
                    currentTurnPrompt = msg.text
                    pairs.add(PromptAndResponse(prompt, responses, msg.createdAt))
                }
            }
            i++
        }

        val title = dynamoDBProvider.getConversationTitle(conversationId, owner.customerId)

        return GetConversationResponse(pairs, title, role)
    }

    suspend fun shareConversation(
        conversationId: String,
        targetCustomerId: String,
        sharedByCustomerId: String,
        role: String
    ) {
        requireEditOrOwner(conversationId, sharedByCustomerId, action = "share")
        val owner = dynamoDBProvider.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        if (dynamoDBProvider.isConversationArchived(conversationId, owner.customerId)) {
            throw ConversationArchivedException("Cannot share an archived conversation")
        }
        dynamoDBProvider.shareConversationWithCustomer(conversationId, targetCustomerId, sharedByCustomerId, role)
    }

    suspend fun unshareConversation(
        conversationId: String,
        targetCustomerId: String,
        sharedByCustomerId: String
    ) {
        requireEditOrOwner(conversationId, sharedByCustomerId, action = "unshare")
        dynamoDBProvider.unshareConversationWithCustomer(conversationId, targetCustomerId)
    }

    suspend fun getSharedUsersForConversation(
        conversationId: String,
        callerCustomerId: String
    ): List<models.CustomerProfile> {
        requireEditOrOwner(conversationId, callerCustomerId, action = "list-shares")
        return dynamoDBProvider.getUsersWithSharedConversation(conversationId)
    }

    private suspend fun requireEditOrOwner(conversationId: String, callerCustomerId: String, action: String) {
        val role = getConversationRole(conversationId, callerCustomerId)
        if (role != "OWNER" && role != "EDIT") {
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
        dynamoDBProvider.createConversation(conversation)
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
        val owner = dynamoDBProvider.getConversationById(conversationId) ?: return
        dynamoDBProvider.updateConversationTitle(conversationId, owner.customerId, title)
    }

    suspend fun archiveConversation(
        conversationId: String,
        customerId: String
    ) {
        requireEditOrOwner(conversationId, customerId, action = "archive")
        val owner = dynamoDBProvider.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        dynamoDBProvider.archiveConversation(conversationId, owner.customerId)
        dynamoDBProvider.unshareAllConversationWithCustomer(conversationId)
    }

    suspend fun unarchiveConversation(
        conversationId: String,
        customerId: String
    ) {
        requireEditOrOwner(conversationId, customerId, action = "unarchive")
        val owner = dynamoDBProvider.getConversationById(conversationId)
            ?: throw ConversationAccessDeniedException("Conversation not found")
        dynamoDBProvider.unarchiveConversation(conversationId, owner.customerId)
    }

    suspend fun getCustomerConversationsPaginated(
        customerId: String,
        pageSize: Int = 10,
        exclusiveStartKey: String? = null
    ): GetCustomerConversationsResponse {
        return dynamoDBProvider.getConversationsByCustomerPaginated(customerId, pageSize, exclusiveStartKey)
    }

    private suspend fun getMessage(
        conversationId: String,
        previousMessageId: String
    ): Message? {
        return dynamoDBProvider.getMessage(conversationId, previousMessageId)
    }

    suspend fun getMessageUsage(
        conversationId: String,
        messageId: String
    ): Map<String, Int?>? {
        val message = dynamoDBProvider.getMessage(conversationId, messageId) ?: return null
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
        dynamoDBProvider.createMessage(updateSequenceMessage)
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
        val messages = dynamoDBProvider.getMessagesForConversation(conversationId)
        return messages.maxByOrNull { it.sequence ?: 0 }?.messageId
    }

    /**
     * Returns the user message of the turn currently being generated, if the
     * latest message in the conversation is a user message with the given
     * prompt text. Parallel per-vendor stream calls for the same turn must
     * attach to that message instead of each persisting its own copy —
     * otherwise history fragments into one request/response pair per vendor.
     */
    suspend fun findActiveTurnUserMessage(conversationId: String, promptText: String): Message? {
        val messages = dynamoDBProvider.getMessagesForConversation(conversationId)
        val latest = messages.maxByOrNull { it.sequence ?: 0 } ?: return null
        return latest.takeIf { it.role == "user" && it.text == promptText }
    }
}