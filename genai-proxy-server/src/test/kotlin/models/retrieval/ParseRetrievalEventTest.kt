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
    fun `thinking maps to Thinking`() {
        assertEquals(StreamChunk.Thinking("pondering"), parse("""{"thinking":"pondering"}"""))
    }

    @Test
    fun `thinking_step keeps the raw object json`() {
        val chunk = parse("""{"thinking_step":{"node":"qa","name":"Query Analyzer","status":"running"}}""")
        assertTrue(chunk is StreamChunk.ThinkingStep)
        val stepJson = (chunk as StreamChunk.ThinkingStep).json
        // Round-trips as a JSON object carrying the node id
        assertEquals("qa", json.parseToJsonElement(stepJson).jsonObject["node"]!!.toString().trim('"'))
    }

    @Test
    fun `thinking_duration_ms maps to ThinkingDuration`() {
        assertEquals(StreamChunk.ThinkingDuration(4321L), parse("""{"thinking_duration_ms":4321}"""))
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

    // ── Failures win over every other key (durable-run terminal summaries) ──

    @Test
    fun `a terminal summary carrying generated_artifacts and an error yields the error`() {
        val chunk = parse(
            """{"status":"error","run_id":"run_1","customer_id":"c1","generated_response":null,
                "tool_calls":null,"generated_artifacts":[{"artifact_id":"a1","key":"k"}],
                "usage":{"input_tokens":1},"error":"timed out waiting for input","error_type":"resume_timeout"}"""
        )

        assertEquals(StreamChunk.Error("timed out waiting for input", "resume_timeout"), chunk)
    }

    @Test
    fun `a successful terminal summary still yields its generated_artifacts`() {
        val chunk = parse(
            """{"status":"completed","run_id":"run_1","generated_response":"ok","tool_calls":null,
                "generated_artifacts":[{"artifact_id":"a1","key":"k"}],"usage":{},"error":null,"error_type":null}"""
        )

        assertTrue(chunk is StreamChunk.GeneratedArtifacts)
        assertTrue("a1" in (chunk as StreamChunk.GeneratedArtifacts).json)
    }

    @Test
    fun `a terminal error status without error text still yields an error`() {
        val chunk = parse("""{"status":"error","generated_artifacts":[],"error":null,"error_type":null}""")

        assertEquals(StreamChunk.Error(RUN_FAILED_FALLBACK_MESSAGE, null), chunk)
    }

    @Test
    fun `a standalone run-failure row maps to Error`() {
        assertEquals(
            StreamChunk.Error("The response was interrupted.", "run_lost"),
            parse("""{"error":"The response was interrupted.","error_type":"run_lost"}""")
        )
    }

    @Test
    fun `an error wins over content keys in the same event`() {
        assertEquals(StreamChunk.Error("boom", null), parse("""{"content":"partial","error":"boom"}"""))
        assertEquals(StreamChunk.Error("boom", null), parse("""{"tool_calls":[{"id":"t1"}],"error":"boom"}"""))
    }

    @Test
    fun `a JSON null error_type reads as no type`() {
        assertEquals(StreamChunk.Error("boom", null), parse("""{"error":"boom","error_type":null}"""))
    }

    @Test
    fun `a null error does not hide the event's other keys`() {
        assertEquals(StreamChunk.Usage(10, 0, 0, 0, 0, 0), parse("""{"error":null,"usage":{"input_tokens":10}}"""))
        assertNull(parse("""{"error":null}"""))
    }

    // ── Progress and keepalives ─────────────────────────────────────────────

    @Test
    fun `progress keeps the raw object json`() {
        val chunk = parse("""{"progress":{"tool":"generate_pdf","chars":1234}}""")

        assertTrue(chunk is StreamChunk.Progress)
        val progress = json.parseToJsonElement((chunk as StreamChunk.Progress).json).jsonObject
        assertEquals("generate_pdf", progress["tool"]!!.toString().trim('"'))
        assertEquals("1234", progress["chars"]!!.toString())
    }

    @Test
    fun `progress that is not an object is skipped`() {
        assertNull(parse("""{"progress":null}"""))
        assertNull(parse("""{"progress":42}"""))
        assertNull(parse("""{"progress":[1]}"""))
    }

    @Test
    fun `keepalive maps to null`() {
        assertNull(parse("""{"keepalive":true}"""))
    }
}
