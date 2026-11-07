package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.indexing.registerIndexingRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.service.ConversationIndexingService
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
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
import io.mockk.mockk
import kotlin.test.Test
import kotlin.test.assertEquals

/** DELETE /indexing/chats over HTTP: it deletes the customer's indexed chats and says how many went. */
class IndexingRoutesTest {

    private val indexing = mockk<ConversationIndexingService>()

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { ApiKeyPrincipal("CU-1") } }
        }
        routing { registerIndexingRoutes(indexing, mockk(relaxed = true)) }
    }

    @Test
    fun `deleting indexed chats reports how many vectors went`() = testApplication {
        setUpRoutes()
        coEvery { indexing.deleteIndexedChats("CU-1") } returns 12

        val response = client.delete(Routes.INDEXED_CHATS) { bearerAuth("token") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("""{"status":"success","deleted":12}""", response.bodyAsText())
    }

    @Test
    fun `a vector DB that can't be cleared is a 500`() = testApplication {
        setUpRoutes()
        coEvery { indexing.deleteIndexedChats("CU-1") } throws IllegalStateException("Vector purge failed: 500")

        assertEquals(HttpStatusCode.InternalServerError, client.delete(Routes.INDEXED_CHATS) { bearerAuth("token") }.status)
    }
}
