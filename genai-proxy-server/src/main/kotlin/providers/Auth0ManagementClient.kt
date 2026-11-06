package com.genflowly.providers

import com.genflowly.config.Auth0ManagementConfig
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import java.net.URLEncoder
import java.time.Instant
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Deletes Auth0 users through the Management API, for account deletion.
 * Authenticates with the client-credentials grant and reuses the token until
 * shortly before it expires. With no [config] every call reports
 * [DeleteResult.NOT_CONFIGURED] and the login survives.
 */
class Auth0ManagementClient(
    private val httpClient: HttpClient,
    private val config: Auth0ManagementConfig?,
    private val clock: () -> Instant = Instant::now
) {
    enum class DeleteResult { DELETED, NOT_FOUND, NOT_CONFIGURED }

    private val tokenLock = Mutex()
    private var token: String? = null
    private var tokenExpiresAt: Instant = Instant.EPOCH

    /** Deletes the user with Auth0 id [sub]. Throws on any other Auth0 error. */
    suspend fun deleteUser(sub: String): DeleteResult {
        val config = config ?: return DeleteResult.NOT_CONFIGURED
        val userId = URLEncoder.encode(sub, Charsets.UTF_8).replace("+", "%20")
        val response = httpClient.delete("https://${config.domain}/api/v2/users/$userId") {
            bearerAuth(accessToken(config))
        }
        return when {
            response.status == HttpStatusCode.NotFound -> DeleteResult.NOT_FOUND
            response.status.isSuccess() -> DeleteResult.DELETED
            else -> error("Auth0 user deletion failed: ${response.status}")
        }
    }

    private suspend fun accessToken(config: Auth0ManagementConfig): String = tokenLock.withLock {
        token?.takeIf { clock().isBefore(tokenExpiresAt) }?.let { return it }
        val response = httpClient.post("https://${config.domain}/oauth/token") {
            contentType(ContentType.Application.Json)
            setBody(
                TokenRequest(
                    clientId = config.clientId,
                    clientSecret = config.clientSecret,
                    audience = "https://${config.domain}/api/v2/",
                    grantType = "client_credentials"
                )
            )
        }
        check(response.status.isSuccess()) { "Auth0 Management API token request failed: ${response.status}" }
        val issued = response.body<TokenResponse>()
        token = issued.accessToken
        tokenExpiresAt = clock().plusSeconds((issued.expiresIn - TOKEN_EXPIRY_MARGIN_SECONDS).coerceAtLeast(0))
        issued.accessToken
    }

    @Serializable
    private data class TokenRequest(
        @SerialName("client_id") val clientId: String,
        @SerialName("client_secret") val clientSecret: String,
        val audience: String,
        // Not defaulted: the shared Json leaves default values out of the body
        @SerialName("grant_type") val grantType: String
    )

    @Serializable
    private data class TokenResponse(
        @SerialName("access_token") val accessToken: String,
        @SerialName("expires_in") val expiresIn: Long = 0
    )

    private companion object {
        const val TOKEN_EXPIRY_MARGIN_SECONDS = 60L
    }
}
