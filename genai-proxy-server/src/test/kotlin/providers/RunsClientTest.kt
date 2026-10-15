package com.genflowly.providers

import com.genflowly.models.retrieval.StreamChunk
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.client.plugins.HttpRequestRetry
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * RunsClient over a Ktor MockEngine. Pins the durable-run contract: the start
 * payload never carries credentials (§5.5), run_id is parsed, and the reattach
 * SSE stream yields the shared StreamChunk vocabulary and stops at [DONE].
 */
class RunsClientTest {

    private val json = Json { ignoreUnknownKeys = true }
    private val logger = KotlinLogging.logger("RunsClientTest")

    private fun client(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): Pair<RunsClient, MutableList<HttpRequestData>> {
        val captured = mutableListOf<HttpRequestData>()
        val engine = MockEngine { req ->
            captured += req
            handler(req)
        }
        val http = HttpClient(engine) { install(HttpTimeout) }
        return RunsClient(logger, json, http, "http://retrieval-server:5001") to captured
    }

    /** A RunsClient whose re-attach backoff and deadline are milliseconds, so tests run fast. */
    private fun fastClient(handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): Pair<RunsClient, MutableList<HttpRequestData>> {
        val captured = mutableListOf<HttpRequestData>()
        val http = HttpClient(MockEngine { req ->
            captured += req
            handler(req)
        }) { install(HttpTimeout) }
        val runs = RunsClient(
            logger, json, http, "http://retrieval-server:5001",
            reattachBackoffMs = listOf(1L, 2L), reattachDeadlineMs = 250L
        )
        return runs to captured
    }

