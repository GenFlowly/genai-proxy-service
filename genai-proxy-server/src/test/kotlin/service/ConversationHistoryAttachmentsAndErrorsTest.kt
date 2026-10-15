package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Conversation
import com.genflowly.models.Message
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.ShareRepository
import io.ktor.serialization.kotlinx.json.DefaultJson
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * Conversation history surfaces a failed turn's persisted errorMessage as
 * GenerateTextResponse.error, and carries the generated files' display fields
 * (filename, sizeBytes, pageCount) to the client, never their sourceKey.
 */
class ConversationHistoryAttachmentsAndErrorsTest {

    private val conv = "conv-1"
    private val owner = "cust-owner"

    private val conversationRepo = mockk<ConversationRepository>(relaxed = true)
    private val shareRepo = mockk<ShareRepository>(relaxed = true)
    private val customerProfileRepo = mockk<CustomerProfileRepository>(relaxed = true)
    private val service = ConversationService(conversationRepo, shareRepo, customerProfileRepo, mockk(relaxed = true))

    private val pdf = AttachmentRef(
        attachmentId = "art-1",
        s3Key = "customers/cust-owner/attachments/art-1",
        mediaType = "application/pdf",
        filename = "Report.pdf",
        sizeBytes = 13_312L,
        sourceKey = "customers/cust-owner/attachments/art-1.source.md",
        pageCount = 7
    )

    private fun userMsg(id: String, seq: Int) = Message(
        messageId = id, conversationId = conv, text = "write a report", client = "REACT_APP", role = "user",
        customerId = owner, sequence = seq, systemPrompt = "", aiConfig = emptyList(), previousMessageId = null
    )

    private fun assistantMsg(
        id: String,
        seq: Int,
        prev: String,
        text: String,
        errorMessage: String? = null,
        attachments: List<AttachmentRef> = emptyList()
    ) = Message(
        messageId = id, conversationId = conv, text = text, client = "REACT_APP", role = "assistant",
        customerId = owner, sequence = seq, systemPrompt = "", aiConfig = listOf(AIConfig(AIVendor.CLAUDE, "model-x")),
        previousMessageId = prev, errorMessage = errorMessage, attachments = attachments
    )

    private fun stubConversation(messages: List<Message>) {
        coEvery { conversationRepo.getConversationById(conv) } returns Conversation(conversationId = conv, customerId = owner, client = "REACT_APP")
        coEvery { conversationRepo.getMessagesForConversation(conv) } returns messages
        coEvery { shareRepo.getConversationShare(any(), any()) } returns null
        coEvery { customerProfileRepo.getCustomerProfileByCustomerId(any()) } returns null
        coEvery { conversationRepo.getPendingRuns(any(), any()) } returns emptyList()
    }

    @Test
    fun `a failed turn's errorMessage becomes the response error`() = runTest {
        stubConversation(listOf(
            userMsg("u1", 1),
            assistantMsg("a1", 2, prev = "u1", text = "", errorMessage = "The response was interrupted.")
        ))

        val response = service.getConversationHistory(conv, owner).promptAndResponseList.single().responses!!.single()

        assertEquals("The response was interrupted.", response.error)
        assertEquals("", response.text)
    }

    @Test
    fun `a completed turn has no error`() = runTest {
        stubConversation(listOf(userMsg("u1", 1), assistantMsg("a1", 2, prev = "u1", text = "done")))

        val response = service.getConversationHistory(conv, owner).promptAndResponseList.single().responses!!.single()

        assertNull(response.error)
    }

    @Test
    fun `generated files reach the client with display fields and without sourceKey`() = runTest {
        stubConversation(listOf(
            userMsg("u1", 1),
            assistantMsg("a1", 2, prev = "u1", text = "Here it is.", attachments = listOf(pdf))
        ))

        val history = service.getConversationHistory(conv, owner)
        val response = history.promptAndResponseList.single().responses!!.single()
        // The server-side model keeps every field...
        assertEquals(listOf(pdf), response.generatedAttachments)

        // ...but the JSON body the client receives (the server's ContentNegotiation
        // uses Ktor's DefaultJson) carries the display fields only.
        val body = DefaultJson.encodeToString(history)
        val card = DefaultJson.parseToJsonElement(body).jsonObject["promptAndResponseList"]!!.jsonArray[0]
            .jsonObject["responses"]!!.jsonArray[0].jsonObject["generatedAttachments"]!!.jsonArray[0].jsonObject
        assertEquals("Report.pdf", card["filename"]?.jsonPrimitive?.content)
        assertEquals("13312", card["sizeBytes"]?.jsonPrimitive?.content)
        assertEquals("7", card["pageCount"]?.jsonPrimitive?.content)
        assertFalse(card.containsKey("sourceKey"))
        assertFalse("source.md" in body)
    }
}
