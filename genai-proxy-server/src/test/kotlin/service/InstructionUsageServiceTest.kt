package com.genflowly.service

import com.genflowly.activity.instruction.registerGetInstructionUsageRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.api.InstructionUsageResponse
import com.genflowly.repository.InstructionConversationUse
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.InstructionUsageCount
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.bearer
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing
import io.ktor.server.testing.testApplication
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * An instruction's usage is the caller's own: the conversations they used it
 * in, newest first, titled live, with deleted ones left out but still counted.
 */
class InstructionUsageServiceTest {

    private val repository = mockk<InstructionRepository>()
    private val instructions = mockk<InstructionService>()
    private val conversations = mockk<ConversationService>()
    private val service = InstructionUsageService(repository, instructions, conversations)

    private fun visible(id: String = "INS-1") {
        coEvery { repository.getLatestInstructionVersion(id) } returns 2
        coEvery { instructions.getInstructionVersion("CU-1", id, 2) } returns
            InstructionResponse(id = id, version = 2, name = "VC", instruction = "You are a VC.")
    }

    @Test
    fun `lists the caller's conversations newest first, ones without a time last`() = runTest {
        visible()
        coEvery { repository.getInstructionUsage("CU-1", "INS-1") } returns InstructionUsageCount(3, "2026-11-06T13:12:00Z")
        coEvery { repository.getInstructionConversations("CU-1", "INS-1") } returns listOf(
            InstructionConversationUse("C-old", null),
            InstructionConversationUse("C-a", "2026-11-01T09:00:00Z"),
            InstructionConversationUse("C-b", "2026-11-06T13:12:00Z"),
        )
        coEvery { conversations.getConversationTitle(any(), "CU-1") } answers { "Title of ${firstArg<String>()}" }

        val usage = service.getUsage("CU-1", "INS-1")

        assertEquals(listOf("C-b", "C-a", "C-old"), usage.conversations.map { it.conversationId })
        assertEquals("Title of C-b", usage.conversations.first().title)
        assertEquals("2026-11-06T13:12:00Z", usage.conversations.first().firstUsedAt)
        assertEquals(null, usage.conversations.last().firstUsedAt)
        assertEquals(3, usage.usageCount)
        assertEquals("2026-11-06T13:12:00Z", usage.lastUsedAt)
    }

    @Test
    fun `a conversation the caller can no longer open is left out but still counted`() = runTest {
        visible()
        coEvery { repository.getInstructionUsage("CU-1", "INS-1") } returns InstructionUsageCount(2, "t")
        coEvery { repository.getInstructionConversations("CU-1", "INS-1") } returns listOf(
            InstructionConversationUse("C-gone", "2026-11-02T00:00:00Z"),
            InstructionConversationUse("C-here", "2026-11-01T00:00:00Z"),
        )
        coEvery { conversations.getConversationTitle("C-gone", "CU-1") } throws ConversationAccessDeniedException("gone")
        coEvery { conversations.getConversationTitle("C-here", "CU-1") } returns "Here"

        val usage = service.getUsage("CU-1", "INS-1")

        assertEquals(listOf("C-here"), usage.conversations.map { it.conversationId })
        assertEquals(2, usage.usageCount)
    }

    @Test
    fun `past the limit the newest are listed and the rest only counted`() = runTest {
        visible()
        coEvery { repository.getInstructionUsage("CU-1", "INS-1") } returns InstructionUsageCount(53, "t")
        coEvery { repository.getInstructionConversations("CU-1", "INS-1") } returns
            (1..53).map { InstructionConversationUse("C-$it", "2026-10-%02dT00:00:00Z".format(it % 28 + 1)) }
        coEvery { conversations.getConversationTitle(any(), "CU-1") } returns "T"

        val usage = service.getUsage("CU-1", "INS-1")

        assertEquals(50, usage.conversations.size)
        assertEquals(3, usage.omitted)
        assertEquals(53, usage.usageCount)
    }

    @Test
    fun `never used means zero and no conversations`() = runTest {
        visible()
        coEvery { repository.getInstructionUsage("CU-1", "INS-1") } returns null
        coEvery { repository.getInstructionConversations("CU-1", "INS-1") } returns emptyList()

        val usage = service.getUsage("CU-1", "INS-1")

        assertEquals(0, usage.usageCount)
        assertEquals(null, usage.lastUsedAt)
        assertEquals(emptyList(), usage.conversations)
    }

    @Test
    fun `an instruction the caller can't see is not found, and nothing is read`() = runTest {
        coEvery { repository.getLatestInstructionVersion("INS-x") } returns 1
        coEvery { instructions.getInstructionVersion("CU-1", "INS-x", 1) } returns null

        assertFailsWith<InstructionNotFoundException> { service.getUsage("CU-1", "INS-x") }
        coVerify(exactly = 0) { repository.getInstructionConversations(any(), any()) }
    }

    @Test
    fun `an instruction that doesn't exist is not found`() = runTest {
        coEvery { repository.getLatestInstructionVersion("INS-none") } returns null

        assertFailsWith<InstructionNotFoundException> { service.getUsage("CU-1", "INS-none") }
    }

    @Test
    fun `the route answers 200 with the usage and 404 for an unknown instruction`() = testApplication {
        val usageService = mockk<InstructionUsageService>()
        install(ContentNegotiation) { json() }
        install(Authentication) { bearer("auth0") { authenticate { ApiKeyPrincipal("CU-1") } } }
        routing { registerGetInstructionUsageRoutes(usageService, mockk(relaxed = true)) }
        coEvery { usageService.getUsage("CU-1", "INS-1") } returns InstructionUsageResponse(4, "t", emptyList())
        coEvery { usageService.getUsage("CU-1", "INS-none") } throws InstructionNotFoundException("INS-none")

        val ok = client.get("/api/v1/instruction/INS-1/usage") { bearerAuth("token") }
        val missing = client.get("/api/v1/instruction/INS-none/usage") { bearerAuth("token") }

        assertEquals(HttpStatusCode.OK, ok.status)
        assertEquals(4, Json.decodeFromString<InstructionUsageResponse>(ok.bodyAsText()).usageCount)
        assertEquals(HttpStatusCode.NotFound, missing.status)
    }
}
