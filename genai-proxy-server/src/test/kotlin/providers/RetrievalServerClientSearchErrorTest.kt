package com.genflowly.providers

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import mu.KotlinLogging
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

/**
 * Unified /search: a failed search is never reported as an empty one (L2-001).
 * A 409 names the missing customer setting; any other error status is a
 * generic failure.
 */
class RetrievalServerClientSearchErrorTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun client(status: HttpStatusCode, body: String) = RetrievalServerClient(
        KotlinLogging.logger("RetrievalServerClientSearchErrorTest"),
        json,
        HttpClient(MockEngine {
            respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { install(HttpTimeout) },
        "http://retrieval-server:5001"
    )

    private suspend fun RetrievalServerClient.search() = search("CU-1", "tests", topN = 10)

    @Test
    fun `a 409 for a missing vector DB names that setting`() = runTest {
        val error = assertThrows<SearchNotConfiguredException> {
            client(
                HttpStatusCode.Conflict,
                """{"detail":{"error_type":"vector_db_not_configured","message":"No vector DB configured for customer 'CU-1'."}}"""
            ).search()
        }
        assertEquals(SearchSetupReason.VECTOR_DB, error.reason)
        assertEquals("No vector DB configured for customer 'CU-1'.", error.message)
    }

    @Test
    fun `a 409 for a missing embedding key names that setting`() = runTest {
        val error = assertThrows<SearchNotConfiguredException> {
            client(
                HttpStatusCode.Conflict,
                """{"detail":{"error_type":"embedding_key_missing","message":"No API key available for embedding provider 'voyage'"}}"""
            ).search()
        }
        assertEquals(SearchSetupReason.EMBEDDING_KEY, error.reason)
    }

    @Test
    fun `a 409 with the older plain-string detail is still read`() = runTest {
        val vectorDb = assertThrows<SearchNotConfiguredException> {
            client(HttpStatusCode.Conflict, """{"detail":"No vector DB configured for customer 'CU-1'."}""").search()
        }
        assertEquals(SearchSetupReason.VECTOR_DB, vectorDb.reason)
        assertEquals("No vector DB configured for customer 'CU-1'.", vectorDb.message)

        val embeddingKey = assertThrows<SearchNotConfiguredException> {
            client(
                HttpStatusCode.Conflict,
                """{"detail":"No API key available for embedding provider 'voyage' — the customer has not stored one."}"""
            ).search()
        }
        assertEquals(SearchSetupReason.EMBEDDING_KEY, embeddingKey.reason)
    }

    @Test
    fun `other error statuses are a failure, not an empty result`() = runTest {
        for ((status, body) in listOf(
            HttpStatusCode.InternalServerError to """{"detail":"Search failed"}""",
            HttpStatusCode.BadRequest to """{"detail":"customer_id and query are required"}""",
            HttpStatusCode.BadGateway to "not json"
        )) {
            val error = assertThrows<SearchUnavailableException>(body) { client(status, body).search() }
            assertEquals(status.value, error.status)
        }
    }

    @Test
    fun `a successful search returns its hits`() = runTest {
        val hits = client(
            HttpStatusCode.OK,
            """{"results":[{"type":"notes","key":"N-1","score":0.8,"snippet":"s","title":"t","matched_chunks":2}]}"""
        ).search()
        assertEquals(listOf("N-1"), hits.map { it.key })
        assertEquals(2, hits.single().matchedChunks)
    }
}
