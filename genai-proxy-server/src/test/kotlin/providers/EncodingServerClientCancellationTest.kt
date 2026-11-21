package com.genflowly.providers

import com.genflowly.di.AppScope
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandler
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import io.mockk.mockk
import io.mockk.verify
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import mu.KLogger
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Encoding calls are best-effort: a transport failure is logged and swallowed.
 * Cancellation is not a failure — a deploy's shutdown (AppScope.shutdown)
 * cancels in-flight calls, and that used to surface as
 * "Failed to ensure collection creation" ERRORs on production restarts.
 */
class EncodingServerClientCancellationTest {

    private val logger = mockk<KLogger>(relaxed = true)

    private fun client(handler: MockRequestHandler) = EncodingServerClient(
        HttpClient(MockEngine(handler)) { install(ContentNegotiation) { json() } },
        logger,
        "http://encoding-server"
    )

    // runBlocking, not runTest: AppScope runs on Dispatchers.IO, and runTest's
    // virtual-time withTimeout would fire before the real threads get there.
    @Test
    fun `a call cut off by AppScope shutdown is not logged as an error`() = runBlocking {
        val requestSent = CompletableDeferred<Unit>()
        val client = client {
            requestSent.complete(Unit)
            awaitCancellation()
        }
        val appScope = AppScope()
        val call = appScope.launch { client.ensureCollections("CU-1", "Bearer t") }

        withTimeout(5_000) { requestSent.await() }
        appScope.shutdown()
        withTimeout(5_000) { call.join() }

        assertTrue(call.isCancelled)
        verify(exactly = 0) { logger.error(any<Throwable>(), any<() -> Any?>()) }
    }

    @Test
    fun `a transport failure is still logged and swallowed`() = runTest {
        val client = client { throw IOException("connection refused") }

        client.ensureCollections("CU-1", "Bearer t")

        verify(exactly = 1) { logger.error(any<Throwable>(), any<() -> Any?>()) }
    }
}
