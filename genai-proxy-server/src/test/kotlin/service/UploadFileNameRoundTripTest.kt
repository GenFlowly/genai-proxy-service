package com.genflowly.service

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.providers.S3Provider
import com.genflowly.repository.ConversationRepository
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * 1.12: the upload's file name travels presign request -> presign response ->
 * the attachment the client sends back -> the persisted AttachmentRef.filename.
 */
class UploadFileNameRoundTripTest {

    @Test
    fun `the presigned file name reaches the stored message`() = runTest {
        val s3Provider = mockk<S3Provider> {
            coEvery { presignPut(any(), any(), any()) } returns "https://s3.example/put"
        }
        val upload = AttachmentService(s3Provider)
            .createUploadUrl("cust-1", "application/pdf", 2048, fileName = "Quarterly report.pdf", tagging = true)

        // What the client sends back in prompt.attachments, built from the presign response
        val clientJson = """{"attachmentId":"${upload.attachmentId}","s3Key":"${upload.s3Key}",""" +
            """"mediaType":"${upload.mediaType}","filename":"${upload.fileName}","sizeBytes":2048}"""
        val sent = Json { ignoreUnknownKeys = true }.decodeFromString<AttachmentRef>(clientJson)

        val dynamo = mockk<DynamoDbClient>()
        val puts = mutableListOf<PutItemRequest>()
        every { dynamo.putItem(capture(puts)) } returns PutItemResponse.builder().build()
        ConversationRepository(dynamo, mockk<KLogger>(relaxed = true)).createMessage(
            Message(
                conversationId = "conv-1", text = "summarize", attachments = listOf(sent),
                client = "REACT_APP", role = "user", customerId = "cust-1", systemPrompt = "",
                aiConfig = listOf(AIConfig(AIVendor.CLAUDE, "m")), previousMessageId = null
            )
        )

        val stored = puts.single().item()["attachments"]!!.l().single().m()
        assertEquals("Quarterly report.pdf", stored["filename"]?.s())
        assertEquals("2048", stored["sizeBytes"]?.n())
        assertEquals("application/pdf", stored["mediaType"]?.s())
    }
}
