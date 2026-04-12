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

class ConversationService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {

    suspend fun getConversationHistory(conversationId: String, customerId: String): GetConversationResponse {
        val messages = dynamoDBProvider.getMessagesForConversation(conversationId)
            .sortedBy { it.sequence }

        val pairs = mutableListOf<PromptAndResponse>()
        var i = 0
        while (i < messages.size) {
            val msg = messages[i]
            if (msg.role == "user") {
                val prompt = Prompt(instructionId = "", instructionVersion = "", prompt = msg.text)
                
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
                                messageId = nextMsg.messageId
                            )
                        )
                        i++ // consume next message
                    } else {
                        break
                    }
                }
                
                pairs.add(PromptAndResponse(prompt, responses))
            }
            i++
        }

        val title = dynamoDBProvider.getConversationTitle(conversationId, customerId)

        return GetConversationResponse(pairs, title)
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
        dynamoDBProvider.updateConversationTitle(conversationId, customerId, title)
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
}