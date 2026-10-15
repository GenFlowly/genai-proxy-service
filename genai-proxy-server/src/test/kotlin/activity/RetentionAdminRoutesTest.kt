package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.admin.registerRetentionAdminRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.ClaimBackfillResponse
import com.genflowly.service.ClaimBackfillService
import com.genflowly.testsupport.testAppConfig
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.bearer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class RetentionAdminRoutesTest {

    private val backfill = mockk<ClaimBackfillService>()
    private val page = ClaimBackfillResponse(10, 4, 4, 0, 0, 0, nextPageToken = "tok-2", done = false)

    private fun ApplicationTestBuilder.setUp(caller: String) {
        install(ContentNegotiation) { json() }
        install(Authentication) { bearer("auth0") { authenticate { ApiKeyPrincipal(caller) } } }
        routing {
            registerRetentionAdminRoutes(backfill, mockk(relaxed = true), testAppConfig(adminCustomerIds = setOf("admin-1")))
        }
    }

    private suspend fun ApplicationTestBuilder.call(body: String) = client.post(Routes.ADMIN_RETENTION_CLAIM_BACKFILL) {
        bearerAuth("token")
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    @Test
    fun `an admin runs a page and gets the next token`() = testApplication {
        setUp("admin-1")
        coEvery { backfill.runPage("tok-1", 50) } returns page

        val response = call("""{"pageToken":"tok-1","maxItems":50}""")

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(page, Json.decodeFromString<ClaimBackfillResponse>(response.bodyAsText()))
    }

    @Test
    fun `the first call needs no token and uses the default page size`() = testApplication {
        setUp("admin-1")
        coEvery { backfill.runPage(null, ClaimBackfillService.DEFAULT_MAX_ITEMS) } returns page

        assertEquals(HttpStatusCode.OK, call("{}").status)
    }

    @Test
    fun `a non-admin is refused and nothing runs`() = testApplication {
        setUp("someone")
        assertEquals(HttpStatusCode.Forbidden, call("{}").status)
        coVerify(exactly = 0) { backfill.runPage(any(), any()) }
    }

    @Test
    fun `an invalid page token is a 400`() = testApplication {
        setUp("admin-1")
        coEvery { backfill.runPage(any(), any()) } throws IllegalArgumentException("Invalid page token")

        val response = call("""{"pageToken":"garbage"}""")

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("""{"error":"Invalid page token"}""", response.bodyAsText())
    }
}
