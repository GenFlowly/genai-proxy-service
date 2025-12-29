package com.genflowly.service

import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import com.genflowly.models.api.GetConversationResponse
import com.genflowly.models.api.PromptAndResponse
import models.Conversation
import models.GenerateTextResponse
import models.Message
import models.Prompt

class ConversationService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {

    suspend fun getConversationHistory(conversationId: String): GetConversationResponse {
        val messages = dynamoDBProvider.getMessagesForConversation(conversationId)
            .sortedBy { it.sequence }

        val pairs = mutableListOf<PromptAndResponse>()
        var i = 0
        while (i < messages.size) {
            val msg = messages[i]
            if (msg.role == "user") {
                val prompt = Prompt(systemPrompt = msg.systemPrompt, prompt = msg.text)
                
                // Default empty response
                var responseObj = GenerateTextResponse(
                    text = null, 
                    aiVendor = null, 
                    conversationId = conversationId, 
                    messageId = null
                )

                // Check next for assistant response
                if (i + 1 < messages.size) {
                    val nextMsg = messages[i+1]
                    if (nextMsg.role == "assistant") {
                        val vendor = nextMsg.aiConfig.firstOrNull()?.aiVendor?.name
                        responseObj = GenerateTextResponse(
                            text = nextMsg.text,
                            aiVendor = vendor,
                            conversationId = conversationId,
                            messageId = nextMsg.messageId
                        )
                        i++ // consume next message
                    }
                }
                pairs.add(PromptAndResponse(prompt, responseObj))
            }
            i++
        }

        return GetConversationResponse(pairs)
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
        message: Message
    ): String {
        // Prevent duplication: Check if an identical message (same text, role, conversation) already exists
        // especially for the latest turn.
        // This handles the race condition where multiple vendor requests send the same user prompt simultaneously.
        if (message.role == "user") {
            val existingMessages = dynamoDBProvider.getMessagesForConversation(message.conversationId)
            val duplicate = existingMessages.find { 
                it.role == "user" && 
                it.text == message.text && 
                // deduplicate only if it's the same 'turn', i.e. same parent or just verify it's recent?
                // matching previousMessageId is the strict check ensuring it's the exact same context.
                it.previousMessageId == message.previousMessageId 
            }
            if (duplicate != null) {
                return duplicate.messageId
            }
        }

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