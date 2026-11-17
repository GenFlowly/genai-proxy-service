package com.genflowly.activity

import com.genflowly.activity.generation.registerSaveAIConfigPreferencesRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.EmbeddingModelLockedException
import com.genflowly.service.CustomerCredentialsService
import com.genflowly.service.CustomerProfileService
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The save route takes one embedding model — from embeddingModel, or from the
 * per-category fields older apps still send — and answers 409 with the locked
 * model when a different one was already chosen.
 */
class SaveEmbeddingModelRoutesTest {

    private val profiles = mockk<CustomerProfileService>(relaxed = true)
    private val credentials = mockk<CustomerCredentialsService>(relaxed = true)

    private fun ApplicationTestBuilder.app() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal("CU-1") } }
        }
        routing { registerSaveAIConfigPreferencesRoutes(profiles, credentials) }
    }

    private suspend fun ApplicationTestBuilder.save(body: String) = client.post("/api/v1/save-ai-config") {
        bearerAuth("token")
        contentType(ContentType.Application.Json)
        setBody(body)
    }

    @Test
    fun `an older app's conversations field is saved as the one model`() = testApplication {
        app()

        val response = save("""{"aiConfigPreferences":{"embeddingModelConversations":"voyage-4-large"}}""")

        assertEquals(HttpStatusCode.OK, response.status)
        coVerify {
            profiles.savePreferences("CU-1", null, null, null, "voyage-4-large", null, null, null, null, null)
        }
    }

    @Test
    fun `two different models in one request are refused`() = testApplication {
        app()

        val response = save("""{"aiConfigPreferences":{"embeddingModel":"voyage-4-large","embeddingModelNotes":"text-embedding-3-large"}}""")

        assertEquals(HttpStatusCode.BadRequest, response.status)
        coVerify(exactly = 0) { profiles.savePreferences(any(), any(), any(), any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun `a locked model answers 409 and names it`() = testApplication {
        app()
        coEvery { credentials.isEmbeddingModelUnusable("CU-1", "text-embedding-3-large") } returns false
        coEvery { profiles.savePreferences(any(), any(), any(), any(), "voyage-4-large", any(), any(), any(), any(), any()) } throws
            EmbeddingModelLockedException("text-embedding-3-large")

        val response = save("""{"aiConfigPreferences":{"embeddingModel":"voyage-4-large"}}""")

        assertEquals(HttpStatusCode.Conflict, response.status)
        val body = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertEquals("text-embedding-3-large", body.getValue("embeddingModel").jsonPrimitive.content)
        coVerify(exactly = 0) { profiles.replaceUnusableEmbeddingModel(any(), any(), any()) }
    }

    @Test
    fun `a locked model the key can no longer use is replaced once, then the save goes through`() = testApplication {
        app()
        coEvery { profiles.savePreferences(any(), any(), any(), any(), "voyage-4-large", any(), any(), any(), any(), any()) } throws
            EmbeddingModelLockedException("voyage-multimodal-3.5") andThen Unit
        coEvery { credentials.isEmbeddingModelUnusable("CU-1", "voyage-multimodal-3.5") } returns true

        val response = save("""{"aiConfigPreferences":{"embeddingModelConversations":"voyage-4-large"}}""")

        assertEquals(HttpStatusCode.OK, response.status)
        coVerify(exactly = 1) { profiles.replaceUnusableEmbeddingModel("CU-1", "voyage-multimodal-3.5", "voyage-4-large") }
        coVerify(exactly = 2) { profiles.savePreferences(any(), any(), any(), any(), "voyage-4-large", any(), any(), any(), any(), any()) }
    }
}
