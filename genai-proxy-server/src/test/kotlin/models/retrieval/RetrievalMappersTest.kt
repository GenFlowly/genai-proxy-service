package com.genflowly.models.retrieval

import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * parseGeneratedArtifacts maps the retrieval-server's artifact dicts (C1) onto
 * AttachmentRefs: every field survives, optional fields degrade to null, and
 * malformed input gives an empty list. Non-image attachments of history turns
 * and of the current turn map onto FileRefs (C10).
 */
class RetrievalMappersTest {

    @Test
    fun `every artifact field maps onto the AttachmentRef`() {
        val refs = parseGeneratedArtifacts(
            """[{"artifact_id":"a1","key":"customers/c1/attachments/a1","media_type":"application/pdf",
                "filename":"Report.pdf","size_bytes":13312,
                "source_key":"customers/c1/attachments/a1.source.md","page_count":7}]"""
        )

        assertEquals(
            listOf(
                AttachmentRef(
                    attachmentId = "a1",
                    s3Key = "customers/c1/attachments/a1",
                    mediaType = "application/pdf",
                    filename = "Report.pdf",
                    sizeBytes = 13312L,
                    sourceKey = "customers/c1/attachments/a1.source.md",
                    pageCount = 7
                )
            ),
            refs
        )
    }

    @Test
    fun `sizes beyond the Int range survive`() {
        val ref = parseGeneratedArtifacts("""[{"artifact_id":"a1","key":"k","size_bytes":5000000000}]""").single()

        assertEquals(5_000_000_000L, ref.sizeBytes)
    }

    @Test
    fun `an artifact without the optional fields keeps them null`() {
        val ref = parseGeneratedArtifacts("""[{"artifact_id":"a1","key":"k"}]""").single()

        assertEquals("application/octet-stream", ref.mediaType)
        assertEquals(null, ref.filename)
        assertEquals(null, ref.sizeBytes)
        assertEquals(null, ref.sourceKey)
        assertEquals(null, ref.pageCount)
    }

    @Test
    fun `JSON nulls and wrongly typed optional fields read as null`() {
        val ref = parseGeneratedArtifacts(
            """[{"artifact_id":"a1","key":"k","media_type":"application/pdf","filename":null,
                "size_bytes":"lots","source_key":null,"page_count":{"n":7}}]"""
        ).single()

        assertEquals("application/pdf", ref.mediaType)
        assertEquals(null, ref.filename)
        assertEquals(null, ref.sizeBytes)
        assertEquals(null, ref.sourceKey)
        assertEquals(null, ref.pageCount)
    }

    @Test
    fun `a blank source_key reads as null`() {
        assertEquals(null, parseGeneratedArtifacts("""[{"artifact_id":"a1","key":"k","source_key":" "}]""").single().sourceKey)
    }

    @Test
    fun `entries without an id or key are skipped`() {
        val refs = parseGeneratedArtifacts(
            """[{"key":"k0"},{"artifact_id":"a1"},{"artifact_id":null,"key":"k2"},{"artifact_id":"a3","key":"k3"}]"""
        )

        assertEquals(listOf("a3"), refs.map { it.attachmentId })
    }

    // ── History and current-turn files (3.1, contract C10) ──────────────────

    private val generatedPdf = AttachmentRef(
        attachmentId = "art-1",
        s3Key = "customers/c2/attachments/art-1",
        mediaType = "application/pdf",
        filename = "Report.pdf",
        sizeBytes = 13_312L,
        sourceKey = "customers/c2/attachments/art-1.source.md",
        pageCount = 3
    )
    private val uploadedPdf = AttachmentRef(
        attachmentId = "up-1",
        s3Key = "customers/c1/attachments/up-1",
        mediaType = "application/pdf",
        filename = "Brief.pdf",
        sizeBytes = 2_048L
    )
    private val photo = AttachmentRef("img-1", "customers/c1/attachments/img-1", "image/png")

    private fun message(role: String, attachments: List<AttachmentRef>) = Message(
        conversationId = "conv-1",
        text = if (role == "assistant") "Here is the report." else "Summarise this",
        attachments = attachments,
        client = "REACT_APP",
        role = role,
        customerId = "c1",
        systemPrompt = "",
        aiConfig = emptyList(),
        previousMessageId = null
    )

    @Test
    fun `an assistant PDF maps to files with origin generated and no images`() {
        val turn = message("assistant", listOf(generatedPdf)).toConversationMessage()

        assertEquals(emptyList(), turn.images)
        assertEquals(
            listOf(
                FileRef(
                    attachmentId = "art-1",
                    // Exactly as stored, even under another participant's prefix.
                    s3Key = "customers/c2/attachments/art-1",
                    mediaType = "application/pdf",
                    filename = "Report.pdf",
                    sizeBytes = 13_312L,
                    origin = FileOrigin.GENERATED
                )
            ),
            turn.files
        )
    }

