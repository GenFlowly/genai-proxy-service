package com.genflowly.service

import com.genflowly.models.AttachmentRef
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RetentionKeysTest {

    private fun ref(id: String, key: String, sourceKey: String? = null) =
        AttachmentRef(attachmentId = id, s3Key = key, mediaType = "application/pdf", sourceKey = sourceKey)

    @Test
    fun `only attachment and agent-fs keys under a customer prefix are retention keys`() {
        for (key in listOf(
            "customers/c1/attachments/a1",
            "customers/c1/attachments/a1.source.md",
            "customers/c1/agent-fs/ns-1/notes.md"
        )) assertTrue(RetentionKeys.isRetentionKey(key), key)
        for (key in listOf(
            null, "", "customers/c1/other/a1", "customers//attachments/a1", "customers/c1/attachments",
            "x/customers/c1/attachments/a1", "c1/attachments/a1", "customers/c1/attachments/a\u0000b"
        )) assertFalse(RetentionKeys.isRetentionKey(key), "$key")
    }

    @Test
    fun `attachment ids and customer ids come only from upload-shaped keys`() {
        assertEquals("a1", RetentionKeys.attachmentIdOfKey("customers/c1/attachments/a1"))
        assertNull(RetentionKeys.attachmentIdOfKey("customers/c1/attachments/a1/x"))
        assertNull(RetentionKeys.attachmentIdOfKey("customers/c1/agent-fs/a1"))
        assertEquals("c1", RetentionKeys.customerIdOfKey("customers/c1/agent-fs/ns/x"))
    }

    @Test
    fun `a message's keys cover uploads, sources, legacy sources and tool-result images`() {
        val malformed = mutableListOf<String>()
        val keys = RetentionKeys.messageKeys(
            role = "assistant",
            attachments = listOf(
                ref("pdf-new", "customers/c1/attachments/pdf-new", "customers/c1/attachments/pdf-new.source.md"),
                ref("pdf-old", "customers/c1/attachments/pdf-old"),
                ref("bad", "elsewhere/bad")
            ),
            toolResultsJson = """[{"tool_call_id":"t","content":"","images":[""" +
                """{"s3_key":"customers/c1/attachments/shot","media_type":"image/png"},""" +
                """{"media_type":"image/png","omitted":true},""" +
                """{"s3_key":"not/a/key","media_type":"image/png"}]}]""",
            onMalformed = { malformed += it }
        )

        assertEquals(
            setOf(
                "customers/c1/attachments/pdf-new",
                "customers/c1/attachments/pdf-new.source.md",
                "customers/c1/attachments/pdf-old",
                "customers/c1/attachments/shot"
            ),
            keys.exact
        )
        assertEquals(setOf("customers/c1/attachments/pdf-old.source.md"), keys.optional)
        // Logged by id only: the malformed key itself is never reported
        assertEquals(listOf("bad", "tool-result-image"), malformed)
    }

    @Test
    fun `user uploads never get a legacy source sidecar`() {
        val keys = RetentionKeys.messageKeys("user", listOf(ref("img", "customers/c1/attachments/img")), null)
        assertEquals(setOf("customers/c1/attachments/img"), keys.exact)
        assertTrue(keys.optional.isEmpty())
    }

    @Test
    fun `tool-result image keys are rewritten in place`() {
        val json = """[{"tool_call_id":"t","content":"x","images":[{"s3_key":"customers/c1/attachments/a","media_type":"image/png"}]}]"""
        val rewritten = RetentionKeys.rewriteToolResultImageKeys(
            json, mapOf("customers/c1/attachments/a" to "customers/c1/attachments/b")
        )
        assertEquals(listOf("customers/c1/attachments/b"), RetentionKeys.toolResultImageKeys(rewritten))
        assertTrue(rewritten.contains("\"tool_call_id\":\"t\""))
        assertEquals(emptyList(), RetentionKeys.toolResultImageKeys("not json"))
    }
}
