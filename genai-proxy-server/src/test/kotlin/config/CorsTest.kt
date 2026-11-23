package com.genflowly.config

import io.ktor.client.request.header
import io.ktor.client.request.options
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The web app calls api.genflowly.com cross-origin, so every API call it makes
 * is gated on a preflight. A preflight that names a header we didn't list used
 * to be a 403, and the browser then dropped the call: a whole session's sidebar,
 * models and agents came back empty.
 */
class CorsTest {

    @Test
    fun `the web app's own headers pass the preflight`() = testApplication {
        application { configureCors() }
        val response = client.options("/api/v1/conversations/pinned") {
            header(HttpHeaders.Origin, "https://genflowly.com")
            header(HttpHeaders.AccessControlRequestMethod, "GET")
            header(HttpHeaders.AccessControlRequestHeaders, "authorization,content-type")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("https://genflowly.com", response.headers[HttpHeaders.AccessControlAllowOrigin])
    }

    @Test
    fun `a header added by something other than the app still passes the preflight`() = testApplication {
        application { configureCors() }
        val response = client.options("/api/v1/conversations/pinned") {
            header(HttpHeaders.Origin, "https://genflowly.com")
            header(HttpHeaders.AccessControlRequestMethod, "GET")
            header(HttpHeaders.AccessControlRequestHeaders, "authorization,x-client-extension")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        val allowed = response.headers[HttpHeaders.AccessControlAllowHeaders].orEmpty().lowercase()
        assertTrue("x-client-extension" in allowed, "Access-Control-Allow-Headers was: $allowed")
    }
}
