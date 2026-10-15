package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.admin.registerRetentionAdminRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.AccountDeletionStatusResponse
import com.genflowly.models.api.ClaimBackfillResponse
import com.genflowly.repository.PurgeJob
import com.genflowly.repository.PurgeJobType
import com.genflowly.service.AccountDeletionService
import com.genflowly.service.ClaimBackfillService
import com.genflowly.service.CustomerNotFoundException
import com.genflowly.testsupport.testAppConfig
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.parameter
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
    private val deletion = mockk<AccountDeletionService>()
    private val page = ClaimBackfillResponse(10, 4, 4, 0, 0, 0, nextPageToken = "tok-2", done = false)

    private fun ApplicationTestBuilder.setUp(caller: String) {
        install(ContentNegotiation) { json() }
        install(Authentication) { bearer("auth0") { authenticate { ApiKeyPrincipal(caller) } } }
        routing {
            registerRetentionAdminRoutes(
                backfill, deletion, mockk(relaxed = true), testAppConfig(adminCustomerIds = setOf("admin-1"))
            )
        }
    }

    private suspend fun ApplicationTestBuilder.callBackfill(body: String) =
        client.post(Routes.ADMIN_RETENTION_CLAIM_BACKFILL) {
            bearerAuth("token")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    @Test
    fun `an admin runs a backfill page and gets the next token`() = testApplication {
        setUp("admin-1")
        coEvery { backfill.runPage("tok-1", 50) } returns page

        val response = callBackfill("""{"pageToken":"tok-1","maxItems":50}""")

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(page, Json.decodeFromString<ClaimBackfillResponse>(response.bodyAsText()))
    }

    @Test
    fun `the first backfill call needs no token and uses the default page size`() = testApplication {
        setUp("admin-1")
        coEvery { backfill.runPage(null, ClaimBackfillService.DEFAULT_MAX_ITEMS) } returns page

        assertEquals(HttpStatusCode.OK, callBackfill("{}").status)
    }

    @Test
    fun `a non-admin is refused and nothing runs`() = testApplication {
        setUp("someone")
        assertEquals(HttpStatusCode.Forbidden, callBackfill("{}").status)
        assertEquals(HttpStatusCode.Forbidden, client.delete("/api/v1/admin/customers/CU1") { bearerAuth("t") }.status)
        coVerify(exactly = 0) { backfill.runPage(any(), any()) }
        coVerify(exactly = 0) { deletion.requestDeletion(any(), any()) }
    }

    @Test
    fun `an invalid page token is a 400`() = testApplication {
        setUp("admin-1")
        coEvery { backfill.runPage(any(), any()) } throws IllegalArgumentException("Invalid page token")

        val response = callBackfill("""{"pageToken":"garbage"}""")

        assertEquals(HttpStatusCode.BadRequest, response.status)
        assertEquals("""{"error":"Invalid page token"}""", response.bodyAsText())
    }

    private val status = AccountDeletionStatusResponse(
        customerId = "CU1", jobKey = "ACCOUNT#CU1", state = "PENDING", stage = 0, attempts = 0
    )

    @Test
    fun `deleting a customer answers 202 with the job's status`() = testApplication {
        setUp("admin-1")
        coEvery { deletion.requestDeletion("CU1", "admin-1") } returns
            AccountDeletionService.RequestResult(PurgeJob("ACCOUNT#CU1", PurgeJobType.ACCOUNT, "CU1"), created = true)
        coEvery { deletion.status("CU1") } returns status

        val response = client.delete("/api/v1/admin/customers/CU1") { bearerAuth("t") }

        assertEquals(HttpStatusCode.Accepted, response.status)
        assertEquals(status.copy(created = true), Json.decodeFromString<AccountDeletionStatusResponse>(response.bodyAsText()))
    }

    @Test
    fun `an unknown customer is a 404 and an invalid request a 400`() = testApplication {
        setUp("admin-1")
        coEvery { deletion.requestDeletion("CUX", any()) } throws CustomerNotFoundException("No customer CUX")
        coEvery { deletion.requestDeletion("admin-1", any()) } throws
            IllegalArgumentException("An admin cannot delete their own account here")

        assertEquals(HttpStatusCode.NotFound, client.delete("/api/v1/admin/customers/CUX") { bearerAuth("t") }.status)
        val self = client.delete("/api/v1/admin/customers/admin-1") { bearerAuth("t") }
        assertEquals(HttpStatusCode.BadRequest, self.status)
    }

    @Test
    fun `the deletion status is readable by customerId`() = testApplication {
        setUp("admin-1")
        coEvery { deletion.status("CU1") } returns status
        coEvery { deletion.status("CU2") } returns null

        val found = client.get(Routes.ADMIN_CUSTOMER_DELETION_STATUS) { bearerAuth("t"); parameter("customerId", "CU1") }
        assertEquals(HttpStatusCode.OK, found.status)
        assertEquals(status, Json.decodeFromString<AccountDeletionStatusResponse>(found.bodyAsText()))
        val missing = client.get(Routes.ADMIN_CUSTOMER_DELETION_STATUS) { bearerAuth("t"); parameter("customerId", "CU2") }
        assertEquals(HttpStatusCode.NotFound, missing.status)
    }
}
