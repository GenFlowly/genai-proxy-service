package com.genflowly.activity

import com.auth0.jwt.JWT
import com.auth0.jwt.algorithms.Algorithm
import com.genflowly.activity.customer.registerCustomerProfileSettingsRoutes
import com.genflowly.activity.memory.registerMemoryRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemorySourceType
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.MemoryService
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
import io.ktor.server.auth.jwt.JWTPrincipal
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * A signed-in customer who hasn't agreed gets 428, never a 403 (which the
 * clients treat as an expired session), and their content goes nowhere.
 */
class AiDataConsentRoutesTest {

    private val sub = "auth0|abc"
    private val azp = "client-1"
    private val memoryService = mockk<MemoryService>()
    private val profiles = mockk<CustomerProfileService>(relaxed = true)

    private val memory = CustomerMemory(
        memoryId = "MEM#u1", text = "Prefers concise answers.", kind = MemoryKind.CORE,
        sourceType = MemorySourceType.CONVERSATION, createdAt = "t", updatedAt = "t",
        placements = listOf(MemoryPlacement(null, MemoryKind.CORE)), version = 1, tracked = true, rev = 1
    )

    private fun jwtPrincipal() = JWTPrincipal(
        JWT.decode(JWT.create().withSubject(sub).withClaim("sub", sub).withClaim("azp", azp).sign(Algorithm.none()))
    )

    private fun ApplicationTestBuilder.setUpRoutes(principal: Any) {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { principal } }
        }
        routing {
            registerMemoryRoutes(memoryService, profiles, mockk(relaxed = true))
            registerCustomerProfileSettingsRoutes(profiles)
        }
        coEvery { profiles.getCustomerIdForToken(sub, azp) } returns "CU-1"
    }

    private suspend fun ApplicationTestBuilder.addMemory() = client.post("/api/v1/memories") {
        bearerAuth("t")
        contentType(ContentType.Application.Json)
        setBody("""{"text":"Prefers concise answers.","kind":"CORE"}""")
    }

    @Test
    fun `without consent the request is refused with 428 and nothing is saved`() = testApplication {
        setUpRoutes(jwtPrincipal())
        coEvery { profiles.hasAiDataConsent(sub, azp) } returns false

        val response = addMemory()

        assertEquals(428, response.status.value)
        assertTrue(response.bodyAsText().contains("AI_DATA_CONSENT_REQUIRED"))
        coVerify(exactly = 0) { memoryService.createMemory(any(), any()) }
    }

    @Test
    fun `with consent the request goes through`() = testApplication {
        setUpRoutes(jwtPrincipal())
        coEvery { profiles.hasAiDataConsent(sub, azp) } returns true
        coEvery { memoryService.createMemory("CU-1", any()) } returns memory

        assertEquals(HttpStatusCode.OK, addMemory().status)
    }

    @Test
    fun `a developer API key has no consent screen and passes`() = testApplication {
        setUpRoutes(ApiKeyPrincipal("CU-1"))
        coEvery { memoryService.createMemory("CU-1", any()) } returns memory

        assertEquals(HttpStatusCode.OK, addMemory().status)
        coVerify(exactly = 0) { profiles.hasAiDataConsent(any(), any()) }
    }

    @Test
    fun `agreeing records the consent and returns when`() = testApplication {
        setUpRoutes(jwtPrincipal())
        coEvery { profiles.acceptAiDataConsent(sub, "REACT_APP") } returns "2026-11-08T21:00:00Z"

        val response = client.post("/api/v1/profile/ai-data-consent") { bearerAuth("t") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(response.bodyAsText().contains("2026-11-08T21:00:00Z"))
    }
}
