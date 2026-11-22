package com.genflowly.models.retrieval

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Pins the retrieval-server SSE event → StreamChunk mapping extracted from
 * RetrievalServerClient. Both the streaming /retrieve reader and the future
 * durable /runs reattach stream depend on this being exact.
 */
class ParseRetrievalEventTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun parse(raw: String): StreamChunk? =
        parseRetrievalEvent(json.parseToJsonElement(raw).jsonObject)

    @Test
    fun `content maps to Content`() {
        val chunk = parse("""{"content":"hello"}""")
        assertEquals(StreamChunk.Content("hello"), chunk)
    }

    @Test
    fun `empty content is skipped`() {
        assertNull(parse("""{"content":""}"""))
    }

    @Test
    fun `content_reset maps to ContentReset`() {
        assertEquals(StreamChunk.ContentReset, parse("""{"content_reset":true}"""))
    }

    @Test
    fun `stop_reason maps to StopReason`() {
        assertEquals(StreamChunk.StopReason("refusal"), parse("""{"stop_reason":"refusal"}"""))
    }

    @Test
    fun `blank stop_reason is skipped`() {
        assertNull(parse("""{"stop_reason":"  "}"""))
    }

    @Test
    fun `activity keeps the raw event object json`() {
        val chunk = parse("""{"activity":{"v":2,"at":400,"type":"step.start","id":"N:1","kind":"llm","node":"N","name":"Agent"}}""")
        assertTrue(chunk is StreamChunk.Activity)
        val event = json.parseToJsonElement((chunk as StreamChunk.Activity).json).jsonObject
        assertEquals("step.start", event["type"]!!.toString().trim('"'))
        assertEquals("N:1", event["id"]!!.toString().trim('"'))
    }

    @Test
    fun `an activity payload that is not an object is skipped`() {
        assertNull(parse("""{"activity":null}"""))
        assertNull(parse("""{"activity":"step.start"}"""))
    }

    @Test
    fun `the retired thinking keys are no longer recognized`() {
        assertNull(parse("""{"thinking":"pondering"}"""))
        assertNull(parse("""{"thinking_step":{"node":"qa"}}"""))
        assertNull(parse("""{"thinking_duration_ms":4321}"""))
    }

    @Test
    fun `awaiting_input keeps the raw payload json`() {
        val chunk = parse("""{"awaiting_input":{"type":"human_input","node":"HITL","prompt":"Approve?"}}""")
        assertTrue(chunk is StreamChunk.AwaitingInput)
        val payload = (chunk as StreamChunk.AwaitingInput).json
        assertEquals("HITL", json.parseToJsonElement(payload).jsonObject["node"]!!.toString().trim('"'))
    }

    @Test
    fun `null awaiting_input is skipped`() {
        assertNull(parse("""{"awaiting_input":null}"""))
    }

    @Test
    fun `tool_calls keeps the raw array json`() {
        val chunk = parse("""{"tool_calls":[{"id":"t1","name":"computer","args":{"action":"screenshot"}}]}""")
        assertTrue(chunk is StreamChunk.ToolCalls)
        assertTrue("computer" in (chunk as StreamChunk.ToolCalls).json)
    }

    @Test
    fun `web_sources keeps the raw array json`() {
        val chunk = parse("""{"web_sources":[{"index":1,"title":"T","url":"https://x"}]}""")
        assertTrue(chunk is StreamChunk.WebSources)
        assertTrue("https://x" in (chunk as StreamChunk.WebSources).json)
    }

    @Test
    fun `generated_artifacts keeps the raw array json`() {
        val chunk = parse("""{"generated_artifacts":[{"artifact_id":"a1","key":"k","media_type":"application/pdf"}]}""")
        assertTrue(chunk is StreamChunk.GeneratedArtifacts)
        assertTrue("a1" in (chunk as StreamChunk.GeneratedArtifacts).json)
    }

    @Test
    fun `null array-valued events are skipped`() {
        assertNull(parse("""{"tool_calls":null}"""))
        assertNull(parse("""{"web_sources":null}"""))
        assertNull(parse("""{"generated_artifacts":null}"""))
    }

    @Test
    fun `error maps to Error with type`() {
        val chunk = parse("""{"error":"quota exceeded","error_type":"rate_limit"}""")
        assertEquals(StreamChunk.Error("quota exceeded", "rate_limit"), chunk)
    }

    @Test
    fun `error without type maps to Error with null type`() {
        assertEquals(StreamChunk.Error("boom", null), parse("""{"error":"boom"}"""))
    }

    @Test
    fun `blank error is skipped`() {
        assertNull(parse("""{"error":"  "}"""))
    }

    @Test
    fun `usage maps to Usage with all buckets`() {
        val chunk = parse(
            """{"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30,"cache_read_tokens":5,"cache_creation_tokens":2,"reasoning_tokens":7}}"""
        )
        assertEquals(StreamChunk.Usage(10, 20, 30, 5, 2, 7), chunk)
    }

    @Test
    fun `usage defaults missing buckets to zero`() {
        assertEquals(StreamChunk.Usage(0, 0, 0, 0, 0, 0), parse("""{"usage":{}}"""))
    }

    @Test
    fun `unknown event key returns null`() {
        assertNull(parse("""{"heartbeat":true}"""))
        assertNull(parse("""{}"""))
    }
}
