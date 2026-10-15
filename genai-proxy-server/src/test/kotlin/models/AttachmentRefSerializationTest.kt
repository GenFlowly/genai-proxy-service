package com.genflowly.models

import io.ktor.serialization.kotlinx.json.DefaultJson
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * The AttachmentRef JSON the clients see and send (via the server's Ktor
 * DefaultJson): display fields go both ways, sourceKey never does, and the
 * three-field shape older clients send still parses.
 */
class AttachmentRefSerializationTest {

    private val lenientJson = Json { ignoreUnknownKeys = true }

    private val ref = AttachmentRef(
        attachmentId = "art-1",
        s3Key = "customers/c1/attachments/art-1",
        mediaType = "application/pdf",
        filename = "Report.pdf",
        sizeBytes = 13_312L,
        sourceKey = "customers/c1/attachments/art-1.source.md",
        pageCount = 7
    )

    @Test
    fun `display fields are serialized and sourceKey is not`() {
        val obj = DefaultJson.parseToJsonElement(DefaultJson.encodeToString(ref)).jsonObject

        assertEquals(setOf("attachmentId", "s3Key", "mediaType", "filename", "sizeBytes", "pageCount"), obj.keys)
    }

    @Test
    fun `a client payload with the display fields parses`() {
        val parsed = DefaultJson.decodeFromString<AttachmentRef>(
            """{"attachmentId":"up-1","s3Key":"customers/c1/attachments/up-1","mediaType":"image/png",
                "filename":"photo.png","sizeBytes":2048,"pageCount":null}"""
        )

        assertEquals(
            AttachmentRef("up-1", "customers/c1/attachments/up-1", "image/png", filename = "photo.png", sizeBytes = 2048L),
            parsed
        )
    }

    @Test
    fun `the three-field shape older clients send still parses`() {
        val parsed = DefaultJson.decodeFromString<AttachmentRef>(
            """{"attachmentId":"up-1","s3Key":"customers/c1/attachments/up-1","mediaType":"image/png"}"""
        )

        assertNull(parsed.filename)
        assertNull(parsed.sizeBytes)
        assertNull(parsed.pageCount)
    }

    @Test
    fun `a client cannot set sourceKey`() {
        val withSourceKey =
            """{"attachmentId":"up-1","s3Key":"customers/c1/attachments/up-1","mediaType":"image/png",
                "sourceKey":"customers/someone-else/attachments/x"}"""

        // The server's strict parser rejects the unknown key outright...
        assertFailsWith<SerializationException> { DefaultJson.decodeFromString<AttachmentRef>(withSourceKey) }
        // ...and a lenient one drops it
        assertNull(lenientJson.decodeFromString<AttachmentRef>(withSourceKey).sourceKey)
        assertFalse("sourceKey" in DefaultJson.encodeToString(ref.copy(sourceKey = "x")))
    }
}
