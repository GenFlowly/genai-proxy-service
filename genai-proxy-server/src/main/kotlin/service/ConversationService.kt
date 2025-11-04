package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import models.Conversation
import models.Message

class ConversationService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {

    suspend fun createConversation(
        customerId: String,
        client: String
    ): String {
        val conversation = Conversation(customerId = customerId, client =
        client)
        dynamoDBProvider.createConversation(conversation)
        return conversation.conversationId
    }

    private suspend fun getMessage(
        conversationId: String,
        previousMessageId: String
    ): Message? {
        return dynamoDBProvider.getMessage(conversationId, previousMessageId)
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
        conversationId: String,
        customerId: String,
        role: String,
        client: String,
        aiVendor: AIVendor,
        text: String,
        previousMessageId: String?,
    ): String {
        val previousMessage = previousMessageId
            ?.takeIf { it.isNotBlank() }
            ?.let { getMessage(conversationId, it) }
        var sequence = 1
        if (previousMessage != null) {
            sequence = previousMessage.sequence + 1
        }
        val message = Message(
            conversationId = conversationId,
            customerId = customerId,
            client = client,
            aiVendor = aiVendor,
            role = role,
            text = text,
            sequence = sequence,
            previousMessageId = previousMessageId
        )
        dynamoDBProvider.createMessage(message)
        return message.messageId
    }
}