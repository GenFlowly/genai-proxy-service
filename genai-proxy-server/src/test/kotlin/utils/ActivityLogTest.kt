package com.genflowly.utils

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The persisted activity log shares a 400 KB DynamoDB item with its message:
 * an oversized log is shrunk in a fixed order and stops at the first step
 * that fits, so the story and the evidence survive.
 */
class ActivityLogTest {

    private fun sources(n: Int) = (1..n).joinToString(",", "[", "]") {
        """{"index":$it,"title":"Result $it","url":"https://site$it.example/page"}"""
    }

    private val memoryEnd = """{"v":2,"at":1,"type":"step.end","id":"m:1","kind":"memory","node":"m","name":"Memory","duration_ms":1,"counts":{"core":1,"recalled":0},"memories":{"core":["${"m".repeat(400)}"],"recalled":[]}}"""
    private val llmEnd = """{"v":2,"at":2,"type":"step.end","id":"g:1","kind":"llm","node":"g","name":"Agent","duration_ms":1,"outcome":"tool_calls","reasoning":"why","developer":{"prompt_excerpt":"${"p".repeat(1500)}"}}"""
    private fun toolsEnd(sourceCount: Int, argChars: Int = 10) =
        """{"v":2,"at":3,"type":"step.end","id":"t:1","kind":"tools","node":"t","name":"Tools","duration_ms":1,"calls":[{"id":"c","seq":1,"name":"web_search","args":{"query":"${"q".repeat(argChars)}"},"mode":"run","result_excerpt":"${"e".repeat(200)}","sources":${sources(sourceCount)}}]}"""

    private fun parsed(text: String?): List<JsonObject> = Json.parseToJsonElement(text!!).jsonArray.map { it.jsonObject }
    private fun call(log: List<JsonObject>) = log.first { it["kind"]?.jsonPrimitive?.content == "tools" }["calls"]!!.jsonArray[0].jsonObject

    @Test
    fun `no events persists nothing`() {
        assertNull(ActivityLog.toPersistedJson(emptyList()))
    }

    @Test
    fun `a log that fits is stored verbatim`() {
        val events = listOf(memoryEnd, llmEnd, toolsEnd(3))
        assertEquals(events.joinToString(",", "[", "]"), ActivityLog.toPersistedJson(events))
    }

    @Test
    fun `developer excerpts go first`() {
        val events = listOf(memoryEnd, llmEnd, toolsEnd(3))
        val full = events.joinToString(",", "[", "]").length
        val out = parsed(ActivityLog.toPersistedJson(events, maxChars = full - 100))
        assertFalse(out.any { "developer" in it })
        assertTrue("result_excerpt" in call(out))
        assertTrue("memories" in out[0])
    }

    @Test
    fun `then result excerpts, then sources beyond ten, then long arguments`() {
        val events = listOf(llmEnd, toolsEnd(40, argChars = 2000))
        val withoutDeveloper = JsonArray(parsed(events.joinToString(",", "[", "]")).map { JsonObject(it - "developer") }).toString().length

        val noExcerpt = parsed(ActivityLog.toPersistedJson(events, maxChars = withoutDeveloper - 50))
        assertFalse("result_excerpt" in call(noExcerpt))
        assertEquals(40, call(noExcerpt)["sources"]!!.jsonArray.size)

        // Capping the sources is enough here, so the long query stays whole.
        val capped = parsed(ActivityLog.toPersistedJson(events, maxChars = 3000))
        assertEquals(ActivityLog.MAX_SOURCES_PER_CALL, call(capped)["sources"]!!.jsonArray.size)
        assertEquals(2000, call(capped)["args"]!!.jsonObject["query"]!!.jsonPrimitive.content.length)

        val truncated = parsed(ActivityLog.toPersistedJson(events, maxChars = 1800))
        val query = call(truncated)["args"]!!.jsonObject["query"]!!.jsonPrimitive.content
        assertEquals(ActivityLog.MAX_ARG_CHARS + 1, query.length)
        assertTrue(query.endsWith("…"))
        assertEquals("why", truncated.first { it["kind"]?.jsonPrimitive?.content == "llm" }["reasoning"]!!.jsonPrimitive.content)
    }

    @Test
    fun `memory texts are the last resort and their counts stay`() {
        val out = parsed(ActivityLog.toPersistedJson(listOf(memoryEnd, toolsEnd(2)), maxChars = 300))
        assertFalse("memories" in out[0])
        assertEquals("""{"core":1,"recalled":0}""", out[0]["counts"].toString())
    }
}
