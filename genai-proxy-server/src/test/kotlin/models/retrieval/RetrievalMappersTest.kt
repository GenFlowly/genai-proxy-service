package com.genflowly.models.retrieval

import com.genflowly.models.AttachmentRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * parseGeneratedArtifacts maps the retrieval-server's artifact dicts (C1) onto
 * AttachmentRefs: every field survives, optional fields degrade to null, and
 * malformed input gives an empty list.
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
