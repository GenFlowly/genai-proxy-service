package com.genflowly.activity

import com.genflowly.activity.memory.registerMemoryRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.CustomerMemory
import com.genflowly.models.api.DeleteMemoryResponse
import com.genflowly.models.api.EditMemoryRequest
import com.genflowly.models.api.MemoryKind
import com.genflowly.models.api.MemoryPlacement
import com.genflowly.models.api.MemoryResponse
import com.genflowly.models.api.MemorySourceType
import com.genflowly.models.api.MemoryUsagePage
import com.genflowly.models.api.MoveMemoryRequest
import com.genflowly.service.CustomerProfileService
import com.genflowly.service.MemoryConflictException
import com.genflowly.service.MemoryNotFoundException
import com.genflowly.service.MemoryRequestException
import com.genflowly.service.MemoryService
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.put
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
import kotlin.test.assertFalse

/**
 * The memory routes over HTTP. Ids contain "#", so clients send it as %23;
 * anything that isn't a memory id is not found, and each service refusal
 * maps to its status.
 */
class MemoryRoutesTest {

    private val memoryService = mockk<MemoryService>()
    private val profiles = mockk<CustomerProfileService>(relaxed = true)

    private val memory = CustomerMemory(
        memoryId = "MEM#u1", text = "Prefers concise answers.", kind = MemoryKind.CORE,
        sourceType = MemorySourceType.CONVERSATION, createdAt = "t", updatedAt = "t",
        placements = listOf(MemoryPlacement(null, MemoryKind.CORE)), version = 3, tracked = true, rev = 9
    )

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { ApiKeyPrincipal("CU-1") } }
        }
        routing { registerMemoryRoutes(memoryService, profiles, mockk(relaxed = true)) }
    }

    @Test
    fun `an encoded id reaches the service with its hash`() = testApplication {
        setUpRoutes()
        coEvery { memoryService.editMemory("CU-1", "MEM#u1", EditMemoryRequest("New.", 3)) } returns memory

        val response = client.put("/api/v1/memories/MEM%23u1") {
            bearerAuth("t")
            contentType(ContentType.Application.Json)
            setBody("""{"text":"New.","baseVersion":3}""")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        val body = Json { ignoreUnknownKeys = true }.decodeFromString<MemoryResponse>(response.bodyAsText())
        assertEquals(3, body.memory.version)
        assertFalse(response.bodyAsText().contains("\"rev\""), "the write counter stays server-side")
    }

    @Test
    fun `ids that aren't memories are not found`() = testApplication {
        setUpRoutes()

        val response = client.delete("/api/v1/memories/META%23CONV%23c1") { bearerAuth("t") }

        assertEquals(HttpStatusCode.NotFound, response.status)
        coVerify(exactly = 0) { memoryService.deleteMemory(any(), any(), any(), any()) }
    }

    @Test
    fun `refusals map to 404, 409 and 400`() = testApplication {
        setUpRoutes()
        val move: suspend (String) -> HttpStatusCode = { body ->
            client.post("/api/v1/memories/MEM%23u1/move") {
                bearerAuth("t")
                contentType(ContentType.Application.Json)
                setBody(body)
            }.status
        }
        val request = """{"fromProjectId":null,"toProjectId":"PRJa","kind":"CORE"}"""
        val parsed = MoveMemoryRequest(null, "PRJa", MemoryKind.CORE)

        coEvery { memoryService.moveMemory("CU-1", "MEM#u1", parsed) } throws MemoryNotFoundException("MEM#u1")
        assertEquals(HttpStatusCode.NotFound, move(request))
        coEvery { memoryService.moveMemory("CU-1", "MEM#u1", parsed) } throws MemoryConflictException("changed")
        assertEquals(HttpStatusCode.Conflict, move(request))
        coEvery { memoryService.moveMemory("CU-1", "MEM#u1", parsed) } throws MemoryRequestException("already there")
        assertEquals(HttpStatusCode.BadRequest, move(request))
        assertEquals(HttpStatusCode.BadRequest, move("""{"kind":"SOMETIMES"}"""))
    }

    @Test
    fun `deleting from one project says the memory still exists elsewhere`() = testApplication {
        setUpRoutes()
        coEvery { memoryService.deleteMemory("CU-1", "MEM#u1", "PRJa", null) } returns false

        val response = client.delete("/api/v1/memories/MEM%23u1?projectId=PRJa") { bearerAuth("t") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertFalse(Json.decodeFromString<DeleteMemoryResponse>(response.bodyAsText()).deleted)
    }

    @Test
    fun `the usage log takes a page size and a cursor`() = testApplication {
        setUpRoutes()
        coEvery { memoryService.getUsagePage("CU-1", "MEM#u1", 10, "abc") } returns MemoryUsagePage(emptyList(), null, 198)

        val response = client.get("/api/v1/memories/MEM%23u1/usage?limit=10&cursor=abc") { bearerAuth("t") }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(198, Json.decodeFromString<MemoryUsagePage>(response.bodyAsText()).total)
    }
}
