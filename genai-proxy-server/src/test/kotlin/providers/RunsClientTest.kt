package com.genflowly.providers

import com.genflowly.models.retrieval.STOP_REASON_INTERRUPTED
import com.genflowly.models.retrieval.StreamChunk
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.writeStringUtf8
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import mu.KLogger
import mu.KotlinLogging
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
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

    private fun client(
        reconnectWindowMillis: Long = 180_000L,
        handler: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData
    ): Pair<RunsClient, MutableList<HttpRequestData>> {
        val captured = mutableListOf<HttpRequestData>()
        val engine = MockEngine { req ->
            captured += req
            handler(req)
        }
        val http = HttpClient(engine) { install(HttpTimeout) }
        return RunsClient(logger, json, http, "http://retrieval-server:5001", reconnectWindowMillis) { 1L } to captured
    }

    private fun MockRequestHandleScope.sse(body: String) =
        respond(content = body, status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "text/event-stream"))

    private fun MockRequestHandleScope.runStatus(status: String) =
        respond(content = """{"status":"$status","last_seq":3}""", status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"))

    private val streamRequests: (List<HttpRequestData>) -> List<HttpRequestData> =
        { all -> all.filter { it.url.encodedPath.endsWith("/stream") } }

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
            append("data: {\"activity\":{\"v\":2,\"at\":0,\"type\":\"turn.start\"}}\n\n")
            append("data: {\"content\":\"Hello\"}\n\n")
            append("data: {\"content\":\" world\"}\n\n")
            append("data: {\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}\n\n")
            append("data: {\"status\":\"completed\",\"run_id\":\"run_abc\",\"tool_calls\":null}\n\n") // terminal summary -> nothing to relay
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
        assertTrue(chunks[0] is StreamChunk.Activity)
        assertEquals(StreamChunk.Content("Hello"), chunks[1])
        assertEquals(StreamChunk.Content(" world"), chunks[2])
        assertEquals(StreamChunk.Usage(1, 2, 3, 0, 0), chunks[3])
    }

    // The reconnect tests below use runBlocking for the same reason as the Stop
    // test: the SSE read runs on Dispatchers.IO, outside runTest's virtual time.
    @Test
    fun `a dropped stream reconnects from the last relayed seq`() = runBlocking {
        var calls = 0
        val (runs, captured) = client { req ->
            if (!req.url.encodedPath.endsWith("/stream")) return@client runStatus("PENDING")
            calls++
            if (calls == 1) {
                // Cut off mid-run: no terminal event, no [DONE].
                sse("id: 1\ndata: {\"content\":\"Hel\"}\n\nid: 2\ndata: {\"content\":\"lo\"}\n\n")
            } else {
                sse("id: 3\ndata: {\"status\":\"completed\",\"run_id\":\"run_abc\"}\n\ndata: [DONE]\n\n")
            }
        }

        val chunks = runs.streamRun("run_abc").toList()

        assertEquals(listOf("0", "2"), streamRequests(captured).map { it.url.parameters["from_seq"] })
        assertEquals(listOf(StreamChunk.Content("Hel"), StreamChunk.Content("lo")), chunks)
    }

    @Test
    fun `a transport error mid-stream is retried rather than ending the reply`() = runBlocking {
        var calls = 0
        val (runs, captured) = client { req ->
            calls++
            if (calls == 1) throw java.io.IOException("Chunked stream has ended unexpectedly")
            sse("id: 1\ndata: {\"content\":\"Hi\"}\n\nid: 2\ndata: {\"status\":\"completed\",\"run_id\":\"run_abc\"}\n\ndata: [DONE]\n\n")
        }

        val chunks = runs.streamRun("run_abc").toList()

        assertEquals(2, streamRequests(captured).size)
        assertEquals(listOf(StreamChunk.Content("Hi")), chunks)
    }

    @Test
    fun `a recovered run resets the reply and falls back to the memoized answer`() = runBlocking {
        val (runs, _) = client {
            sse(buildString {
                append("id: 1\ndata: {\"content\":\"Partial\"}\n\n")
                append("id: 2\ndata: {\"run_restarted\":true}\n\n")
                append("id: 3\ndata: {\"activity\":{\"v\":2,\"at\":0,\"type\":\"turn.start\"}}\n\n")
                append("id: 4\ndata: {\"status\":\"completed\",\"run_id\":\"run_abc\",\"generated_response\":\"Full answer\"}\n\n")
                append("data: [DONE]\n\n")
            })
        }

        val chunks = runs.streamRun("run_abc").toList()

        assertEquals(StreamChunk.Content("Partial"), chunks[0])
        assertEquals(StreamChunk.RunRestarted, chunks[1])
        assertTrue(chunks[2] is StreamChunk.Activity)
        assertEquals(StreamChunk.Content("Full answer"), chunks[3])
        assertEquals(4, chunks.size)
    }

    @Test
    fun `a rerun that streams its answer is not given the answer twice`() = runBlocking {
        val (runs, _) = client {
            sse(buildString {
                append("id: 1\ndata: {\"run_restarted\":true}\n\n")
                append("id: 2\ndata: {\"content\":\"Full answer\"}\n\n")
                append("id: 3\ndata: {\"status\":\"completed\",\"run_id\":\"run_abc\",\"generated_response\":\"Full answer\"}\n\n")
                append("data: [DONE]\n\n")
            })
        }

        val chunks = runs.streamRun("run_abc").toList()

        assertEquals(listOf(StreamChunk.RunRestarted, StreamChunk.Content("Full answer")), chunks)
    }

    @Test
    fun `an unreachable run ends interrupted once the reconnect window passes`() = runBlocking {
        val (runs, captured) = client(reconnectWindowMillis = 50L) {
            respondError(HttpStatusCode.ServiceUnavailable)
        }

        val chunks = runs.streamRun("run_abc").toList()

        assertTrue(streamRequests(captured).size > 1, "retried before giving up")
        assertEquals(listOf(StreamChunk.StopReason(STOP_REASON_INTERRUPTED)), chunks)
    }

    @Test
    fun `a run that ends without its terminal event is interrupted`() = runBlocking {
        val (runs, _) = client { req ->
            if (req.url.encodedPath.endsWith("/stream")) sse("id: 1\ndata: {\"content\":\"Part\"}\n\ndata: [DONE]\n\n")
            else runStatus("MAX_RECOVERY_ATTEMPTS_EXCEEDED")
        }

        val chunks = runs.streamRun("run_abc").toList()

        assertEquals(listOf(StreamChunk.Content("Part"), StreamChunk.StopReason(STOP_REASON_INTERRUPTED)), chunks)
    }

    @Test
    fun `a cancelled run ends without an interrupted note`() = runBlocking {
        val (runs, _) = client { req ->
            if (req.url.encodedPath.endsWith("/stream")) sse("data: [DONE]\n\n") else runStatus("CANCELLED")
        }

        assertEquals(emptyList<StreamChunk>(), runs.streamRun("run_abc").toList())
    }

    // runBlocking, not runTest: the SSE read runs on Dispatchers.IO (flowOn), and
    // runTest's virtual-time withTimeout would fire before the real threads get there.
    @Test
    fun `a stream cut off by the user's Stop is a cancellation, not a failed run`() = runBlocking {
        val logger = mockk<KLogger>(relaxed = true)
        val body = ByteChannel(autoFlush = true)
        val runs = RunsClient(logger, json, HttpClient(MockEngine {
            respond(content = body, status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "text/event-stream"))
        }) { install(HttpTimeout) }, "http://retrieval-server:5001")
        val firstChunk = CompletableDeferred<StreamChunk>()
        // The durable run is still generating: one chunk, then the stream stays open.
        body.writeStringUtf8("data: {\"content\":\"Partial\"}\n\n")

        val generation = launch(Dispatchers.Default) {
            runs.streamRun("run_abc").collect { firstChunk.complete(it) }
        }
        assertEquals(StreamChunk.Content("Partial"), withTimeout(5_000) { firstChunk.await() })
        // What GenerationOrchestrator.cancelGeneration does on Stop.
        generation.cancel(CancellationException("Cancelled by user"))
        withTimeout(5_000) { generation.join() }

        assertTrue(generation.isCancelled)
        verify(exactly = 0) { logger.error(any<Throwable>(), any<() -> Any?>()) }
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
    }
}
