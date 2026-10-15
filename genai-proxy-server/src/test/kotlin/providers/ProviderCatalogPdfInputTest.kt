package com.genflowly.providers

import com.genflowly.di.provideJson
import com.genflowly.models.api.ProviderCatalogResponse
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.HttpTimeout
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.DefaultJson
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mu.KotlinLogging
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * C7: each model of the provider catalog the UI reads carries
 * supportsPdfInput, passed through from the retrieval-server's /providers
 * (false when the retrieval-server does not send it).
 */
class ProviderCatalogPdfInputTest {

    private fun client(body: String) = RetrievalServerClient(
        KotlinLogging.logger("ProviderCatalogPdfInputTest"),
        provideJson(),
        HttpClient(MockEngine {
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }) { install(HttpTimeout) },
        "http://retrieval-server:5001"
    )

    private val retrievalBody = """
        {"providers":[{"id":"anthropic","displayName":"Claude","native":true,"models":[
          {"name":"claude-x","supportsTools":true,"supportsPdfInput":true},
          {"name":"claude-y","supportsTools":true,"supportsPdfInput":false},
          {"name":"claude-z","supportsTools":false}
        ]}]}
    """.trimIndent()

    @Test
    fun `the flag is passed through per model and defaults to false`() = runTest {
        val catalog = client(retrievalBody).getProviderCatalog()

        val models = catalog.providers.single().models.associate { it.name to it.supportsPdfInput }
        assertEquals(mapOf("claude-x" to true, "claude-y" to false, "claude-z" to false), models)
    }

    @Test
    fun `the proxy's response to the UI always carries the flag`() = runTest {
        val catalog = client(retrievalBody).getProviderCatalog()

        // Ktor's ContentNegotiation json() encodes with DefaultJson (defaults included)
        val encoded = DefaultJson.parseToJsonElement(DefaultJson.encodeToString<ProviderCatalogResponse>(catalog))
        val flags = encoded.jsonObject["providers"]!!.jsonArray.single().jsonObject["models"]!!.jsonArray
            .map { it.jsonObject["supportsPdfInput"]!!.jsonPrimitive.boolean }
        assertEquals(listOf(true, false, false), flags)
    }
}
