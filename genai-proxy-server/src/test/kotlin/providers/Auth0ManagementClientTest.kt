package com.genflowly.providers

import com.genflowly.config.Auth0ManagementConfig
import com.genflowly.di.provideJson
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.respondError
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Deleting an Auth0 user through the Management API: the client-credentials
 * token request (grant_type included), an encoded user id, a reused token,
 * and a missing user that is not an error.
 */
class Auth0ManagementClientTest {

    private val config = Auth0ManagementConfig("genflowly.us.auth0.com", "m2m-client", "m2m-secret")
    private val requests = mutableListOf<HttpRequestData>()

    private fun client(deleteStatus: HttpStatusCode = HttpStatusCode.NoContent, config: Auth0ManagementConfig? = this.config) =
        Auth0ManagementClient(
            HttpClient(MockEngine { request ->
                requests += request
                when {
                    request.url.encodedPath == "/oauth/token" -> respond(
                        """{"access_token":"tok-1","expires_in":86400,"token_type":"Bearer"}""",
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json")
                    )
                    deleteStatus.value < 400 -> respond("", deleteStatus)
                    else -> respondError(deleteStatus)
                }
            }) {
                install(io.ktor.client.plugins.contentnegotiation.ContentNegotiation) { json(provideJson()) }
            },
            config
        )

    @Test
    fun `deletes the user with a client-credentials token`() = runTest {
        val result = client().deleteUser("auth0|abc 123")

        assertEquals(Auth0ManagementClient.DeleteResult.DELETED, result)
        val token = requests.first()
        assertEquals(HttpMethod.Post, token.method)
        val body = Json.parseToJsonElement((token.body as TextContent).text).jsonObject
        assertEquals("client_credentials", body["grant_type"]?.jsonPrimitive?.content)
        assertEquals("m2m-client", body["client_id"]?.jsonPrimitive?.content)
        assertEquals("https://genflowly.us.auth0.com/api/v2/", body["audience"]?.jsonPrimitive?.content)

        val delete = requests.last()
        assertEquals(HttpMethod.Delete, delete.method)
        assertEquals("/api/v2/users/auth0%7Cabc%20123", delete.url.encodedPath)
        assertEquals("Bearer tok-1", delete.headers[HttpHeaders.Authorization])
    }

    @Test
    fun `the token is reused until it nears expiry`() = runTest {
        val auth0 = client()

        auth0.deleteUser("auth0|a")
        auth0.deleteUser("auth0|b")

        assertEquals(1, requests.count { it.url.encodedPath == "/oauth/token" })
    }

    @Test
    fun `a user that is already gone is not an error`() = runTest {
        assertEquals(Auth0ManagementClient.DeleteResult.NOT_FOUND, client(HttpStatusCode.NotFound).deleteUser("auth0|a"))
    }

    @Test
    fun `any other Auth0 failure throws so the job retries`() = runTest {
        assertFailsWith<IllegalStateException> { client(HttpStatusCode.Forbidden).deleteUser("auth0|a") }
    }

    @Test
    fun `without credentials nothing is called`() = runTest {
        assertEquals(Auth0ManagementClient.DeleteResult.NOT_CONFIGURED, client(config = null).deleteUser("auth0|a"))
        assertEquals(0, requests.size)
    }

    @Test
    fun `the secret never shows in the config's string form`() {
        assertEquals(false, config.toString().contains("m2m-secret"))
    }
}
