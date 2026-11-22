package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.api.EmbeddingProviderCatalogResponse
import com.genflowly.models.api.ProviderCatalogResponse
import com.genflowly.models.retrieval.VendorModelMetadata
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.ModelCatalogRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class ModelCatalogServiceTest {

    private val systemKeys = mockk<SystemApiKeyService>()
    private val catalogRepo = mockk<ModelCatalogRepository>(relaxed = true)
    private val retrieval = mockk<RetrievalServerClient>()
    private val service = ModelCatalogService(systemKeys, catalogRepo, retrieval)

    private fun givenSystemKeys(vararg keys: Pair<AIVendor, String>) {
        val byVendor = keys.toMap()
        AIVendor.entries.forEach { vendor ->
            coEvery { systemKeys.getSystemApiKeyForVendor(vendor) } returns byVendor[vendor]
        }
        coEvery { systemKeys.markSystemApiKeyInvalid(any(), any()) } returns true
        coEvery { retrieval.getProviderCatalog() } returns ProviderCatalogResponse(emptyList())
        coEvery { retrieval.getEmbeddingProviderCatalog() } returns EmbeddingProviderCatalogResponse(emptyList())
    }

    @Test
    fun `a key the vendor rejects is marked invalid, other failures leave keys alone`() = runTest {
        givenSystemKeys(AIVendor.CLAUDE to "sk-ant", AIVendor.OPENAI to "sk-oai")
        coEvery { retrieval.fetchModelMetadata(any()) } returns listOf(
            VendorModelMetadata(AIVendor.CLAUDE, emptyList(), error = "401 Unauthorized: invalid x-api-key", authFailed = true),
            VendorModelMetadata(AIVendor.OPENAI, emptyList(), error = "503 Service Unavailable")
        )

        service.refreshCatalog()

        coVerify(exactly = 1) { systemKeys.markSystemApiKeyInvalid(AIVendor.CLAUDE, "sk-ant") }
        coVerify(exactly = 0) { systemKeys.markSystemApiKeyInvalid(AIVendor.OPENAI, any()) }
    }

    @Test
    fun `failing to mark a key invalid doesn't abort the refresh`() = runTest {
        givenSystemKeys(AIVendor.CLAUDE to "sk-ant")
        coEvery { systemKeys.markSystemApiKeyInvalid(any(), any()) } throws RuntimeException("ddb down")
        coEvery { retrieval.fetchModelMetadata(any()) } returns listOf(
            VendorModelMetadata(AIVendor.CLAUDE, emptyList(), error = "401 Unauthorized", authFailed = true)
        )

        assertEquals(emptyMap(), service.refreshCatalog())
        coVerify { retrieval.getProviderCatalog() }
    }
}
