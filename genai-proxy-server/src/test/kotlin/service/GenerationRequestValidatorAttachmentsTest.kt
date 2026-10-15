package com.genflowly.service

import com.genflowly.models.AttachmentObjectInfo
import com.genflowly.models.AttachmentRef
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.models.MAX_PDFS_PER_MESSAGE
import com.genflowly.models.MAX_PDF_SIZE_BYTES
import com.genflowly.providers.S3Provider
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Current-turn attachment checks: count, ownership, image-or-PDF-ness and
 * existence. Images have no size or image-type check — the retrieval-server
 * converts/compresses them for each vendor. PDFs are capped at 5 per message
 * and 10 MiB each, checked on the stored object.
 */
class GenerationRequestValidatorAttachmentsTest {

    private val customerId = "cust-1"
    private val s3Provider = mockk<S3Provider>()
    private val validator = GenerationRequestValidator(s3Provider)

    private fun ref(id: String, customer: String = customerId, mediaType: String = "image/heic") =
        AttachmentRef(attachmentId = id, s3Key = "customers/$customer/attachments/$id", mediaType = mediaType)

    private fun stubUploaded(sizeBytes: Long, contentType: String? = "image/heic") {
        coEvery { s3Provider.head(any()) } returns AttachmentObjectInfo(sizeBytes, contentType)
    }

    private suspend fun rejects(attachments: List<AttachmentRef>, expectedFragment: String) {
        val e = assertFailsWith<IllegalArgumentException> {
            validator.validateAttachments(attachments, customerId)
        }
        assertTrue(
            e.message!!.contains(expectedFragment, ignoreCase = true),
            "Expected message to mention '$expectedFragment' but was: ${e.message}"
        )
    }

    @Test
    fun `no attachments is a no-op`() = runTest {
        validator.validateAttachments(emptyList(), customerId)
        coVerify(exactly = 0) { s3Provider.head(any()) }
    }

    @Test
    fun `accepts large uploads of any type`() = runTest {
        stubUploaded(sizeBytes = 200L * 1024 * 1024, contentType = "application/octet-stream")
        validator.validateAttachments(
            listOf(ref("a", mediaType = "image/heic"), ref("b", mediaType = "application/octet-stream")),
            customerId
        )
        coVerify(exactly = 2) { s3Provider.head(any()) }
    }

    @Test
    fun `rejects attachments declared as neither an image nor a PDF instead of dropping them`() = runTest {
        stubUploaded(sizeBytes = 10)
        rejects(listOf(ref("a"), ref("txt", mediaType = "text/plain")), "not an image or a PDF")
    }

    private fun pdf(id: String) = ref(id, mediaType = "application/pdf")

    @Test
    fun `accepts five PDFs of exactly 10 MiB next to images`() = runTest {
        coEvery { s3Provider.head(match { "pdf" in it }) } returns
            AttachmentObjectInfo(MAX_PDF_SIZE_BYTES, "application/pdf")
        coEvery { s3Provider.head(match { "img" in it }) } returns
            AttachmentObjectInfo(300L * 1024 * 1024, "image/heic")
        validator.validateAttachments(
            (1..MAX_PDFS_PER_MESSAGE).map { pdf("pdf$it") } + listOf(ref("img1"), ref("img2")),
            customerId
        )
    }

    @Test
    fun `rejects a sixth PDF in one message with a clear message, before any lookup`() = runTest {
        stubUploaded(sizeBytes = 1, contentType = "application/pdf")
        rejects(
            (1..MAX_PDFS_PER_MESSAGE + 1).map { pdf("pdf$it") },
            "At most $MAX_PDFS_PER_MESSAGE PDFs are allowed per message"
        )
        coVerify(exactly = 0) { s3Provider.head(any()) }
    }

    @Test
    fun `rejects an 11 MB PDF, measured on the stored object`() = runTest {
        stubUploaded(sizeBytes = 11L * 1024 * 1024, contentType = "application/pdf")
        rejects(listOf(pdf("big")), "is 11.0 MB; PDFs are limited to 10.0 MB")
    }

    @Test
    fun `rejects a PDF whose stored object is not a PDF`() = runTest {
        stubUploaded(sizeBytes = 100, contentType = "image/png")
        rejects(listOf(pdf("fake")), "was not uploaded as a PDF")
    }

    @Test
    fun `accepts exactly the maximum number of attachments`() = runTest {
        stubUploaded(sizeBytes = 1)
        validator.validateAttachments((1..MAX_ATTACHMENTS_PER_MESSAGE).map { ref("a$it") }, customerId)
    }

    @Test
    fun `rejects more than the maximum number of attachments`() = runTest {
        stubUploaded(sizeBytes = 1)
        rejects((1..MAX_ATTACHMENTS_PER_MESSAGE + 1).map { ref("a$it") }, "At most $MAX_ATTACHMENTS_PER_MESSAGE")
        coVerify(exactly = 0) { s3Provider.head(any()) }
    }

    @Test
    fun `rejects an attachment under another customer's prefix`() = runTest {
        stubUploaded(sizeBytes = 1)
        rejects(listOf(ref("a", customer = "someone-else")), "does not belong")
        coVerify(exactly = 0) { s3Provider.head(any()) }
    }

    @Test
    fun `rejects an attachment that was never uploaded`() = runTest {
        coEvery { s3Provider.head(any()) } returns null
        rejects(listOf(ref("missing")), "has not been uploaded")
    }

    @Test
    fun `with PDF uploads switched off a message with a PDF is refused, images pass`() = runTest {
        val gated = GenerationRequestValidator(s3Provider, pdfUploadsEnabled = false)
        stubUploaded(1024, "application/pdf")

        val e = assertFailsWith<IllegalArgumentException> {
            gated.validateAttachments(listOf(ref("doc-1", mediaType = "application/pdf")), customerId)
        }
        assertEquals(AttachmentService.PDF_UPLOADS_DISABLED_MESSAGE, e.message)

        stubUploaded(1024, "image/png")
        gated.validateAttachments(listOf(ref("img-1", mediaType = "image/png")), customerId)
    }
}
