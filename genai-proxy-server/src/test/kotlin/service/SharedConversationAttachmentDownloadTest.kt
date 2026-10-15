package com.genflowly.service

import com.genflowly.models.AttachmentObjectInfo
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Conversation
import com.genflowly.models.ShareRole
import com.genflowly.providers.S3Provider
import com.genflowly.repository.ConversationRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.MessageFileRefs
import com.genflowly.repository.ShareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * 1.11: a file generated or uploaded in one participant's turn is stored under
 * that participant's prefix, so a download inside a conversation presigns the
 * key stored on the message - for the owner, a share recipient and a PUBLIC
 * viewer alike - and nothing for anyone else or any id the conversation does
 * not contain.
 */
class SharedConversationAttachmentDownloadTest {

    private val owner = "cust-A"
    private val recipient = "cust-B"
    private val publicViewer = "cust-V"
    private val stranger = "cust-X"

    private val sharedConv = "conv-shared"
    private val publicConv = "conv-public"

    private val conversationRepo = mockk<ConversationRepository>()
    private val shareRepo = mockk<ShareRepository>()
    private val s3Provider = mockk<S3Provider>()
    private val conversationService = ConversationService(
        conversationRepo, shareRepo, mockk<CustomerProfileRepository>(relaxed = true), mockk(relaxed = true)
    )
    private val attachmentService = AttachmentService(s3Provider, conversationService)

    private fun key(customer: String, id: String) = "customers/$customer/attachments/$id"

    private fun message(
        id: String,
        author: String,
        role: String,
        attachments: List<AttachmentRef> = emptyList(),
        toolResultsJson: String? = null,
        conversationId: String = sharedConv
    ) = MessageFileRefs(
        conversationId = conversationId, messageId = id, customerId = author, role = role,
        attachments = attachments, toolResultsJson = toolResultsJson,
        fsNamespace = null, runId = null, claimPending = false, createdAt = null
    )

    init {
        coEvery { conversationRepo.getConversationById(sharedConv) } returns
            Conversation(conversationId = sharedConv, customerId = owner, client = "REACT_APP")
        coEvery { conversationRepo.getConversationById(publicConv) } returns
            Conversation(conversationId = publicConv, customerId = owner, client = "REACT_APP")
        coEvery { shareRepo.getConversationShare(any(), any()) } returns null
        coEvery { shareRepo.getConversationShare(sharedConv, recipient) } returns ShareRole.EDIT
        coEvery { shareRepo.getConversationShare(publicConv, "PUBLIC") } returns ShareRole.VIEW

        coEvery { conversationRepo.getMessageFileRefs(sharedConv) } returns listOf(
            // A's turn generated a PDF (under A's prefix) ...
            message("m1", owner, "user"),
            message(
                "m2", owner, "assistant",
                attachments = listOf(AttachmentRef("pdf-a", key(owner, "pdf-a"), "application/pdf", "report.pdf"))
            ),
            // ... and B's turn uploaded an image and generated a PDF under B's prefix
            message(
                "m3", recipient, "user",
                attachments = listOf(AttachmentRef("img-b", key(recipient, "img-b"), "image/png")),
                toolResultsJson = """[{"tool_call_id":"t1","content":"",""" +
                    """"images":[{"s3_key":"${key(recipient, "shot-b")}","media_type":"image/png"}]}]"""
            ),
            message(
                "m4", recipient, "assistant",
                attachments = listOf(AttachmentRef("pdf-b", key(recipient, "pdf-b"), "application/pdf"))
            )
        )
        coEvery { conversationRepo.getMessageFileRefs(publicConv) } returns listOf(
            message(
                "p1", owner, "assistant", conversationId = publicConv,
                attachments = listOf(AttachmentRef("pdf-p", key(owner, "pdf-p"), "application/pdf"))
            )
        )
        coEvery { s3Provider.head(any()) } returns AttachmentObjectInfo(10, "application/pdf")
        coEvery { s3Provider.presignGet(any(), any()) } answers { "https://s3.example/${firstArg<String>()}?sig" }
    }

    @Test
    fun `a share recipient opens a PDF generated in the owner's turn`() = runTest {
        val url = attachmentService.getViewUrlInConversation(recipient, "pdf-a", sharedConv)
        assertEquals("https://s3.example/${key(owner, "pdf-a")}?sig", url)
    }

    @Test
    fun `the owner opens a PDF generated in the recipient's turn, stored under the recipient's prefix`() = runTest {
        val url = attachmentService.getViewUrlInConversation(owner, "pdf-b", sharedConv)
        assertEquals("https://s3.example/${key(recipient, "pdf-b")}?sig", url)
    }

    @Test
    fun `uploaded images and tool-result images of another participant resolve too`() = runTest {
        assertEquals(
            "https://s3.example/${key(recipient, "img-b")}?sig",
            attachmentService.getViewUrlInConversation(owner, "img-b", sharedConv)
        )
        assertEquals(
            "https://s3.example/${key(recipient, "shot-b")}?sig",
            attachmentService.getViewUrlInConversation(owner, "shot-b", sharedConv)
        )
    }

    @Test
    fun `a PUBLIC viewer of a public share gets the file`() = runTest {
        val url = attachmentService.getViewUrlInConversation(publicViewer, "pdf-p", publicConv)
        assertEquals("https://s3.example/${key(owner, "pdf-p")}?sig", url)
    }

    @Test
    fun `a caller without access gets nothing and nothing is read`() = runTest {
        assertNull(attachmentService.getViewUrlInConversation(stranger, "pdf-a", sharedConv))
        coVerify(exactly = 0) { conversationRepo.getMessageFileRefs(sharedConv) }
        coVerify(exactly = 0) { s3Provider.presignGet(any(), any()) }
    }

    @Test
    fun `an id that is not in the conversation is not found, even for its owner`() = runTest {
        // pdf-p exists, but in another conversation
        assertNull(attachmentService.getViewUrlInConversation(owner, "pdf-p", sharedConv))
        assertNull(attachmentService.getViewUrlInConversation(owner, "no-such-id", sharedConv))
        coVerify(exactly = 0) { s3Provider.presignGet(any(), any()) }
    }

    @Test
    fun `a stored key that no longer exists in S3 is not found`() = runTest {
        coEvery { s3Provider.head(key(owner, "pdf-a")) } returns null
        assertNull(attachmentService.getViewUrlInConversation(recipient, "pdf-a", sharedConv))
    }

    @Test
    fun `a stored key outside the attachment prefixes is never presigned`() = runTest {
        coEvery { conversationRepo.getMessageFileRefs(sharedConv) } returns listOf(
            message("m9", owner, "user", attachments = listOf(AttachmentRef("odd", "customers/$owner/other/odd", "image/png")))
        )
        assertNull(attachmentService.getViewUrlInConversation(owner, "odd", sharedConv))
        coVerify(exactly = 0) { s3Provider.presignGet(any(), any()) }
    }

    @Test
    fun `without a conversation the caller's own prefix is used, as before`() = runTest {
        val url = attachmentService.getViewUrl(recipient, "pdf-a")
        assertEquals("https://s3.example/${key(recipient, "pdf-a")}?sig", url)
        coVerify(exactly = 0) { conversationRepo.getMessageFileRefs(any()) }
    }
}
