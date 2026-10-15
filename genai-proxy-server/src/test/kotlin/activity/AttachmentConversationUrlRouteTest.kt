package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.attachment.registerAttachmentRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.GetAttachmentUrlResponse
import com.genflowly.service.AttachmentService
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.parameter
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
 * GET /attachments/url over HTTP: with conversationId the in-conversation
 * lookup answers (200 or 404), without it the caller's own prefix does, as
 * before.
 */
class AttachmentConversationUrlRouteTest {

    private val customerId = "cust-1"
    private val attachmentService = mockk<AttachmentService>()

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal(customerId) } }
        }
        routing { registerAttachmentRoutes(attachmentService, mockk(relaxed = true)) }
    }

    @Test
    fun `with a conversationId the participant lookup is used`() = testApplication {
        setUpRoutes()
        coEvery { attachmentService.getViewUrlInConversation(customerId, "pdf-1", "conv-1") } returns "https://s3/x?sig"

        val response = client.get(Routes.GET_ATTACHMENT_URL) {
            bearerAuth("gfy_test")
            parameter("attachmentId", "pdf-1")
            parameter("conversationId", "conv-1")
        }

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(
            GetAttachmentUrlResponse("pdf-1", "https://s3/x?sig"),
            Json.decodeFromString<GetAttachmentUrlResponse>(response.bodyAsText())
        )
        coVerify(exactly = 0) { attachmentService.getViewUrl(any(), any()) }
    }

    @Test
    fun `no access or an id outside the conversation is a 404`() = testApplication {
        setUpRoutes()
        coEvery { attachmentService.getViewUrlInConversation(any(), any(), any()) } returns null

        val response = client.get(Routes.GET_ATTACHMENT_URL) {
            bearerAuth("gfy_test")
            parameter("attachmentId", "pdf-1")
            parameter("conversationId", "conv-1")
        }

        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    @Test
    fun `without a conversationId the caller's own attachment is used`() = testApplication {
        setUpRoutes()
        coEvery { attachmentService.getViewUrl(customerId, "img-1") } returns "https://s3/own?sig"

        for (extra in listOf(null, "")) {
            val response = client.get(Routes.GET_ATTACHMENT_URL) {
                bearerAuth("gfy_test")
                parameter("attachmentId", "img-1")
                extra?.let { parameter("conversationId", it) }
            }
            assertEquals(HttpStatusCode.OK, response.status, "conversationId=$extra")
        }
        coVerify(exactly = 0) { attachmentService.getViewUrlInConversation(any(), any(), any()) }
    }

    @Test
    fun `a missing attachmentId is a 400`() = testApplication {
        setUpRoutes()
        val response = client.get(Routes.GET_ATTACHMENT_URL) {
            bearerAuth("gfy_test")
            parameter("conversationId", "conv-1")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }
}
