package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.EmbeddingVendor
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.KeyValidationResult
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerCredentialsRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

/**
 * Every credential change re-derives the customer's entitlements. A key the
 * vendor rejected is never stored, so nothing is re-derived.
 */
class CustomerCredentialsEntitlementsTest {

    private val kms = mockk<KMSProvider>()
    private val credsRepo = mockk<CustomerCredentialsRepository>(relaxed = true)
    private val retrieval = mockk<RetrievalServerClient>()
    private val entitlements = mockk<CustomerEntitlementService>(relaxed = true)
    private val service = CustomerCredentialsService(
        kms, credsRepo, mockk(relaxed = true), mockk(relaxed = true), retrieval,
        mockk(relaxed = true), AppScope(), mockk(relaxed = true), entitlements
    )

    init {
        coEvery { kms.encrypt(any()) } answers { "enc-${firstArg<String>()}" }
    }

    @Test
    fun `connecting a vector DB refreshes the entitlements`() = runTest {
        service.storeCustomerVectorDBConfig("CU1", "ZILLIZ", "https://db.example", "token")

        coVerify { entitlements.refresh("CU1") }
    }

    @Test
    fun `saving or removing a tool key refreshes the entitlements`() = runTest {
        service.storeToolCredentials("CU1", "WEB_SEARCH", "api_key", mapOf("api_key" to "tvly-1"))
        service.removeToolCredentials("CU1", "WEB_SEARCH")

        coVerify(exactly = 2) { entitlements.refresh("CU1") }
    }

    @Test
    fun `deleting every key refreshes the entitlements`() = runTest {
        service.deleteAllCredentials("CU1")

        coVerify { entitlements.refresh("CU1") }
    }

    @Test
    fun `a valid embedding key refreshes the entitlements and a rejected one doesn't`() = runTest {
        coEvery { retrieval.validateProviderKeyDetailed("voyage", "bad") } returns KeyValidationResult(valid = false, error = "401")
        coEvery { retrieval.validateProviderKeyDetailed("voyage", "good") } returns KeyValidationResult(valid = true)

        service.validateAndStoreEmbeddingKey("CU1", EmbeddingVendor.VOYAGE, "bad")
        coVerify(exactly = 0) { entitlements.refresh(any()) }

        service.validateAndStoreEmbeddingKey("CU1", EmbeddingVendor.VOYAGE, "good")
        coVerify(exactly = 1) { entitlements.refresh("CU1") }
    }
}
