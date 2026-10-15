package com.genflowly.service

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The file-level helpers of GenerationOrchestrator that shape what a streamed
 * turn persists.
 */
class GenerationOrchestratorHelpersTest {

    private fun elements(json: String): List<JsonObject> = Json.parseToJsonElement(json).jsonArray.map { it.jsonObject }
    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content

    // ── mergeJsonArrays (1.10) ──────────────────────────────────────────────

    @Test
    fun `the same artifact_id twice yields one element, the last one`() {
        val merged = mergeJsonArrays(
            """[{"artifact_id":"a1","filename":"draft.pdf"}]""",
            """[{"artifact_id":"a1","filename":"final.pdf"}]"""
        )

        assertEquals(listOf("final.pdf"), elements(merged).map { it.str("filename") })
    }

    @Test
    fun `a re-sent artifact keeps the position it first had`() {
        val merged = mergeJsonArrays(
            """[{"artifact_id":"a1","v":1},{"artifact_id":"b1"}]""",
            """[{"artifact_id":"c1"},{"artifact_id":"a1","v":2}]"""
        )

        assertEquals(listOf("a1", "b1", "c1"), elements(merged).map { it.str("artifact_id") })
        assertEquals("2", elements(merged).first().str("v"))
    }

    @Test
    fun `duplicates inside the first array are folded too`() {
        val merged = mergeJsonArrays(null, """[{"artifact_id":"a1"},{"artifact_id":"a1"}]""")

        assertEquals(1, elements(merged).size)
    }

    @Test
    fun `entries without an artifact_id are all kept`() {
        val merged = mergeJsonArrays("""[{"name":"x"}]""", """[{"name":"x"},{"artifact_id":null}]""")

        assertEquals(3, elements(merged).size)
    }

    @Test
    fun `an unreadable incoming value never drops the files captured so far`() {
        val captured = """[{"artifact_id":"a1"}]"""

        assertEquals(captured, mergeJsonArrays(captured, "not json"))
        assertEquals(captured, mergeJsonArrays(captured, """{"artifact_id":"a2"}"""))
        assertEquals("not json", mergeJsonArrays(null, "not json"))
    }

    @Test
    fun `an unreadable earlier value gives way to the incoming array`() {
        assertEquals(listOf("a2"), elements(mergeJsonArrays("garbage", """[{"artifact_id":"a2"}]""")).map { it.str("artifact_id") })
    }
}
