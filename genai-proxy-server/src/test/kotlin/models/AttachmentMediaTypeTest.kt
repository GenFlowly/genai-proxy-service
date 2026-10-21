package com.genflowly.models

import com.genflowly.models.retrieval.FileRef
import com.genflowly.models.retrieval.ImageRef
import com.genflowly.models.retrieval.toFileRefs
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
            "image/tiff", "image/bmp", "image/x-adobe-dng",
            "image/vnd.microsoft.icon"
        )) {
            assertEquals(type, normalizeAttachmentMediaType(type))
        }
    }

    @Test
    fun `non-image and scriptable types are stored as octet-stream, never rejected`() {
        // A presigned GET serves the object with its stored type: an uploaded
        // page or SVG must not render (and run script) under the bucket's host.
        // (application/pdf is the one document type kept as itself — see below.)
        for (type in listOf(
            "text/html", "application/xhtml+xml", "text/xml",
            "application/javascript", "image/svg+xml", "IMAGE/SVG+XML; charset=utf-8",
            "image/svg", "image/foo+xml", "application/octet-stream"
        )) {
            assertEquals(octet, normalizeAttachmentMediaType(type), "for '$type'")
        }
    }

    @Test
    fun `application pdf is kept so the retrieval-server routes it to a document block`() {
        assertEquals(PDF_MEDIA_TYPE, normalizeAttachmentMediaType("application/pdf"))
        assertEquals(PDF_MEDIA_TYPE, normalizeAttachmentMediaType("APPLICATION/PDF; charset=utf-8"))
        assertEquals(AttachmentKind.PDF, attachmentKind("application/pdf"))
        assertEquals(true, isPdfAttachmentMediaType("application/pdf"))
        assertEquals(false, isImageAttachmentMediaType("application/pdf"))
    }

    @Test
    fun `attachmentKind classifies images, pdfs and unknowns`() {
        for (type in listOf("image/png", "IMAGE/JPEG; q=1", "", "  ", "application/octet-stream")) {
            assertEquals(AttachmentKind.IMAGE, attachmentKind(type), "for '$type'")
        }
        assertEquals(AttachmentKind.PDF, attachmentKind("application/pdf"))
        // NB: attachmentKind keys off the broad category only — image/svg+xml is
        // IMAGE here; it is the normalizer (not the kind) that neutralizes a
        // scriptable SVG to octet-stream at upload time.
        for (type in listOf("text/plain", "text/html", "application/zip")) {
            assertEquals(AttachmentKind.UNKNOWN, attachmentKind(type), "for '$type'")
        }
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

    @Test
    fun `pdf attachments are forwarded as files, images and unknowns are not`() {
        val refs = listOf(
            AttachmentRef("p", "customers/c1/attachments/p", "application/pdf", filename = "report.pdf"),
            AttachmentRef("img", "customers/c1/attachments/img", "image/png"),
            AttachmentRef("txt", "customers/c1/attachments/txt", "text/plain"),
        )
        assertEquals(
            listOf(FileRef("customers/c1/attachments/p", "application/pdf", "report.pdf")),
            refs.toFileRefs()
        )
    }

    @Test
    fun `a declared SVG is forwarded untyped so the retrieval-server sniffs it`() {
        assertEquals(
            listOf(ImageRef("customers/c1/attachments/a1", octet)),
            listOf(ref("image/svg+xml")).toImageRefs()
        )
    }

    @Test
    fun `image attachment types are recognized case-insensitively`() {
        for (type in listOf("image/heic", "IMAGE/PNG; q=1", "", "  ", "application/octet-stream", "image/svg+xml")) {
            assertEquals(true, isImageAttachmentMediaType(type), "for '$type'")
        }
        for (type in listOf("application/pdf", "text/plain", "text/html")) {
            assertEquals(false, isImageAttachmentMediaType(type), "for '$type'")
        }
    }
}
