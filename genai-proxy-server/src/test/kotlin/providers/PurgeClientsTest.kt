package com.genflowly.providers

import com.genflowly.config.PurgeConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.DeleteMarkerEntry
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest
import software.amazon.awssdk.services.s3.model.DeleteObjectsResponse
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest
import software.amazon.awssdk.services.s3.model.ListObjectVersionsResponse
import software.amazon.awssdk.services.s3.model.ObjectVersion
import software.amazon.awssdk.services.s3.model.S3Error
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PurgeClientsTest {

    private val logger = KotlinLogging.logger("PurgeClientsTest")
    private val requests = mutableListOf<HttpRequestData>()

    private fun http(handler: MockRequestHandleScope.(HttpRequestData) -> HttpResponseData) =
        HttpClient(MockEngine { request -> requests += request; handler(request) })

    private fun MockRequestHandleScope.json(body: String, status: HttpStatusCode = HttpStatusCode.OK) =
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))

    private fun HttpRequestData.bodyText() = (body as OutgoingContent.ByteArrayContent).bytes().decodeToString()

    // ── retrieval-server run data ────────────────────────────────────────────

    @Test
    fun `run state distinguishes finished, unknown and live runs, and fails on errors`() = runTest {
        val client = RunDataClient(logger, http { request ->
            when (request.url.encodedPath) {
                "/runs/run_done" -> json("""{"run_id":"run_done","status":"SUCCESS"}""")
                "/runs/run_live" -> json("""{"run_id":"run_live","status":"PENDING"}""")
                "/runs/run_gone" -> json("""{"detail":"run not found"}""", HttpStatusCode.NotFound)
                else -> json("""{"detail":"durable runs are not available"}""", HttpStatusCode.ServiceUnavailable)
            }
        }, "http://retrieval:5001")

        assertEquals(RunDataClient.RunState.TERMINAL, client.runState("run_done"))
        assertEquals(RunDataClient.RunState.ACTIVE, client.runState("run_live"))
        assertEquals(RunDataClient.RunState.UNKNOWN, client.runState("run_gone"))
        assertFailsWith<IllegalStateException> { client.runState("run_x") }
        assertFailsWith<IllegalArgumentException> { client.runState("../admin") }
    }

    @Test
    fun `run data deletion is idempotent and fails loudly otherwise`() = runTest {
        val client = RunDataClient(logger, http { request ->
            when (request.url.encodedPath) {
                "/runs/run_1/data" -> respond("", HttpStatusCode.NoContent)
                "/runs/run_2/data" -> json("{}", HttpStatusCode.NotFound)
                else -> json("{}", HttpStatusCode.InternalServerError)
            }
        }, "http://retrieval:5001")

        client.deleteRunData("run_1")
        client.deleteRunData("run_2")
        assertTrue(requests.all { it.method == HttpMethod.Delete })
        assertFailsWith<IllegalStateException> { client.deleteRunData("run_3") }
    }

    // ── Auth0 ────────────────────────────────────────────────────────────────

    private val configured = PurgeConfig("tenant.auth0.com", "m2m-id", "m2m-secret", "https://api.genflowly.com", "bucket")
    private val unconfigured = PurgeConfig(null, null, null, null, "bucket")

    @Test
    fun `the Auth0 user is deleted with a cached machine-to-machine token`() = runTest {
        val httpClient = http { request ->
            when {
                request.url.encodedPath == "/oauth/token" -> json("""{"access_token":"tok-1","expires_in":86400}""")
                request.url.encodedPath.startsWith("/api/v2/users/") -> respond("", HttpStatusCode.NoContent)
                else -> json("{}", HttpStatusCode.BadRequest)
            }
        }
        val tokens = Auth0M2MTokenProvider(httpClient, configured, logger) { Instant.parse("2026-10-15T00:00:00Z") }
        val auth0 = Auth0ManagementClient(httpClient, tokens, configured, logger)

        assertEquals(Auth0ManagementClient.DeleteResult.DELETED, auth0.deleteUser("auth0|abc"))
        assertEquals(Auth0ManagementClient.DeleteResult.DELETED, auth0.deleteUser("google-oauth2|123"))

        val tokenRequests = requests.filter { it.url.encodedPath == "/oauth/token" }
        assertEquals(1, tokenRequests.size)
        val tokenBody = Json.parseToJsonElement(tokenRequests.single().bodyText()).jsonObject
        assertEquals("client_credentials", tokenBody["grant_type"]!!.jsonPrimitive.content)
        assertEquals("https://tenant.auth0.com/api/v2/", tokenBody["audience"]!!.jsonPrimitive.content)
        val deletes = requests.filter { it.method == HttpMethod.Delete }
        assertEquals("/api/v2/users/auth0%7Cabc", deletes[0].url.encodedPath)
        assertEquals("Bearer tok-1", deletes[0].headers[HttpHeaders.Authorization])
    }

    @Test
    fun `an Auth0 user that is already gone counts as deleted, other failures throw`() = runTest {
        var status = HttpStatusCode.NotFound
        val httpClient = http { request ->
            if (request.url.encodedPath == "/oauth/token") json("""{"access_token":"tok","expires_in":3600}""")
            else json("{}", status)
        }
        val auth0 = Auth0ManagementClient(httpClient, Auth0M2MTokenProvider(httpClient, configured, logger), configured, logger)

        assertEquals(Auth0ManagementClient.DeleteResult.ALREADY_GONE, auth0.deleteUser("auth0|abc"))
        status = HttpStatusCode.Forbidden
        assertFailsWith<IllegalStateException> { auth0.deleteUser("auth0|abc") }
    }

    @Test
    fun `without Management API credentials nothing is called`() = runTest {
        val httpClient = http { json("{}") }
        val auth0 = Auth0ManagementClient(httpClient, Auth0M2MTokenProvider(httpClient, unconfigured, logger), unconfigured, logger)

        assertEquals(Auth0ManagementClient.DeleteResult.NOT_CONFIGURED, auth0.deleteUser("auth0|abc"))
        assertTrue(requests.isEmpty())
    }

    // ── encoding-server vector purge ─────────────────────────────────────────

    @Test
    fun `vector purges are sent with a service token for the configured audience`() = runTest {
        val httpClient = http { request ->
            if (request.url.encodedPath == "/oauth/token") json("""{"access_token":"svc-tok","expires_in":3600}""")
            else json("""{"action":"ok"}""")
        }
        val client = EncodingPurgeClient(
            httpClient, logger, "https://encoding.example/development",
            Auth0M2MTokenProvider(httpClient, configured, logger), configured.encodingPurgeAudience
        )

        client.deleteConversationVectors("CU1", "conv-1")
        client.dropCustomerCollections("CU1")

        val tokenAudience = Json.parseToJsonElement(requests.first().bodyText()).jsonObject["audience"]!!.jsonPrimitive.content
        assertEquals("https://api.genflowly.com", tokenAudience)
        val purges = requests.filter { it.url.encodedPath == "/development/purge-vectors" }
        assertEquals(
            listOf("""{"customerId":"CU1","conversationId":"conv-1"}""", """{"customerId":"CU1","dropCollections":true}"""),
            purges.map { it.bodyText() }
        )
        assertTrue(purges.all { it.headers[HttpHeaders.Authorization] == "Bearer svc-tok" })
    }

    @Test
    fun `a vector purge failure throws, and an unconfigured client says so`() = runTest {
        val httpClient = http { request ->
            if (request.url.encodedPath == "/oauth/token") json("""{"access_token":"t","expires_in":3600}""")
            else json("""{"error":"Forbidden"}""", HttpStatusCode.Forbidden)
        }
        val tokens = Auth0M2MTokenProvider(httpClient, configured, logger)
        assertFailsWith<IllegalStateException> {
            EncodingPurgeClient(httpClient, logger, "https://e.example", tokens, "aud").dropCustomerCollections("CU1")
        }
        assertEquals(false, EncodingPurgeClient(httpClient, logger, null, tokens, "aud").isConfigured)
        assertEquals(false, EncodingPurgeClient(httpClient, logger, "https://e.example", tokens, null).isConfigured)
    }

    // ── customer-documents bucket ────────────────────────────────────────────

    @Test
    fun `every version and delete marker under the customer prefix is deleted`() = runTest {
        val s3 = mockk<S3Client>()
        val lists = mutableListOf<ListObjectVersionsRequest>()
        every { s3.listObjectVersions(capture(lists)) } answers {
            if (lists.size == 1) {
                ListObjectVersionsResponse.builder()
                    .versions(
                        ObjectVersion.builder().key("CU1/notes/a.json").versionId("v1").build(),
                        ObjectVersion.builder().key("CU1/notes/a.json").versionId("v2").build()
                    )
                    .deleteMarkers(DeleteMarkerEntry.builder().key("CU1/emails/m.json").versionId("d1").build())
                    .isTruncated(true).nextKeyMarker("CU1/notes/a.json").nextVersionIdMarker("v2")
                    .build()
            } else {
                ListObjectVersionsResponse.builder()
                    .versions(ObjectVersion.builder().key("CU1/notes/b.json").versionId("v3").build())
                    .isTruncated(false)
                    .build()
            }
        }
        val deletes = mutableListOf<DeleteObjectsRequest>()
        every { s3.deleteObjects(capture(deletes)) } answers {
            // The first call reports one transient per-key error; the retry succeeds
            if (deletes.size == 1) {
                DeleteObjectsResponse.builder()
                    .errors(S3Error.builder().key("CU1/notes/b.json").versionId("v3").code("InternalError").build())
                    .build()
            } else DeleteObjectsResponse.builder().build()
        }

        val deleted = CustomerDocumentsPurger(s3, "genflowly-development-customer-documents", logger).purgeCustomer("CU1")

        assertEquals(4, deleted)
        assertEquals(listOf("CU1/", "CU1/"), lists.map { it.prefix() })
        assertEquals("v2", lists[1].versionIdMarker())
        assertEquals(4, deletes[0].delete().objects().size)
        assertTrue(deletes[0].delete().quiet())
        assertEquals(listOf("CU1/notes/b.json" to "v3"), deletes[1].delete().objects().map { it.key() to it.versionId() })
    }

    @Test
    fun `a malformed customer id never becomes a bucket-wide prefix`() = runTest {
        val purger = CustomerDocumentsPurger(mockk(), "bucket", logger)
        for (id in listOf("", "CU1/..", "a b", "x".repeat(65))) {
            assertFailsWith<IllegalArgumentException> { purger.purgeCustomer(id) }
        }
    }
}
