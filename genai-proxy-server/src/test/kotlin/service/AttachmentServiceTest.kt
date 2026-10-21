package com.genflowly.service

import com.genflowly.models.DEFAULT_ATTACHMENT_MEDIA_TYPE
import com.genflowly.models.MAX_PDF_SIZE_BYTES
import com.genflowly.models.PDF_MEDIA_TYPE
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
 * POST /attachments accepts any media type and any size >= 1 byte. The
 * effective (normalized) type is what gets bound into the presigned PUT and
 * returned to the client, which must upload with exactly that Content-Type.
 */
class AttachmentServiceTest {

    private val customerId = "cust-1"
    private val s3Provider = mockk<S3Provider> {
        coEvery { presignPut(any(), any(), any()) } answers { "https://s3.example/${firstArg<String>()}?sig" }
    }
    private val service = AttachmentService(s3Provider)

    @Test
    fun `accepts a 50 MB HEIC photo and presigns with its type`() = runTest {
        val upload = service.createUploadUrl(customerId, "image/heic", 50L * 1024 * 1024)

        assertEquals("image/heic", upload.mediaType)
        assertEquals("customers/$customerId/attachments/${upload.attachmentId}", upload.s3Key)
        assertEquals("https://s3.example/${upload.s3Key}?sig", upload.uploadUrl)
        coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, "image/heic", any()) }
    }

    @Test
    fun `accepts sizes far beyond the old 5 MB limit`() = runTest {
        val upload = service.createUploadUrl(customerId, "image/png", 4L * 1024 * 1024 * 1024)
        assertEquals("image/png", upload.mediaType)
    }

    @Test
    fun `presigns with and returns the normalized type, not the declared one`() = runTest {
        val upload = service.createUploadUrl(customerId, "IMAGE/HEIC; charset=x", 1)

        assertEquals("image/heic", upload.mediaType)
        coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, "image/heic", any()) }
    }

    @Test
    fun `blank, missing or malformed types are coerced to octet-stream, never rejected`() = runTest {
        for (declared in listOf("", "   ", null, "garbage", "image/png\r\nx-amz-acl: public-read")) {
            val upload = service.createUploadUrl(customerId, declared, 1234)
            assertEquals(DEFAULT_ATTACHMENT_MEDIA_TYPE, upload.mediaType, "for '$declared'")
            coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, DEFAULT_ATTACHMENT_MEDIA_TYPE, any()) }
        }
    }

    @Test
    fun `each upload gets its own attachment id`() = runTest {
        val a = service.createUploadUrl(customerId, "image/jpeg", 10)
        val b = service.createUploadUrl(customerId, "image/jpeg", 10)
        assertTrue(a.attachmentId != b.attachmentId)
    }

    @Test
    fun `accepts a PDF within the size limit and presigns with application pdf`() = runTest {
        val upload = service.createUploadUrl(customerId, "application/pdf", MAX_PDF_SIZE_BYTES)
        assertEquals(PDF_MEDIA_TYPE, upload.mediaType)
        coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, PDF_MEDIA_TYPE, any()) }
    }

    @Test
    fun `rejects a PDF declared over the size limit at presign`() = runTest {
        val e = assertFailsWith<IllegalArgumentException> {
            service.createUploadUrl(customerId, "application/pdf", MAX_PDF_SIZE_BYTES + 1)
        }
        assertTrue(e.message!!.contains("MB"), "unexpected message: ${e.message}")
        coVerify(exactly = 0) { s3Provider.presignPut(any(), any(), any()) }
    }

    @Test
    fun `rejects a zero or negative size`() = runTest {
        for (size in listOf(0L, -1L)) {
            val e = assertFailsWith<IllegalArgumentException> {
                service.createUploadUrl(customerId, "image/heic", size)
            }
            assertTrue(e.message!!.contains("at least 1 byte"), "unexpected message: ${e.message}")
        }
        coVerify(exactly = 0) { s3Provider.presignPut(any(), any(), any()) }
    }
}