    @Test
    fun `a user PDF maps to files with origin uploaded while images stay images`() {
        val turn = message("user", listOf(photo, uploadedPdf)).toConversationMessage()

        assertEquals(listOf(ImageRef("customers/c1/attachments/img-1", "image/png")), turn.images)
        assertEquals(
            listOf(FileRef("up-1", "customers/c1/attachments/up-1", "application/pdf", "Brief.pdf", 2_048L, FileOrigin.UPLOADED)),
            turn.files
        )
    }

    @Test
    fun `a turn with only images has no files`() {
        assertEquals(emptyList(), message("user", listOf(photo)).toConversationMessage().files)
        assertEquals(emptyList(), message("assistant", emptyList()).toConversationMessage().files)
    }

    @Test
    fun `the current turn's non-image attachments become file refs with the given origin`() {
        val untyped = AttachmentRef("img-2", "customers/c1/attachments/img-2", "application/octet-stream")

        val files = listOf(photo, untyped, uploadedPdf).toFileRefs(FileOrigin.UPLOADED)

        // Untyped uploads are treated as images (iPhone HEIC), never as files.
        assertEquals(listOf("up-1"), files.map { it.attachmentId })
        assertEquals(FileOrigin.UPLOADED, files.single().origin)
    }

    // ── Failed turns in history (0.3) ───────────────────────────────────────

    @Test
    fun `a failed assistant turn without text replays a note instead of an empty message`() {
        val failed = message("assistant", emptyList()).copy(
            text = "", errorMessage = "The response was interrupted before it finished. Please try again."
        )

        assertEquals(
            "[No response: The response was interrupted before it finished. Please try again.]",
            failed.toConversationMessage().content
        )
    }

    @Test
    fun `partial text, tool calls and successful turns replay unchanged`() {
        val partial = message("assistant", emptyList()).copy(text = "The capital is", errorMessage = "cut off")
        val toolCalls = message("assistant", emptyList()).copy(text = "", toolCallsJson = "[]", errorMessage = "x")
        val userTurn = message("user", emptyList()).copy(text = "", errorMessage = "x")

        assertEquals("The capital is", partial.toConversationMessage().content)
        assertEquals("", toolCalls.toConversationMessage().content)
        assertEquals("", userTurn.toConversationMessage().content)
        assertEquals("Here is the report.", message("assistant", emptyList()).toConversationMessage().content)
    }

    // ── Locale from Accept-Language (6.1, contract C11) ─────────────────────

    @Test
    fun `the first language tag of Accept-Language is the locale`() {
        assertEquals("en-US", localeFromAcceptLanguage("en-US,en;q=0.9,de;q=0.8"))
        assertEquals("de", localeFromAcceptLanguage("de"))
        assertEquals("zh-Hant-TW", localeFromAcceptLanguage(" zh-Hant-TW ; q=1 , en"))
        assertEquals("es-419", localeFromAcceptLanguage("es-419;q=0.7"))
    }

    @Test
    fun `q-values do not reorder the tags`() {
        // Browsers list tags by preference; the first listed wins.
        assertEquals("fr-CA", localeFromAcceptLanguage("fr-CA;q=0.5,en;q=0.9"))
    }

    @Test
    fun `the wildcard and implausible tags are skipped`() {
        assertEquals("fr-CA", localeFromAcceptLanguage("*, fr-CA;q=0.8"))
        assertEquals("de", localeFromAcceptLanguage("en_US, <script>, de"))
        assertEquals("pt-BR", localeFromAcceptLanguage("en-${"x".repeat(40)}, pt-BR"))
    }

    @Test
    fun `no usable tag gives no locale`() {
        assertEquals(null, localeFromAcceptLanguage(null))
        assertEquals(null, localeFromAcceptLanguage(""))
        assertEquals(null, localeFromAcceptLanguage("   "))
        assertEquals(null, localeFromAcceptLanguage("*"))
        assertEquals(null, localeFromAcceptLanguage("x, 12-34, en-"))
    }

    @Test
    fun `a 35-character tag is the longest accepted`() {
        val longest = "abcdefgh-abcdefgh-abcdefgh-abcdefgh"
        val tooLong = "abcdefg-abcdefgh-abcdefgh-abcdefgh-a" // well-formed, one char over
        assertEquals(35, longest.length)
        assertEquals(36, tooLong.length)
        assertEquals(longest, localeFromAcceptLanguage(longest))
        assertEquals(null, localeFromAcceptLanguage(tooLong))
    }

    @Test
    fun `malformed input gives an empty list`() {
        listOf(
            null,
            "",
            "   ",
            "not json",
            """{"artifact_id":"a1","key":"k"}""", // an object, not an array
            """[1, 2]""",                         // elements are not objects
            """[{"artifact_id":"a1","key":"k"}""" // truncated
        ).forEach { input ->
            assertTrue(parseGeneratedArtifacts(input).isEmpty(), "expected no artifacts for: $input")
        }
    }
}
