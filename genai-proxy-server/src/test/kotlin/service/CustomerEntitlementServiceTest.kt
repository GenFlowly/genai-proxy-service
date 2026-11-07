package com.genflowly.service

import com.genflowly.models.CustomerEntitlements
import com.genflowly.providers.SearchNotConfiguredException
import com.genflowly.providers.SearchSetupReason
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.EmbeddingModelCatalogRepository
import com.genflowly.repository.ProbedModels
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.assertThrows
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Entitlements follow the stored credentials: a vector DB connection, an
 * embedding key that can embed, and a web search key. A profile from before
 * the flags gets them derived once and saved.
 */
class CustomerEntitlementServiceTest {

    private val profiles = mockk<CustomerProfileRepository>(relaxed = true)
    private val credentials = mockk<CustomerCredentialsRepository>()
    private val catalog = mockk<EmbeddingModelCatalogRepository>()
    private val service = CustomerEntitlementService(profiles, credentials, catalog)

    private fun s(value: String) = AttributeValue.builder().s(value).build()

    private fun stored(
        vectorDb: Boolean = false,
        keys: List<Map<String, AttributeValue>> = emptyList(),
        webSearch: Map<String, AttributeValue>? = null,
        rejectedByProbe: Set<String> = emptySet(),
    ) {
        coEvery { credentials.hasVectorDBConfig("CU1") } returns vectorDb
        coEvery { credentials.getCustomerVendorItems("CU1") } returns keys
        coEvery { credentials.getCustomerToolCredentials("CU1", "WEB_SEARCH") } returns webSearch
        coEvery { catalog.getProbed("CU1", any()) } answers {
            if (secondArg<String>() in rejectedByProbe) ProbedModels(emptyList(), null, "fp", authFailed = true) else null
        }
    }

    private fun key(vendor: String, valid: Boolean? = null) = buildMap {
        put("aiVendor", s(vendor))
        put("apiKey", s("enc-$vendor"))
        valid?.let { put("isAPIKeyValid", AttributeValue.builder().bool(it).build()) }
    }

    @Test
    fun `stored flags are used as they are`() = runTest {
        coEvery { profiles.getEntitlements("CU1") } returns ALL_ENTITLEMENTS

        assertEquals(ALL_ENTITLEMENTS, service.get("CU1"))
        coVerify(exactly = 0) { credentials.hasVectorDBConfig(any()) }
        coVerify(exactly = 0) { profiles.saveEntitlements(any(), any()) }
    }

    @Test
    fun `a profile from before the flags gets them derived and saved`() = runTest {
        coEvery { profiles.getEntitlements("CU1") } returns null
        stored(vectorDb = true, keys = listOf(key("VOYAGE")), webSearch = mapOf("credentials" to s("enc")))

        assertEquals(ALL_ENTITLEMENTS, service.get("CU1"))
        coVerify { profiles.saveEntitlements("CU1", ALL_ENTITLEMENTS) }
    }

    @Test
    fun `only a valid key for a vendor that embeds, which the probe accepted, enables embedding`() = runTest {
        stored(keys = listOf(key("HUGGINGFACE"), key("CLAUDE")))
        assertEquals(false, service.refresh("CU1").isEmbeddingCreationEnabled)

        stored(keys = listOf(key("VOYAGE", valid = false)))
        assertEquals(false, service.refresh("CU1").isEmbeddingCreationEnabled)

        stored(keys = listOf(key("OPENAI")), rejectedByProbe = setOf("OPENAI"))
        assertEquals(false, service.refresh("CU1").isEmbeddingCreationEnabled)

        stored(keys = listOf(key("OPENAI")))
        assertEquals(true, service.refresh("CU1").isEmbeddingCreationEnabled)
    }

    @Test
    fun `web search settings saved without a key don't enable web search`() = runTest {
        stored(webSearch = mapOf("settings" to s("""{"max_searches_per_turn":"3"}""")))

        assertEquals(false, service.refresh("CU1").isWebSearchEnabled)
    }

    @Test
    fun `flags that can't be read are unknown, and search still runs`() = runTest {
        coEvery { profiles.getEntitlements("CU1") } throws IllegalStateException("throttled")

        assertNull(service.getOrNull("CU1"))
        service.requireSearchable("CU1")
    }

    @Test
    fun `search names the missing setting, the vector DB first`() = runTest {
        coEvery { profiles.getEntitlements("CU1") } returns CustomerEntitlements()
        assertEquals(
            SearchSetupReason.VECTOR_DB,
            assertThrows<SearchNotConfiguredException> { service.requireSearchable("CU1") }.reason
        )

        coEvery { profiles.getEntitlements("CU1") } returns CustomerEntitlements(isVectorDbStoringEnabled = true)
        assertEquals(
            SearchSetupReason.EMBEDDING_KEY,
            assertThrows<SearchNotConfiguredException> { service.requireSearchable("CU1") }.reason
        )

        coEvery { profiles.getEntitlements("CU1") } returns
            CustomerEntitlements(isVectorDbStoringEnabled = true, isEmbeddingCreationEnabled = true)
        service.requireSearchable("CU1")
    }
}
