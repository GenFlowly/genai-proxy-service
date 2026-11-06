package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.account.registerAccountRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.DeleteCredentialsResponse
import com.genflowly.service.AccountDeletionRefusedException
import com.genflowly.service.AccountDeletionService
import com.genflowly.service.CustomerCredentialsService
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
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

/**
 * DELETE /account and DELETE /credentials over HTTP: account deletion needs
 * the typed confirmation, and starts in the background (202).
 */
class AccountRoutesTest {

    private val accountDeletionService = mockk<AccountDeletionService>(relaxed = true)
    private val credentialsService = mockk<CustomerCredentialsService>()

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { ApiKeyPrincipal("CU-1") } }
        }
        routing { registerAccountRoutes(accountDeletionService, credentialsService, mockk(relaxed = true)) }
    }

    private suspend fun ApplicationTestBuilder.deleteAccount(body: String?): HttpResponse =
        client.delete(Routes.DELETE_ACCOUNT) {
            bearerAuth("token")
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }

    @Test
    fun `deleting the account needs the typed confirmation`() = testApplication {
        setUpRoutes()

        for (body in listOf(null, "{}", """{"confirmation":"delete"}""", """{"confirmation":"yes"}""")) {
            assertEquals(HttpStatusCode.BadRequest, deleteAccount(body).status, body)
        }
        coVerify(exactly = 0) { accountDeletionService.requestDeletion(any()) }
    }

    @Test
    fun `a confirmed deletion starts and answers 202`() = testApplication {
        setUpRoutes()

        val response = deleteAccount("""{"confirmation":"DELETE"}""")

        assertEquals(HttpStatusCode.Accepted, response.status)
        assertEquals("""{"status":"deletion_started"}""", response.bodyAsText())
        coVerify { accountDeletionService.requestDeletion("CU-1") }
    }

    @Test
    fun `an account that can't be deleted here is a 403`() = testApplication {
        setUpRoutes()
        coEvery { accountDeletionService.requestDeletion("CU-1") } throws AccountDeletionRefusedException("Admin-panel accounts can't be deleted here")

        assertEquals(HttpStatusCode.Forbidden, deleteAccount("""{"confirmation":"DELETE"}""").status)
    }

    @Test
    fun `a failed deletion is a 500`() = testApplication {
        setUpRoutes()
        coEvery { accountDeletionService.requestDeletion("CU-1") } throws IllegalStateException("throttled")

        assertEquals(HttpStatusCode.InternalServerError, deleteAccount("""{"confirmation":"DELETE"}""").status)
    }

    @Test
    fun `deleting every key reports how many were removed`() = testApplication {
        setUpRoutes()
        coEvery { credentialsService.deleteAllCredentials("CU-1") } returns 4

        val response = client.delete(Routes.DELETE_CREDENTIALS) { bearerAuth("token") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(4, Json.decodeFromString<DeleteCredentialsResponse>(response.bodyAsText()).deleted)
    }
}
