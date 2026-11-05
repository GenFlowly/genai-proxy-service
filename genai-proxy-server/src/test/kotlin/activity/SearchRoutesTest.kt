package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.instruction.registerSearchInstructionsRoutes
import com.genflowly.activity.search.registerSearchRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.models.api.SearchErrorResponse
import com.genflowly.models.api.SearchResponse
import com.genflowly.providers.SearchNotConfiguredException
import com.genflowly.providers.SearchSetupReason
import com.genflowly.providers.SearchUnavailableException
import com.genflowly.service.InstructionService
import com.genflowly.service.UnifiedSearchService
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
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
 * GET /search and GET /instructions/search over HTTP: a search that couldn't
 * run answers 409 or 502 with a machine-readable code, never 200 with an
 * empty list (L2-001).
 */
class SearchRoutesTest {

    private val customerId = "CU-1"
    private val unifiedSearchService = mockk<UnifiedSearchService>()
    private val instructionService = mockk<InstructionService>()

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal(customerId) } }
        }
        routing {
            registerSearchRoutes(mockk(relaxed = true), unifiedSearchService)
            registerSearchInstructionsRoutes(instructionService, mockk(relaxed = true))
        }
    }

    private suspend fun ApplicationTestBuilder.get(path: String) = client.get(path) { bearerAuth("gfy_test") }

    private suspend fun HttpResponse.error() = Json.decodeFromString<SearchErrorResponse>(bodyAsText())

    private fun failWith(e: Exception) {
        coEvery { unifiedSearchService.search(any(), any(), any(), any()) } throws e
        coEvery { instructionService.searchInstructions(any(), any()) } throws e
    }

    private val paths = listOf("${Routes.SEARCH}?q=tests", "${Routes.SEARCH_INSTRUCTIONS}?q=tests")

    @Test
    fun `no vector DB is a 409 naming the setting`() = testApplication {
        setUpRoutes()
        failWith(SearchNotConfiguredException(SearchSetupReason.VECTOR_DB, "No vector DB configured for customer 'CU-1'."))

        for (path in paths) {
            val response = get(path)
            assertEquals(HttpStatusCode.Conflict, response.status, path)
            val error = response.error()
            assertEquals(SearchErrorResponse.NOT_CONFIGURED, error.code, path)
            assertEquals("VECTOR_DB_NOT_CONFIGURED", error.reason, path)
        }
    }

    @Test
    fun `a missing embedding key is a 409 naming the setting`() = testApplication {
        setUpRoutes()
        failWith(SearchNotConfiguredException(SearchSetupReason.EMBEDDING_KEY, "No API key"))

        for (path in paths) {
            val error = get(path).error()
            assertEquals(SearchErrorResponse.NOT_CONFIGURED, error.code, path)
            assertEquals("EMBEDDING_KEY_MISSING", error.reason, path)
        }
    }

    @Test
    fun `a retrieval failure is a 502`() = testApplication {
        setUpRoutes()
        failWith(SearchUnavailableException(500, "Search failed: 500"))

        for (path in paths) {
            val response = get(path)
            assertEquals(HttpStatusCode.BadGateway, response.status, path)
            assertEquals(SearchErrorResponse.UNAVAILABLE, response.error().code, path)
        }
    }

    @Test
    fun `other errors keep their 500`() = testApplication {
        setUpRoutes()
        failWith(IllegalStateException("boom"))

        for (path in paths) {
            assertEquals(HttpStatusCode.InternalServerError, get(path).status, path)
        }
    }

    @Test
    fun `signed-out callers can't search`() = testApplication {
        setUpRoutes()

        for (path in paths) {
            assertEquals(HttpStatusCode.Unauthorized, client.get(path).status, path)
        }
        coVerify(exactly = 0) { instructionService.searchInstructions(any(), any()) }
        coVerify(exactly = 0) { unifiedSearchService.search(any(), any(), any(), any()) }
    }

    @Test
    fun `a search that ran returns its results`() = testApplication {
        setUpRoutes()
        coEvery { unifiedSearchService.search(any(), any(), any(), any()) } returns emptyList()
        coEvery { instructionService.searchInstructions(any(), any()) } returns
            GetCustomerInstructionListResponse(instructions = emptyList())

        val search = get(paths[0])
        assertEquals(HttpStatusCode.OK, search.status)
        assertEquals(emptyList(), Json.decodeFromString<SearchResponse>(search.bodyAsText()).results)
        assertEquals(HttpStatusCode.OK, get(paths[1]).status)
    }
}
