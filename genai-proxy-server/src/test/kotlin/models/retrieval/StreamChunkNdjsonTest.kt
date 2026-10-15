package com.genflowly.models.retrieval

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
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

    @Test
    fun `a parsed progress event round-trips into a pg frame`() {
        val chunk = parseRetrievalEvent(
            kotlinx.serialization.json.Json.parseToJsonElement("""{"progress":{"tool":"fs_write","chars":7}}""")
                as kotlinx.serialization.json.JsonObject
        )

        assertEquals("{\"t\":\"pg\",\"v\":{\"tool\":\"fs_write\",\"chars\":7}}\n", chunk?.toNdjsonFrame())
    }
}
