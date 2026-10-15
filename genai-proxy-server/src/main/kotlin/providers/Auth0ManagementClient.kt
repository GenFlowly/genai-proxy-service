package com.genflowly.providers

import com.genflowly.config.PurgeConfig
import io.ktor.client.HttpClient
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.delete
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import mu.KLogger

/**
 * Auth0 client-credentials (machine-to-machine) tokens for the purge's
 * server-to-server calls: the Auth0 Management API (user deletion) and the
 * encoding-server's POST /purge-vectors. One cached token per audience,
 * refreshed a minute before it expires.
 */
class Auth0M2MTokenProvider(
    private val httpClient: HttpClient,
    private val config: PurgeConfig,
    private val logger: KLogger,
    private val clock: () -> Instant = Instant::now
) {
    private data class CachedToken(val value: String, val expiresAt: Instant)

    private val cache = ConcurrentHashMap<String, CachedToken>()

    val isConfigured: Boolean get() = config.auth0ManagementConfigured

    /** An access token for [audience]; throws when Auth0 refuses or is unreachable. */
    suspend fun token(audience: String): String {
        check(isConfigured) { "Auth0 machine-to-machine credentials are not configured" }
        cache[audience]?.takeIf { it.expiresAt.isAfter(clock().plusSeconds(60)) }?.let { return it.value }

        val response = httpClient.post("https://${config.auth0ManagementDomain}/oauth/token") {
            contentType(ContentType.Application.Json)
            setBody(
                JsonObject(
                    mapOf(
                        "grant_type" to JsonPrimitive("client_credentials"),
                        "client_id" to JsonPrimitive(config.auth0ManagementClientId),
                        "client_secret" to JsonPrimitive(config.auth0ManagementClientSecret),
                        "audience" to JsonPrimitive(audience)
                    )
                ).toString()
            )
        }
        if (!response.status.isSuccess()) {
            // The body may echo request details: status only
            throw IllegalStateException("Auth0 token request failed with ${response.status.value}")
        }
        val body = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        val token = body["access_token"]?.jsonPrimitive?.content
            ?: throw IllegalStateException("Auth0 token response has no access_token")
        val expiresIn = body["expires_in"]?.jsonPrimitive?.longOrNull ?: 3600L
        cache[audience] = CachedToken(token, clock().plusSeconds(expiresIn))
        logger.info { "Obtained an Auth0 machine-to-machine token for audience $audience" }
        return token
    }
}

/** Auth0 Management API calls the customer purge needs. */
class Auth0ManagementClient(
    private val httpClient: HttpClient,
    private val tokenProvider: Auth0M2MTokenProvider,
    private val config: PurgeConfig,
    private val logger: KLogger
) {
    enum class DeleteResult { DELETED, ALREADY_GONE, NOT_CONFIGURED }

    /**
     * Deletes the Auth0 user [userId] (the JWT sub). Idempotent: a user that
     * no longer exists is ALREADY_GONE. NOT_CONFIGURED without Management API
     * credentials. Throws on any other failure, so the purge retries.
     */
    suspend fun deleteUser(userId: String): DeleteResult {
        if (!tokenProvider.isConfigured) return DeleteResult.NOT_CONFIGURED
        val token = tokenProvider.token("https://${config.auth0ManagementDomain}/api/v2/")
        val response = httpClient.delete(
            "https://${config.auth0ManagementDomain}/api/v2/users/${userId.encodeURLPathPart()}"
        ) {
            bearerAuth(token)
        }
        return when {
            response.status.isSuccess() -> DeleteResult.DELETED
            response.status == HttpStatusCode.NotFound -> DeleteResult.ALREADY_GONE
            else -> {
                logger.warn { "Auth0 user deletion returned ${response.status.value}" }
                throw IllegalStateException("Auth0 user deletion failed with ${response.status.value}")
            }
        }
    }
}
