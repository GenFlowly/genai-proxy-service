package com.genflowly.models.retrieval

import com.genflowly.di.provideJson
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The proxy <-> retrieval-server file contract: FileRef, ConversationMessage
 * .files and the current turn's RawData (files, locale, fs_namespace) are
 * snake_case on the wire, and payloads without the new fields still parse and
 * serialize exactly as before. Uses the Json the retrieval clients use.
 */
class RetrievalExchangeModelsTest {

    private val json = provideJson()

    private val pdf = FileRef(
        attachmentId = "art-1",
        s3Key = "customers/c2/attachments/art-1",
        mediaType = "application/pdf",
        filename = "Report.pdf",
        sizeBytes = 13_312L,
        origin = FileOrigin.GENERATED
    )

    private fun obj(encoded: String): JsonObject = json.parseToJsonElement(encoded).jsonObject

    @Test
    fun `a FileRef serializes snake_case with its origin`() {
        val encoded = obj(json.encodeToString(pdf))

        assertEquals("art-1", encoded["attachment_id"]?.jsonPrimitive?.content)
        assertEquals("customers/c2/attachments/art-1", encoded["s3_key"]?.jsonPrimitive?.content)
        assertEquals("application/pdf", encoded["media_type"]?.jsonPrimitive?.content)
        assertEquals("Report.pdf", encoded["filename"]?.jsonPrimitive?.content)
        assertEquals("13312", encoded["size_bytes"]?.jsonPrimitive?.content)
        assertEquals("generated", encoded["origin"]?.jsonPrimitive?.content)
        assertEquals(pdf, json.decodeFromString<FileRef>(json.encodeToString(pdf)))
    }

    @Test
    fun `an uploaded FileRef without the optional fields parses`() {
        val ref = json.decodeFromString<FileRef>(
            """{"attachment_id":"up-1","s3_key":"customers/c1/attachments/up-1","media_type":"application/pdf","origin":"uploaded"}"""
        )

        assertEquals(FileOrigin.UPLOADED, ref.origin)
        assertNull(ref.filename)
        assertNull(ref.sizeBytes)
    }

    @Test
    fun `a ConversationMessage without files still parses and serializes as before`() {
        val legacy = """{"role":"assistant","content":"hi","images":[{"s3_key":"k","media_type":"image/png"}]}"""

        val parsed = json.decodeFromString<ConversationMessage>(legacy)

        assertEquals(emptyList(), parsed.files)
        assertEquals(obj(legacy), obj(json.encodeToString(parsed)))
    }

    @Test
    fun `ConversationMessage files ride under files`() {
        val encoded = obj(json.encodeToString(ConversationMessage(role = "assistant", content = "done", files = listOf(pdf))))

        val file = encoded["files"]!!.jsonArray.single().jsonObject
        assertEquals("art-1", file["attachment_id"]?.jsonPrimitive?.content)
        assertEquals("generated", file["origin"]?.jsonPrimitive?.content)
    }

    @Test
    fun `RawData without the new fields still parses and serializes as before`() {
        val legacy = """{"query_data":"summarise this","images":[{"s3_key":"k","media_type":"image/png"}]}"""

        val parsed = json.decodeFromString<RawData>(legacy)

        assertEquals("summarise this", parsed.queryData)
        assertEquals(3, parsed.topN)
        assertEquals(emptyList(), parsed.files)
        assertNull(parsed.locale)
        assertNull(parsed.fsNamespace)
        assertEquals(obj(legacy), obj(json.encodeToString(parsed)))
    }

    @Test
    fun `RawData carries files, locale and fs_namespace when set`() {
        val encoded = obj(
            json.encodeToString(
                RawData(
                    queryData = "q",
                    files = listOf(pdf.copy(origin = FileOrigin.UPLOADED)),
                    locale = "en-US",
                    fsNamespace = "ns-1234abcd"
                )
            )
        )

        assertEquals("q", encoded["query_data"]?.jsonPrimitive?.content)
        assertEquals("uploaded", encoded["files"]!!.jsonArray.single().jsonObject["origin"]?.jsonPrimitive?.content)
        assertEquals("en-US", encoded["locale"]?.jsonPrimitive?.content)
        assertEquals("ns-1234abcd", encoded["fs_namespace"]?.jsonPrimitive?.content)
        assertTrue("fsNamespace" !in encoded.keys)
    }
}
