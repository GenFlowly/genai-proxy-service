package com.genflowly.service

import com.genflowly.models.AttachmentObjectInfo
import com.genflowly.models.AttachmentRef
import com.genflowly.models.MAX_ATTACHMENTS_PER_MESSAGE
import com.genflowly.providers.S3Provider
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Current-turn attachment checks: count, ownership, image-ness and existence.
 * There is no size or image-type check — the retrieval-server
 * converts/compresses images for each vendor.
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
    fun `rejects attachments declared as a non-image type instead of dropping them`() = runTest {
        stubUploaded(sizeBytes = 10)
        rejects(listOf(ref("a"), ref("pdf", mediaType = "application/pdf")), "not an image")
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
