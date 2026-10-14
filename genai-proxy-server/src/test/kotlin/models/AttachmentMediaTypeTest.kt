package com.genflowly.models

import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.toImageRefs
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Attachment media types are never rejected: the declared type is normalized
 * (and bound into the presigned PUT's Content-Type), and anything blank or
 * malformed becomes application/octet-stream. The retrieval-server sniffs the
 * real format from the bytes.
 */
class AttachmentMediaTypeTest {

    private val octet = DEFAULT_ATTACHMENT_MEDIA_TYPE

    // ── normalizeAttachmentMediaType ──────────────────────────────────────────

    @Test
    fun `common and phone image types are kept as-is`() {
        for (type in listOf(
            "image/png", "image/jpeg", "image/webp", "image/gif",
            "image/heic", "image/heif", "image/heic-sequence", "image/avif",
            "image/tiff", "image/bmp", "image/svg+xml", "image/x-adobe-dng",
            "image/vnd.microsoft.icon"
        )) {
            assertEquals(type, normalizeAttachmentMediaType(type))
        }
    }

    @Test
    fun `non-image types are accepted, not coerced`() {
        assertEquals("application/pdf", normalizeAttachmentMediaType("application/pdf"))
        assertEquals("application/octet-stream", normalizeAttachmentMediaType("application/octet-stream"))
    }

    @Test
    fun `parameters are stripped, case folded and whitespace trimmed`() {
        assertEquals("image/heic", normalizeAttachmentMediaType("IMAGE/HEIC; charset=x"))
        assertEquals("image/jpeg", normalizeAttachmentMediaType("  Image/JPEG  "))
        assertEquals("image/png", normalizeAttachmentMediaType("image/png;"))
    }

    @Test
    fun `missing or blank types become octet-stream`() {
        assertEquals(octet, normalizeAttachmentMediaType(null))
        assertEquals(octet, normalizeAttachmentMediaType(""))
        assertEquals(octet, normalizeAttachmentMediaType("  "))
        assertEquals(octet, normalizeAttachmentMediaType("; charset=utf-8"))
    }

    @Test
    fun `syntactically invalid types become octet-stream`() {
        for (garbage in listOf(
            "garbage", "image", "image/", "/heic", "image/heic/extra",
            "image /heic", "image/he ic", "image/he\"ic", "-image/heic",
            "image/.heic", "image/hé", "image/*", "*/*"
        )) {
            assertEquals(octet, normalizeAttachmentMediaType(garbage), "for '$garbage'")
        }
    }

    @Test
    fun `header injection attempts become octet-stream`() {
        assertEquals(octet, normalizeAttachmentMediaType("image/png\r\nx-amz-acl: public-read"))
        assertEquals(octet, normalizeAttachmentMediaType("image/png\nX-Evil: 1"))
        assertEquals(octet, normalizeAttachmentMediaType("image/png\u0000"))
    }

    @Test
    fun `over-long types become octet-stream`() {
        val maxPart = "a".repeat(127)
        assertEquals("image/$maxPart", normalizeAttachmentMediaType("image/$maxPart"))
        assertEquals(octet, normalizeAttachmentMediaType("image/${maxPart}a"))
        assertEquals(octet, normalizeAttachmentMediaType("${maxPart}a/heic"))
        assertEquals(octet, normalizeAttachmentMediaType("image/" + "x".repeat(10_000)))
    }

    // ── toImageRefs (what reaches the retrieval-server) ───────────────────────

    private fun ref(mediaType: String, id: String = "a1") =
        AttachmentRef(attachmentId = id, s3Key = "customers/c1/attachments/$id", mediaType = mediaType)

    @Test
    fun `any image type and untyped uploads are forwarded as images`() {
        val refs = listOf(
            ref("image/heic", "h"),
            ref("application/octet-stream", "o"),
            ref("", "blank"),
            ref("IMAGE/PNG; q=1", "p")
        ).toImageRefs()

        assertEquals(
            listOf(
                ImageRef("customers/c1/attachments/h", "image/heic"),
                ImageRef("customers/c1/attachments/o", octet),
                ImageRef("customers/c1/attachments/blank", octet),
                ImageRef("customers/c1/attachments/p", "image/png")
            ),
            refs
        )
    }

    @Test
    fun `explicitly non-image attachments such as generated PDFs are not forwarded`() {
        assertEquals(emptyList<ImageRef>(), listOf(ref("application/pdf"), ref("text/plain")).toImageRefs())
    }
}
