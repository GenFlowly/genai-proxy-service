package com.genflowly.service

import com.genflowly.models.AttachmentObjectInfo
import com.genflowly.models.AttachmentRef
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.models.MAX_PDFS_PER_MESSAGE
import com.genflowly.models.MAX_PDF_SIZE_BYTES
import com.genflowly.models.PDF_MEDIA_TYPE
import com.genflowly.providers.S3Provider
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Current-turn attachment checks: count (and a stricter PDF sub-count),
 * ownership, accepted kind, existence, and — for PDFs only — the real stored
 * content type and size (HEAD). Images carry no size/type check: the
 * retrieval-server converts/compresses them per vendor.
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
    fun `rejects attachments of an unsupported kind instead of dropping them`() = runTest {
        stubUploaded(sizeBytes = 10)
        rejects(listOf(ref("a"), ref("txt", mediaType = "text/plain")), "unsupported type")
    }

    @Test
    fun `accepts a PDF within the size limit when stored as application pdf`() = runTest {
        coEvery { s3Provider.head(any()) } returns AttachmentObjectInfo(1_000_000, PDF_MEDIA_TYPE)
        validator.validateAttachments(listOf(ref("p", mediaType = PDF_MEDIA_TYPE)), customerId)
    }

    @Test
    fun `rejects a PDF whose stored content type is not application pdf`() = runTest {
        // A client declaring application/pdf for an object stored as something
        // else (e.g. octet-stream) must not slip through.
        coEvery { s3Provider.head(any()) } returns AttachmentObjectInfo(10, "application/octet-stream")
        rejects(listOf(ref("p", mediaType = PDF_MEDIA_TYPE)), "not stored as a PDF")
    }

    @Test
    fun `rejects a PDF over the size limit`() = runTest {
        coEvery { s3Provider.head(any()) } returns AttachmentObjectInfo(MAX_PDF_SIZE_BYTES + 1, PDF_MEDIA_TYPE)
        rejects(listOf(ref("p", mediaType = PDF_MEDIA_TYPE)), "MB limit")
    }

    @Test
    fun `rejects more than the maximum number of PDFs`() = runTest {
        coEvery { s3Provider.head(any()) } returns AttachmentObjectInfo(10, PDF_MEDIA_TYPE)
        rejects(
            (1..MAX_PDFS_PER_MESSAGE + 1).map { ref("p$it", mediaType = PDF_MEDIA_TYPE) },
            "At most $MAX_PDFS_PER_MESSAGE PDFs"
        )
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
}
