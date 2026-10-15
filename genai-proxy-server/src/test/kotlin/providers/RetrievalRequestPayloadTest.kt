package com.genflowly.providers

import com.genflowly.di.provideJson
import com.genflowly.models.AttachmentRef
import com.genflowly.models.Message
import com.genflowly.models.retrieval.FileOrigin
import com.genflowly.models.retrieval.toConversationMessage
import com.genflowly.models.retrieval.toFileRefs
import com.genflowly.models.retrieval.toImageRefs
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * The /retrieve and POST /runs request bodies carry the public RawData (3.1):
 * a request without files, locale or fs_namespace is byte-for-byte the payload
 * the private copies used to send, and files of the history and of the current
 * turn ride under `files`. Uses the Json the clients are given in production.
 */
class RetrievalRequestPayloadTest {

    private val json = provideJson()
    private val logger = KotlinLogging.logger("RetrievalRequestPayloadTest")
    private val url = "http://retrieval-server:5001"

    private val photo = AttachmentRef("img-1", "customers/c1/attachments/img-1", "image/png")
    private val brief = AttachmentRef(
        "up-1", "customers/c1/attachments/up-1", "application/pdf", filename = "Brief.pdf", sizeBytes = 2_048L
    )
    private val report = AttachmentRef(
        "art-1", "customers/c2/attachments/art-1", "application/pdf", filename = "Report.pdf", sizeBytes = 13_312L
    )

    private fun capturingClient(responseBody: String, contentType: String): Pair<HttpClient, MutableList<String>> {
        val bodies = mutableListOf<String>()
        val http = HttpClient(MockEngine { request ->
            bodies += (request.body as TextContent).text
            respond(responseBody, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, contentType))
        }) { install(HttpTimeout) }
        return http to bodies
    }

    private fun turn(role: String, text: String, attachments: List<AttachmentRef>) = Message(
        conversationId = "conv-1",
        text = text,
        attachments = attachments,
        client = "web",
        role = role,
        customerId = "c1",
        systemPrompt = "",
        aiConfig = emptyList(),
        previousMessageId = null
    )

    private fun obj(raw: String): JsonObject = json.parseToJsonElement(raw).jsonObject

    /** The body the private AgentRawData payload produced for this request. */
    private val legacyRetrieveBody = """
        {"customer_id":"cust-1","client":"web","data_type":"text",
         "raw_data":{"query_data":"what is this?",
                     "images":[{"s3_key":"customers/c1/attachments/img-1","media_type":"image/png"}]},
         "llm_credentials":{"anthropic_api_key":"sk-test"},
         "llm_provider":"anthropic","llm_model":"model-x","llm_max_tokens":4096,
         "conversation_history":[
           {"role":"user","content":"look","images":[{"s3_key":"customers/c1/attachments/img-1","media_type":"image/png"}]},
           {"role":"assistant","content":"A cat."}]}
    """.trimIndent()

    @Test
    fun `a request without files serializes exactly as before`() = runTest {
        val (http, bodies) = capturingClient("""{"generated_response":"ok"}""", "application/json")

        RetrievalServerClient(logger, json, http, url).retrieveAndGenerate(
            customerId = "cust-1",
            client = "web",
            query = "what is this?",
            llmCredentials = mapOf("anthropic_api_key" to "sk-test"),
            llmProvider = "anthropic",
            llmModel = "model-x",
            conversationHistory = listOf(
                turn("user", "look", listOf(photo)).toConversationMessage(),
                turn("assistant", "A cat.", emptyList()).toConversationMessage()
            ),
            queryImages = listOf(photo).toImageRefs(),
            queryFiles = listOf(photo).toFileRefs(FileOrigin.UPLOADED)
        )

        assertEquals(obj(legacyRetrieveBody), obj(bodies.single()))
    }

    @Test
    fun `history and current-turn files ride under files on the stream request`() = runTest {
        val (http, bodies) = capturingClient("data: [DONE]\n\n", "text/event-stream")

        RetrievalServerClient(logger, json, http, url).retrieveAndGenerateStream(
            customerId = "cust-1",
            client = "web",
            query = "compare the two",
            llmCredentials = mapOf("anthropic_api_key" to "sk-test"),
            llmProvider = "anthropic",
            llmModel = "model-x",
            conversationHistory = listOf(
                turn("user", "write a report", emptyList()).toConversationMessage(),
                turn("assistant", "Here it is.", listOf(report)).toConversationMessage()
            ),
            queryImages = listOf(photo, brief).toImageRefs(),
            queryFiles = listOf(photo, brief).toFileRefs(FileOrigin.UPLOADED)
        ).toList()

        val body = obj(bodies.single())
        val rawData = body["raw_data"]!!.jsonObject
        assertEquals(1, rawData["images"]!!.jsonArray.size)
        val current = rawData["files"]!!.jsonArray.single().jsonObject
        assertEquals("up-1", current["attachment_id"]!!.jsonPrimitive.content)
        assertEquals("uploaded", current["origin"]!!.jsonPrimitive.content)
        val history = body["conversation_history"]!!.jsonArray
        assertFalse("files" in history[0].jsonObject, "a turn without files carries no files key")
        val generated = history[1].jsonObject["files"]!!.jsonArray.single().jsonObject
        assertEquals("customers/c2/attachments/art-1", generated["s3_key"]!!.jsonPrimitive.content)
        assertEquals("generated", generated["origin"]!!.jsonPrimitive.content)
    }

    @Test
    fun `the durable start sends the same raw_data, with files only when there are some`() = runTest {
        val (http, bodies) = capturingClient("""{"run_id":"run_x"}""", "application/json")
        val runs = RunsClient(logger, json, http, url)

        runs.startRun(
            customerId = "cust-1", client = "web", query = "what is this?",
            llmProvider = "anthropic", llmModel = "model-x",
            queryImages = listOf(photo).toImageRefs()
        )
        runs.startRun(
            customerId = "cust-1", client = "web", query = "what is this?",
            llmProvider = "anthropic", llmModel = "model-x",
            queryImages = listOf(photo).toImageRefs(),
            queryFiles = listOf(brief).toFileRefs(FileOrigin.UPLOADED)
        )

        assertEquals(
            obj("""{"query_data":"what is this?","images":[{"s3_key":"customers/c1/attachments/img-1","media_type":"image/png"}]}"""),
            obj(bodies[0])["raw_data"]
        )
        val files = obj(bodies[1])["raw_data"]!!.jsonObject["files"]!!.jsonArray
        assertEquals("up-1", files.single().jsonObject["attachment_id"]!!.jsonPrimitive.content)
    }
}
