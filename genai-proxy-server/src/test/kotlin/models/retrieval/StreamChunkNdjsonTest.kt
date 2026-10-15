package com.genflowly.models.retrieval

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Pins the StreamChunk → NDJSON wire protocol shared by the live and reattach streams. */
class StreamChunkNdjsonTest {

    @Test
    fun `content frame`() {
        assertEquals("{\"t\":\"c\",\"v\":\"hi\"}\n", StreamChunk.Content("hi").toNdjsonFrame())
    }

    @Test
    fun `content escapes quotes and newlines`() {
        assertEquals("{\"t\":\"c\",\"v\":\"a\\\"b\\nc\"}\n", StreamChunk.Content("a\"b\nc").toNdjsonFrame())
    }

    @Test
    fun `content reset frame carries no value`() {
        assertEquals("{\"t\":\"cr\"}\n", StreamChunk.ContentReset.toNdjsonFrame())
    }

    @Test
    fun `stop reason frame carries the reason`() {
        assertEquals("{\"t\":\"sr\",\"v\":\"max_tokens\"}\n", StreamChunk.StopReason("max_tokens").toNdjsonFrame())
    }

    @Test
    fun `thinking step embeds raw object`() {
        assertEquals("{\"t\":\"ks\",\"v\":{\"node\":\"n\"}}\n", StreamChunk.ThinkingStep("{\"node\":\"n\"}").toNdjsonFrame())
    }

    @Test
    fun `thinking duration is a number`() {
        assertEquals("{\"t\":\"kd\",\"v\":1200}\n", StreamChunk.ThinkingDuration(1200L).toNdjsonFrame())
    }

    @Test
    fun `awaiting input frame embeds raw payload`() {
        assertEquals(
            "{\"t\":\"ai\",\"v\":{\"type\":\"human_input\",\"prompt\":\"Approve?\"}}\n",
            StreamChunk.AwaitingInput("{\"type\":\"human_input\",\"prompt\":\"Approve?\"}").toNdjsonFrame()
        )
    }

    @Test
    fun `error frame carries the message`() {
        assertEquals("{\"t\":\"err\",\"v\":\"boom\"}\n", StreamChunk.Error("boom", "provider_error").toNdjsonFrame())
    }

    @Test
    fun `generated files frame keeps the display fields and drops both S3 keys`() {
        val artifacts = """[{"artifact_id":"a1","key":"customers/c1/attachments/a1","media_type":"application/pdf",
            "filename":"Report.pdf","size_bytes":13312,"source_key":"customers/c1/attachments/a1.source.md",
            "page_count":7}]"""

        assertEquals(
            "{\"t\":\"ga\",\"v\":[{\"artifact_id\":\"a1\",\"media_type\":\"application/pdf\"," +
                "\"filename\":\"Report.pdf\",\"size_bytes\":13312,\"page_count\":7}]}\n",
            StreamChunk.GeneratedArtifacts(artifacts).toNdjsonFrame()
        )
    }

    @Test
    fun `generated files frame passes only the known display fields of every artifact`() {
        val artifacts = """[{"artifact_id":"a1","key":"k1","media_type":"application/pdf","internal":"x"},
            {"artifact_id":"a2","key":"k2","filename":"b.pdf","page_count":null}, 42]"""

        assertEquals(
            "{\"t\":\"ga\",\"v\":[{\"artifact_id\":\"a1\",\"media_type\":\"application/pdf\"}," +
                "{\"artifact_id\":\"a2\",\"filename\":\"b.pdf\",\"page_count\":null}]}\n",
            StreamChunk.GeneratedArtifacts(artifacts).toNdjsonFrame()
        )
    }

    @Test
    fun `an unreadable generated files payload relays an empty list`() {
        listOf("""{"artifact_id":"a1","key":"k"}""", "not json", """[{"key":"k"""").forEach {
            assertEquals("{\"t\":\"ga\",\"v\":[]}\n", StreamChunk.GeneratedArtifacts(it).toNdjsonFrame(), it)
        }
    }

    @Test
    fun `usage produces no client frame`() {
        assertNull(StreamChunk.Usage(1, 2, 3, 0, 0).toNdjsonFrame())
    }

    @Test
    fun `progress frame embeds the raw object`() {
        assertEquals(
            "{\"t\":\"pg\",\"v\":{\"tool\":\"generate_pdf\",\"chars\":1234}}\n",
            StreamChunk.Progress("{\"tool\":\"generate_pdf\",\"chars\":1234}").toNdjsonFrame()
        )
    }

    // ── Keepalives during silences (1.7, contract C4) ───────────────────────

    @Test
    fun `a silence gets a whitespace-only line every interval`() = runTest {
        val frames = flow {
            emit("a\n")
            delay(40_000)
            emit("b\n")
        }.withKeepalives(15_000).toList()

        assertEquals(listOf("a\n", " \n", " \n", "b\n"), frames)
    }

    @Test
    fun `the wait before the first frame is covered too`() = runTest {
        val frames = flow {
            delay(20_000)
            emit("a\n")
        }.withKeepalives(15_000).toList()

        assertEquals(listOf(" \n", "a\n"), frames)
    }

    @Test
    fun `frames closer together than the interval get no keepalive`() = runTest {
        val frames = flow {
            repeat(6) {
                emit("f$it\n")
                delay(10_000)
            }
        }.withKeepalives(15_000).toList()

        assertEquals((0 until 6).map { "f$it\n" }, frames)
    }

    @Test
    fun `a failing frame flow still fails`() = runTest {
        val failure = runCatching {
            flow<String> {
                emit("a\n")
                throw IllegalStateException("boom")
            }.withKeepalives(15_000).toList()
        }.exceptionOrNull()

        assertEquals("boom", failure?.message)
    }

    @Test
    fun `the keepalive line is blank once trimmed, which the web app skips`() {
        assertEquals("", NDJSON_KEEPALIVE.trim())
        assertTrue(NDJSON_KEEPALIVE.endsWith("\n"))
    }

    @Test
    fun `a parsed progress event round-trips into a pg frame`() {
        val chunk = parseRetrievalEvent(
            kotlinx.serialization.json.Json.parseToJsonElement("""{"progress":{"tool":"fs_write","chars":7}}""")
                as kotlinx.serialization.json.JsonObject
        )

        assertEquals("{\"t\":\"pg\",\"v\":{\"tool\":\"fs_write\",\"chars\":7}}\n", chunk?.toNdjsonFrame())
    }
}
