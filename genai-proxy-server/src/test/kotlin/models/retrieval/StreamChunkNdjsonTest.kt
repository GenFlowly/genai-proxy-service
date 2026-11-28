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
    fun `activity event embeds the raw object`() {
        val event = "{\"v\":2,\"at\":0,\"type\":\"turn.start\"}"
        assertEquals("{\"t\":\"ac\",\"v\":$event}\n", StreamChunk.Activity(event).toNdjsonFrame())
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
    fun `frames carry the seq of the event they came from`() {
        assertEquals("{\"t\":\"c\",\"v\":\"hi\",\"s\":12}\n", StreamChunk.Content("hi").toNdjsonFrame(12))
        assertEquals("{\"t\":\"cr\",\"s\":3}\n", StreamChunk.RunRestarted.toNdjsonFrame(3))
    }

    @Test
    fun `run frame names the run, its replay seq and the turn clock`() {
        assertEquals(
            "{\"t\":\"run\",\"v\":\"run_abc\",\"s\":5,\"ms\":41250}\n",
            StreamChunk.RunStarted("run_abc", 5, 41250).toNdjsonFrame()
        )
        assertEquals(
            "{\"t\":\"run\",\"v\":\"run_abc\",\"s\":0}\n",
            StreamChunk.RunStarted("run_abc", 0, null).toNdjsonFrame()
        )
    }

    @Test
    fun `position carries no frame of its own`() {
        assertNull(StreamChunk.Position(9).toNdjsonFrame())
    }

    @Test
    fun `framer stamps later frames with the latest position, done included`() {
        val framer = NdjsonFramer()
        assertEquals("{\"t\":\"run\",\"v\":\"r\",\"s\":4}\n", framer.frame(StreamChunk.RunStarted("r", 4, null)))
        assertNull(framer.frame(StreamChunk.Position(5)))
        assertEquals("{\"t\":\"c\",\"v\":\"a\",\"s\":5}\n", framer.frame(StreamChunk.Content("a")))
        assertEquals("{\"t\":\"sr\",\"v\":\"interrupted\",\"s\":5}\n", framer.frame(StreamChunk.StopReason("interrupted")))
        assertEquals("{\"t\":\"done\",\"status\":\"ok\",\"s\":5}\n", framer.done("ok"))
    }

    @Test
    fun `stateless frames carry no seq`() {
        val framer = NdjsonFramer()
        assertEquals("{\"t\":\"c\",\"v\":\"a\"}\n", framer.frame(StreamChunk.Content("a")))
        assertEquals("{\"t\":\"done\",\"status\":\"ok\"}\n", framer.done("ok"))
    }
}
