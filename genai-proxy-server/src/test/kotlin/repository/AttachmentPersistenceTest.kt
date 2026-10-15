package com.genflowly.repository

import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Message rows written by createMessage read back identically through
 * getMessage: every AttachmentRef field (filename, sizeBytes, sourceKey,
 * pageCount) and the message fields purge and failed turns rely on
 * (fsNamespace, runId, claimPending, errorMessage). Rows written before these
 * fields existed still read, with the fields absent.
 */
class AttachmentPersistenceTest {

    private val client = mockk<DynamoDbClient>()
    private val repository = ConversationRepository(client, mockk<KLogger>(relaxed = true))

    private val pdf = AttachmentRef(
        attachmentId = "art-1",
        s3Key = "customers/c1/attachments/art-1",
        mediaType = "application/pdf",
        filename = "Quarterly report.pdf",
        sizeBytes = 13_312L,
        sourceKey = "customers/c1/attachments/art-1.source.md",
        pageCount = 7
    )

    private fun message(
        attachments: List<AttachmentRef> = emptyList(),
        fsNamespace: String? = null,
        runId: String? = null,
        claimPending: Boolean = false,
        errorMessage: String? = null
    ) = Message(
        messageId = "m-1",
        conversationId = "conv-1",
        text = "Here is your report.",
        attachments = attachments,
        client = "REACT_APP",
        role = "assistant",
        customerId = "c1",
        sequence = 2,
        systemPrompt = "",
        aiConfig = listOf(AIConfig(AIVendor.CLAUDE, "model-x")),
        previousMessageId = "u-1",
        fsNamespace = fsNamespace,
        runId = runId,
        claimPending = claimPending,
        errorMessage = errorMessage
    )

    /** Writes [message] through createMessage and returns the stored item. */
    private suspend fun store(message: Message): Map<String, AttributeValue> {
        val put = slot<PutItemRequest>()
        every { client.putItem(capture(put)) } returns PutItemResponse.builder().build()
        repository.createMessage(message)
        return put.captured.item()
    }

    /** Reads [item] back through getMessage. */
    private suspend fun load(item: Map<String, AttributeValue>): Message {
        every { client.getItem(any<GetItemRequest>()) } returns GetItemResponse.builder().item(item).build()
        return assertNotNull(repository.getMessage("conv-1", "m-1"))
    }

    @Test
    fun `an AttachmentRef with every optional field round-trips`() = runTest {
        val upload = AttachmentRef(
            attachmentId = "up-1",
            s3Key = "customers/c1/attachments/up-1",
            mediaType = "image/png",
            filename = "photo.png",
            sizeBytes = 5_000_000_000L // above Int range: stored as a Long
        )

        val loaded = load(store(message(attachments = listOf(pdf, upload))))

        assertEquals(listOf(pdf, upload), loaded.attachments)
    }

    @Test
    fun `optional attachment fields are stored with their DynamoDB types`() = runTest {
        val stored = store(message(attachments = listOf(pdf))).getValue("attachments").l().single().m()

        assertEquals("Quarterly report.pdf", stored["filename"]?.s())
        assertEquals("13312", stored["sizeBytes"]?.n())
        assertEquals("customers/c1/attachments/art-1.source.md", stored["sourceKey"]?.s())
        assertEquals("7", stored["pageCount"]?.n())
    }

    @Test
    fun `unset optional attachment fields are not written`() = runTest {
        val bare = AttachmentRef(attachmentId = "up-1", s3Key = "customers/c1/attachments/up-1", mediaType = "image/png")

        val stored = store(message(attachments = listOf(bare))).getValue("attachments").l().single().m()

        assertEquals(setOf("attachmentId", "s3Key", "mediaType"), stored.keys)
        assertEquals(listOf(bare), load(store(message(attachments = listOf(bare)))).attachments)
    }

    @Test
    fun `a legacy attachment map reads with the new fields null`() = runTest {
        val legacy = store(message()).toMutableMap()
        legacy["attachments"] = AttributeValue.builder().l(
            AttributeValue.builder().m(
                mapOf(
                    "attachmentId" to AttributeValue.builder().s("old-1").build(),
                    "s3Key" to AttributeValue.builder().s("customers/c1/attachments/old-1").build(),
                    "mediaType" to AttributeValue.builder().s("application/pdf").build()
                )
            ).build()
        ).build()

        val ref = load(legacy).attachments.single()

        assertEquals("old-1", ref.attachmentId)
        assertNull(ref.filename)
        assertNull(ref.sizeBytes)
        // No legacy fallback at read time: purge derives s3Key + ".source.md" itself
        assertNull(ref.sourceKey)
        assertNull(ref.pageCount)
    }

    @Test
    fun `fsNamespace, runId, claimPending and errorMessage round-trip`() = runTest {
        val original = message(
            fsNamespace = "ns-1234abcd",
            runId = "run_6f1c2b9e",
            claimPending = true,
            errorMessage = "The response was interrupted. Please try again."
        )

        val stored = store(original)
        val loaded = load(stored)

        assertEquals("ns-1234abcd", loaded.fsNamespace)
        assertEquals("run_6f1c2b9e", loaded.runId)
        assertTrue(loaded.claimPending)
        assertEquals("The response was interrupted. Please try again.", loaded.errorMessage)
        // A Number, not a BOOL, so the attribute can key a sparse GSI
        assertEquals("1", stored["claimPending"]?.n())
        assertEquals(original.copy(createdAt = loaded.createdAt), loaded)
    }

    @Test
    fun `unset message fields are not written and read back as defaults`() = runTest {
        val stored = store(message())

        listOf("fsNamespace", "runId", "claimPending", "errorMessage").forEach {
            assertFalse(stored.containsKey(it), "$it must be absent when unset")
        }
        val loaded = load(stored)
        assertNull(loaded.fsNamespace)
        assertNull(loaded.runId)
        assertFalse(loaded.claimPending)
        assertNull(loaded.errorMessage)
    }

    @Test
    fun `claimPending also reads a BOOL attribute`() = runTest {
        val item = store(message()).toMutableMap()

        item["claimPending"] = AttributeValue.builder().bool(true).build()
        assertTrue(load(item).claimPending)

        item["claimPending"] = AttributeValue.builder().n("0").build()
        assertFalse(load(item).claimPending)
    }
}
