package com.genflowly.di

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.server.plugins.callid.CallId
import io.ktor.server.plugins.callid.callIdMdc
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.slf4j.MDC
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Work a request hands to AppScope keeps the request's id. The shared
 * HttpClient stamps X-Request-Id from MDC, so a background job without it
 * calls the retrieval server uncorrelated: a streamed generation runs on
 * AppScope, and its POST /runs and /runs/{id}/stream went out with no id,
 * leaving the retrieval server to mint an unrelated one.
 */
class AppScopeRequestIdTest {

    private val appScope = AppScope()

    // CallId + CallLogging exactly as Application.module installs them.
    private fun ApplicationTestBuilder.probe(handler: suspend () -> String?) {
        install(CallId) { retrieveFromHeader(HttpHeaders.XRequestId) }
        install(CallLogging) { callIdMdc("request_id") }
        routing {
            get("/probe") { call.respondText(handler() ?: "<none>") }
        }
    }

    private suspend fun ApplicationTestBuilder.requestIdSeen(): String =
        client.get("/probe") { header(HttpHeaders.XRequestId, "rid-1") }.bodyAsText()

    @Test
    fun `a job launched from a request carries its request id`() = testApplication {
        probe {
            var seen: String? = null
            appScope.launch { seen = MDC.get("request_id") }.join()
            seen
        }

        assertEquals("rid-1", requestIdSeen())
    }

    @Test
    fun `the id survives suspension and dispatcher hops inside the job`() = testApplication {
        probe {
            var seen: String? = null
            appScope.launch {
                yield()
                withContext(Dispatchers.Default) { seen = MDC.get("request_id") }
            }.join()
            seen
        }

        assertEquals("rid-1", requestIdSeen())
    }

    @Test
    fun `async work launched from a request carries its request id`() = testApplication {
        probe { appScope.async { MDC.get("request_id") }.await() }

        assertEquals("rid-1", requestIdSeen())
    }

    @Test
    fun `a job launched outside any request has no request id`() = runBlocking {
        var seen: String? = "unset"
        appScope.launch { seen = MDC.get("request_id") }.join()

        assertNull(seen)
    }
}
