package com.genflowly.service

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import software.amazon.awssdk.awscore.exception.AwsErrorDetails
import software.amazon.awssdk.services.dynamodb.model.DynamoDbException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

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

    // ── thinkingStepsToJson (1.9) ───────────────────────────────────────────

    private fun utf8Bytes(s: String) = s.toByteArray(Charsets.UTF_8).size

    /** A 45,000-character Chinese document: 135,000 UTF-8 bytes, copied into three places of the steps. */
    private val chineseDocument = "中文文档内容测试".repeat(45_000 / 8 + 1).take(45_000)

    private fun llmStepCallingGeneratePdf(document: String) = buildJsonObject {
        put("node", "writer"); put("name", "Writer"); put("kind", "LLM"); put("status", "done")
        put("detail", "Calling tools: generate_pdf(content_markdown=$document)")
        put("reasoning", "I will put the report into a PDF.")
        putJsonArray("tool_calls") {
            addJsonObject {
                put("name", "generate_pdf")
                putJsonObject("args") { put("content_markdown", document); put("filename", "报告.pdf") }
            }
        }
        put("prompt", "system prompt excerpt"); put("response", "response excerpt")
    }.toString()

    private fun toolStepThatRanGeneratePdf(document: String) = buildJsonObject {
        put("node", "tools"); put("name", "Tools"); put("kind", "TOOL"); put("status", "done")
        put("detail", "Executed 1 tool(s)")
        putJsonArray("calls") {
            addJsonObject {
                put("name", "generate_pdf")
                putJsonObject("args") { put("content_markdown", document) }
                putJsonArray("artifacts") { addJsonObject { put("artifact_id", "art-1"); put("filename", "报告.pdf") } }
                put("error", JsonNull)
            }
        }
        putJsonArray("items") { add("报告.pdf") }
    }.toString()

    @Test
    fun `a 45,000-character Chinese document stays within 300,000 UTF-8 bytes`() {
        val steps = listOf(llmStepCallingGeneratePdf(chineseDocument), toolStepThatRanGeneratePdf(chineseDocument))
        assertTrue(utf8Bytes(steps.joinToString(",")) > MAX_THINKING_STEPS_JSON_BYTES, "the raw steps are over budget")

        val json = thinkingStepsToJson(steps)

        assertNotNull(json)
        assertTrue(utf8Bytes(json) <= MAX_THINKING_STEPS_JSON_BYTES, "${utf8Bytes(json)} bytes")
        val (llm, tool) = elements(json)
        // Every step is kept with what the thinking panel shows; the document is gone.
        assertEquals(listOf("writer", "tools"), listOf(llm.str("node"), tool.str("node")))
        assertEquals("I will put the report into a PDF.", llm.str("reasoning"))
        assertEquals("generate_pdf", llm["tool_calls"]!!.jsonArray.single().jsonObject.str("name"))
        val call = tool["calls"]!!.jsonArray.single().jsonObject
        assertEquals("art-1", call["artifacts"]!!.jsonArray.single().jsonObject.str("artifact_id"))
        assertEquals("报告.pdf", tool["items"]!!.jsonArray.single().jsonPrimitive.content)
        for (dropped in listOf("detail", "prompt", "response")) {
            assertFalse(dropped in llm, dropped)
        }
        assertFalse("args" in llm["tool_calls"]!!.jsonArray.single().jsonObject)
        assertFalse("args" in call)
        assertFalse("中文文档内容测试" in json)
    }

    @Test
    fun `steps within budget are stored verbatim`() {
        val steps = listOf("""{"node":"n","prompt":"p","detail":"d"}""", """{"node":"m"}""")

        assertEquals("""[{"node":"n","prompt":"p","detail":"d"},{"node":"m"}]""", thinkingStepsToJson(steps))
        assertNull(thinkingStepsToJson(emptyList()))
    }

    @Test
    fun `the budget counts bytes, not characters`() {
        // 110,000 characters passed the old 250,000-character guard, yet are 330,000 bytes.
        val prompt = "汉".repeat(110_000)
        val json = thinkingStepsToJson(listOf("""{"node":"n","prompt":"$prompt"}"""))

        assertEquals("""[{"node":"n"}]""", json)
    }

    @Test
    fun `steps still over budget after stripping are not stored`() {
        val reasoning = "汉".repeat(110_000)

        assertNull(thinkingStepsToJson(listOf("""{"node":"n","reasoning":"$reasoning"}""")))
    }

    // ── isItemSizeLimitError (1.9) ──────────────────────────────────────────

    private fun dynamoError(code: String, message: String): DynamoDbException =
        DynamoDbException.builder()
            .message(message)
            .statusCode(400)
            .awsErrorDetails(AwsErrorDetails.builder().errorCode(code).errorMessage(message).build())
            .build() as DynamoDbException // statusCode() returns the base builder type

    @Test
    fun `DynamoDB's item size ValidationException is recognised, also when wrapped`() {
        val tooLarge = dynamoError("ValidationException", "Item size has exceeded the maximum allowed size")

        assertTrue(tooLarge.isItemSizeLimitError())
        assertTrue(IllegalStateException("write failed", tooLarge).isItemSizeLimitError())
    }

    @Test
    fun `other failures are not mistaken for the item size limit`() {
        assertFalse(dynamoError("ValidationException", "One or more parameter values were invalid").isItemSizeLimitError())
        assertFalse(dynamoError("ProvisionedThroughputExceededException", "Item size rate exceeded").isItemSizeLimitError())
        assertFalse(IllegalArgumentException("Item size has exceeded the maximum allowed size").isItemSizeLimitError())
    }
}
