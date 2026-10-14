package com.genflowly.activity

import com.genflowly.Routes
import com.genflowly.activity.attachment.registerAttachmentRoutes
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.api.CreateAttachmentUploadResponse
import com.genflowly.providers.S3Provider
import com.genflowly.service.AttachmentService
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

/**
 * POST /attachments over HTTP: any type and size is accepted, and the response
 * carries the EFFECTIVE (normalized) mediaType — the one bound into the
 * presigned PUT, which the client must upload with.
 */
class AttachmentRoutesTest {

    private val customerId = "cust-1"
    private val s3Provider = mockk<S3Provider> {
        coEvery { presignPut(any(), any(), any()) } answers { "https://s3.example/${firstArg<String>()}?sig" }
    }

    private fun ApplicationTestBuilder.setUpRoutes() {
        install(ContentNegotiation) { json() }
        install(Authentication) {
            // Both providers the route accepts; an API-key principal carries the customerId directly
            bearer("auth0") { authenticate { null } }
            bearer("apiKey") { authenticate { ApiKeyPrincipal(customerId) } }
        }
        routing { registerAttachmentRoutes(AttachmentService(s3Provider), mockk(relaxed = true)) }
    }

    private suspend fun ApplicationTestBuilder.createUpload(body: String) =
        client.post(Routes.CREATE_ATTACHMENT) {
            bearerAuth("gfy_test")
            contentType(ContentType.Application.Json)
            setBody(body)
        }

    private fun parse(text: String) = Json.decodeFromString<CreateAttachmentUploadResponse>(text)

    @Test
    fun `a large HEIC photo is accepted and its type returned`() = testApplication {
        setUpRoutes()
        val response = createUpload("""{"fileName":"IMG_0001.HEIC","mediaType":"image/heic","sizeBytes":52428800}""")

        assertEquals(HttpStatusCode.OK, response.status)
        val upload = parse(response.bodyAsText())
        assertEquals("image/heic", upload.mediaType)
        coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, "image/heic", any()) }
    }

    @Test
    fun `the response carries the normalized type, not the declared one`() = testApplication {
        setUpRoutes()
        val response = createUpload("""{"fileName":"a.heic","mediaType":"IMAGE/HEIC; charset=x","sizeBytes":10}""")

        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("image/heic", parse(response.bodyAsText()).mediaType)
    }

    @Test
    fun `an empty or missing type is coerced to octet-stream`() = testApplication {
        setUpRoutes()
        for (body in listOf(
            """{"fileName":"IMG_0002.HEIC","mediaType":"","sizeBytes":10}""",
            """{"fileName":"IMG_0003.HEIC","sizeBytes":10}"""
        )) {
            val response = createUpload(body)
            assertEquals(HttpStatusCode.OK, response.status, body)
            val upload = parse(response.bodyAsText())
            assertEquals("application/octet-stream", upload.mediaType, body)
            coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, "application/octet-stream", any()) }
        }
    }

    @Test
    fun `a declared SVG or HTML page is stored as octet-stream`() = testApplication {
        setUpRoutes()
        for (type in listOf("image/svg+xml", "text/html")) {
            val response = createUpload("""{"fileName":"x","mediaType":"$type","sizeBytes":10}""")
            assertEquals(HttpStatusCode.OK, response.status, type)
            val upload = parse(response.bodyAsText())
            assertEquals("application/octet-stream", upload.mediaType, type)
            coVerify(exactly = 1) { s3Provider.presignPut(upload.s3Key, "application/octet-stream", any()) }
        }
    }

    @Test
    fun `malformed bodies are rejected with 400, not 500`() = testApplication {
        setUpRoutes()
        for (body in listOf(
            "not json",
            """{"fileName":"a","mediaType":"image/png"}""",
            """{"fileName":"a","mediaType":"image/png","sizeBytes":"abc"}"""
        )) {
            assertEquals(HttpStatusCode.BadRequest, createUpload(body).status, body)
        }
    }

    @Test
    fun `a zero size is rejected with 400`() = testApplication {
        setUpRoutes()
        val response = createUpload("""{"fileName":"empty.png","mediaType":"image/png","sizeBytes":0}""")
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }
}