    private fun MockRequestHandleScope.sse(body: String) =
        respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "text/event-stream"))

    private fun MockRequestHandleScope.status(status: String) =
        respond("""{"run_id":"run_1","status":"$status","last_seq":0}""", HttpStatusCode.OK,
            headersOf(HttpHeaders.ContentType, "application/json"))

    private fun event(id: Int, json: String) = "id: $id\ndata: $json\n\n"
    private fun content(id: Int, text: String) = event(id, """{"content":"$text"}""")
    private fun completed(id: Int) =
        event(id, """{"status":"completed","run_id":"run_1","generated_response":"x","generated_artifacts":[],"error":null}""")
    private val done = "data: [DONE]\n\n"

    private fun HttpRequestData.isStream() = url.encodedPath == "/runs/run_1/stream"
    private fun HttpRequestData.isStatus() = method == HttpMethod.Get && url.encodedPath == "/runs/run_1"
    private fun List<HttpRequestData>.streamFroms() = filter { it.isStream() }.map { it.url.parameters["from_seq"] }
    private fun List<StreamChunk>.text() = filterIsInstance<StreamChunk.Content>().joinToString("") { it.text }
    private val streamLost = StreamChunk.Error(
        "The response was interrupted before it finished. Please try again.", "stream_lost"
    )

    @Test
    fun `startRun posts to runs, omits credentials, and returns run_id`() = runTest {
        val (runs, captured) = client {
            respond(
                content = """{"run_id":"run_abc"}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json")
            )
        }

        val runId = runs.startRun(
            customerId = "cust-1", client = "REACT_APP", query = "hello",
            llmProvider = "anthropic", llmModel = "claude-sonnet-4-6",
            graphId = "GRAPH1"
        )

        assertEquals("run_abc", runId)
        val req = captured.single()
        assertEquals(HttpMethod.Post, req.method)
        assertEquals("/runs", req.url.encodedPath)
        val body = (req.body as TextContent).text
        // The §5.5 guarantee: credentials never leave the proxy on the durable path.
        assertFalse(body.contains("llm_credentials"), "durable run body must not contain credentials")
        assertFalse(body.contains("stream"), "durable runs are always streamed; no stream flag")
        assertTrue(body.contains("\"llm_provider\":\"anthropic\""))
        assertTrue(body.contains("\"graph_id\":\"GRAPH1\""))
        assertTrue(body.contains("\"query_data\":\"hello\""))
    }

    @Test
    fun `startRun returns null on server error`() = runTest {
        val (runs, _) = client { respondError(HttpStatusCode.ServiceUnavailable) }
        val runId = runs.startRun(
            customerId = "c", client = "x", query = "q",
            llmProvider = "openai", llmModel = "gpt-4o"
        )
        assertNull(runId)
    }

    @Test
    fun `streamRun parses SSE into StreamChunks and stops at DONE`() = runTest {
        val sse = buildString {
            append("data: {\"thinking_step\":{\"node\":\"n\"}}\n\n")
            append("data: {\"content\":\"Hello\"}\n\n")
            append("data: {\"content\":\" world\"}\n\n")
            append("data: {\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}\n\n")
            append("data: {\"status\":\"completed\"}\n\n") // no recognized key -> skipped
            append("data: [DONE]\n\n")
            append("data: {\"content\":\"after done\"}\n\n") // must NOT be emitted
        }
        val (runs, captured) = client {
            respond(content = sse, status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"))
        }

        val chunks = runs.streamRun("run_abc", fromSeq = 5).toList()

        assertEquals("/runs/run_abc/stream", captured.single().url.encodedPath)
        assertEquals("5", captured.single().url.parameters["from_seq"])
        assertEquals(4, chunks.size)
        assertTrue(chunks[0] is StreamChunk.ThinkingStep)
        assertEquals(StreamChunk.Content("Hello"), chunks[1])
        assertEquals(StreamChunk.Content(" world"), chunks[2])
        assertEquals(StreamChunk.Usage(1, 2, 3, 0, 0), chunks[3])
    }

    @Test
    fun `cancelRun and resumeRun report transport success`() = runTest {
        val (runs, captured) = client {
            respond(content = """{"run_id":"r","status":"cancelled"}""", status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"))
        }
        assertTrue(runs.cancelRun("r"))
        assertTrue(runs.resumeRun("r", """{"results":[]}"""))
        assertEquals("/runs/r/cancel", captured[0].url.encodedPath)
        assertEquals("/runs/r/resume", captured[1].url.encodedPath)
    }

    @Test
    fun `getRunStatus parses status and last_seq`() = runTest {
        val (runs, _) = client {
            respond(content = """{"run_id":"r","status":"SUCCESS","last_seq":12}""",
                status = HttpStatusCode.OK, headers = headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val status = runs.getRunStatus("r")
        assertEquals("SUCCESS", status?.status)
        assertEquals(12L, status?.lastSeq)
        assertTrue(status!!.isOver)
    }

    @Test
    fun `getRunStatus tells an unknown run from an unreachable server`() = runTest {
        val (unknown, _) = client { respondError(HttpStatusCode.NotFound) }
        val (failing, _) = client { respondError(HttpStatusCode.ServiceUnavailable) }
        val (running, _) = client {
            respond("""{"run_id":"r","status":"PENDING","last_seq":3,"error":null}""", HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"))
        }

        val notFound = unknown.getRunStatus("r")!!
        assertTrue(notFound.notFound && notFound.isOver)
        assertNull(failing.getRunStatus("r"))
        val pending = running.getRunStatus("r")!!
        assertFalse(pending.isOver)
        assertNull(pending.error, "a JSON null error is no error text")
    }

    // ── Run ids (0.3) ───────────────────────────────────────────────────────

    private fun runIdOf(request: HttpRequestData) =
        json.parseToJsonElement((request.body as TextContent).text).jsonObject["run_id"]!!.jsonPrimitive.content

    @Test
    fun `startRun mints one run_id per call and HTTP retries resend it`() = runTest {
        val posts = mutableListOf<HttpRequestData>()
        val http = HttpClient(MockEngine { req ->
            posts += req
            if (posts.size == 1) {
                respondError(HttpStatusCode.ServiceUnavailable)
            } else {
                respond("""{"run_id":"${runIdOf(req)}"}""", HttpStatusCode.OK,
                    headersOf(HttpHeaders.ContentType, "application/json"))
            }
        }) {
            install(HttpTimeout)
            // As the shared client in Modules.kt: 5xx responses are retried.
            install(HttpRequestRetry) {
                retryOnServerErrors(maxRetries = 3)
                constantDelay(millis = 1, randomizationMs = 0)
            }
        }
        val runs = RunsClient(logger, json, http, "http://retrieval-server:5001")

        val first = runs.startRun(customerId = "c", client = "x", query = "q", llmProvider = "openai", llmModel = "m")
        val second = runs.startRun(customerId = "c", client = "x", query = "q", llmProvider = "openai", llmModel = "m")

        assertEquals(3, posts.size, "one retried POST, then one POST")
        assertEquals(runIdOf(posts[0]), runIdOf(posts[1]), "the retry carries the same run_id")
        assertEquals(runIdOf(posts[0]), first)
        assertTrue(Regex("^run_[0-9a-f]{32}$").matches(first!!), first)
        assertNotEquals(first, second, "every start gets its own run")
    }

    @Test
    fun `a start whose response was lost follows the run if it exists`() = runTest {
        var minted: String? = null
        val (runs, _) = client { req ->
            if (req.method == HttpMethod.Post) {
                minted = runIdOf(req)
                throw java.io.IOException("Connection reset")
            }
            respond("""{"run_id":"$minted","status":"PENDING","last_seq":0}""", HttpStatusCode.OK,
                headersOf(HttpHeaders.ContentType, "application/json"))
        }

        val runId = runs.startRun(customerId = "c", client = "x", query = "q", llmProvider = "p", llmModel = "m")

        assertTrue(minted != null)
        assertEquals(minted, runId)
    }

    @Test
    fun `a start whose response was lost gives up when the run does not exist`() = runTest {
        val (runs, _) = client { req ->
            if (req.method == HttpMethod.Post) throw java.io.IOException("Connection reset")
            respondError(HttpStatusCode.NotFound)
        }

        assertNull(runs.startRun(customerId = "c", client = "x", query = "q", llmProvider = "p", llmModel = "m"))
    }

    // ── Re-attach (0.3) ─────────────────────────────────────────────────────

    @Test
    fun `a stream dropped after two events is re-attached from seq 2 and yields the text once`() = runTest {
        var streams = 0
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() && ++streams == 1 -> sse(content(1, "Hel") + content(2, "lo")) // EOF, no [DONE]
                req.isStream() -> sse(content(3, " world") + completed(4) + done)
                req.isStatus() -> status("PENDING")
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(listOf("0", "2"), captured.streamFroms())
        assertEquals("Hello world", chunks.text())
        assertTrue(chunks.none { it is StreamChunk.Error }, chunks.toString())
    }

    @Test
    fun `DONE without a terminal event re-attaches`() = runTest {
        var streams = 0
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() && ++streams == 1 -> sse(content(1, "a") + done) // the tail's idle cap
                req.isStream() -> sse(content(2, "b") + completed(3) + done)
                req.isStatus() -> status("PENDING")
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(listOf("0", "1"), captured.streamFroms())
        assertEquals("ab", chunks.text())
        assertTrue(chunks.none { it is StreamChunk.Error })
    }

    @Test
    fun `a non-2xx response and a timeout are re-attached`() = runTest {
        var streams = 0
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() && ++streams == 1 -> respondError(HttpStatusCode.ServiceUnavailable)
                req.isStream() && streams == 2 -> throw java.net.SocketTimeoutException("Socket timeout has expired")
                req.isStream() -> sse(content(1, "ok") + completed(2) + done)
                req.isStatus() -> respondError(HttpStatusCode.ServiceUnavailable) // restarting: status unknown
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(listOf("0", "0", "0"), captured.streamFroms())
        assertEquals("ok", chunks.text())
        assertTrue(chunks.none { it is StreamChunk.Error })
    }

    @Test
    fun `a run that never ends past the deadline yields the stream-lost error`() = runTest {
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() -> sse(done)
                req.isStatus() -> status("PENDING")
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(listOf<StreamChunk>(streamLost), chunks)
        assertTrue(captured.count { it.isStream() } > 2, "re-attached until the deadline")
        assertTrue(captured.any { it.isStatus() }, "checked the run's status between attempts")
    }

    @Test
    fun `a run reported finished is drained once more, then given up without a terminal event`() = runTest {
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() -> sse(done)
                req.isStatus() -> status("MAX_RECOVERY_ATTEMPTS_EXCEEDED")
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(listOf<StreamChunk>(streamLost), chunks)
        assertEquals(2, captured.count { it.isStream() })
    }

    @Test
    fun `the drain of a finished run delivers its remaining events`() = runTest {
        var streams = 0
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() && ++streams == 1 -> sse(content(1, "a")) // the server restarted
                req.isStream() -> sse(content(2, "b") + completed(3) + done)
                req.isStatus() -> status("SUCCESS")
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(listOf("0", "1"), captured.streamFroms())
        assertEquals("ab", chunks.text())
        assertTrue(chunks.none { it is StreamChunk.Error })
    }

    @Test
    fun `an unknown run is given up at once`() = runTest {
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() -> sse(done)
                req.isStatus() -> respondError(HttpStatusCode.NotFound)
                else -> error("unexpected ${req.url}")
            }
        }

        assertEquals(listOf<StreamChunk>(streamLost), runs.streamRun("run_1").toList())
        assertEquals(1, captured.count { it.isStream() })
    }

    @Test
    fun `a failed run's error rows reach the caller in order and end the stream`() = runTest {
        val (runs, captured) = fastClient { req ->
            when {
                req.isStream() -> sse(
                    content(1, "partial") +
                        event(2, """{"error":"This response stopped because it waited too long for your input.","error_type":"resume_timeout"}""") +
                        event(3, """{"status":"error","run_id":"run_1","error":"This response stopped because it waited too long for your input.","error_type":"resume_timeout","generated_artifacts":[]}""") +
                        done
                )
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        val resumeTimeout = StreamChunk.Error("This response stopped because it waited too long for your input.", "resume_timeout")
        assertEquals(listOf(StreamChunk.Content("partial"), resumeTimeout, resumeTimeout), chunks)
        assertEquals(1, captured.count { it.isStream() })
    }

    @Test
    fun `a recovered run's replayed input request is dropped and its content reset passed on`() = runTest {
        val ask = """{"awaiting_input":{"type":"human_input","node":"approve","prompt":"Approve?","run_id":"run_1"}}"""
        val (runs, _) = fastClient { req ->
            when {
                req.isStream() -> sse(
                    content(1, "Drafting") + event(2, ask) +
                        // the server restarted; the recovered run replays from the start
                        event(3, """{"content_reset":true}""") + event(4, ask) + content(5, "Approved.") +
                        completed(6) + done
                )
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertEquals(1, chunks.count { it is StreamChunk.AwaitingInput })
        assertEquals(
            listOf("Content", "AwaitingInput", "ContentReset", "Content", "GeneratedArtifacts"),
            chunks.map { it::class.simpleName }
        )
    }

    @Test
    fun `failure frames without an id do not move the re-attach point`() = runTest {
        var streams = 0
        val (runs, captured) = fastClient { req ->
            when {
                // a row, then a tail-written error frame (no id), then the connection drops
                req.isStream() && ++streams == 1 ->
                    sse(content(3, "partial") + "data: {\"error\":\"lost\",\"error_type\":\"run_lost\"}\n\n")
                req.isStream() -> sse(completed(4) + done)
                req.isStatus() -> status("PENDING")
                else -> error("unexpected ${req.url}")
            }
        }

        runs.streamRun("run_1").toList()

        assertEquals(listOf("0", "3"), captured.streamFroms())
    }

    @Test
    fun `a completed summary with a warning is not a failure`() = runTest {
        val (runs, _) = fastClient { req ->
            when {
                req.isStream() -> sse(
                    content(1, "Answer.") + event(2, """{"usage":{"input_tokens":5}}""") +
                        event(3, """{"status":"completed","run_id":"run_1","generated_response":"Answer.","generated_artifacts":[],"error":null,"warning":"The web search node failed."}""") +
                        done
                )
                else -> error("unexpected ${req.url}")
            }
        }

        val chunks = runs.streamRun("run_1").toList()

        assertTrue(chunks.none { it is StreamChunk.Error }, chunks.toString())
        assertEquals("Answer.", chunks.text())
        assertTrue(chunks.any { it is StreamChunk.Usage })
    }

    @Test
    fun `keepalive comments and keepalive events yield nothing`() = runTest {
        val (runs, _) = fastClient { req ->
            when {
                req.isStream() -> sse(": keepalive\n\n" + event(1, """{"keepalive":true}""") + content(2, "x") +
                    ": keepalive\n\n" + completed(3) + done)
                else -> error("unexpected ${req.url}")
            }
        }

        // The terminal summary itself yields its (empty) generated_artifacts.
        assertEquals(
            listOf<StreamChunk>(StreamChunk.Content("x"), StreamChunk.GeneratedArtifacts("[]")),
            runs.streamRun("run_1").toList()
        )
    }
}
