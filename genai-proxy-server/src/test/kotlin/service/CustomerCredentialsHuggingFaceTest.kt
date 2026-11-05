package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.di.AppScope
import com.genflowly.models.AIVendor
import com.genflowly.models.APIKeyStatus
import com.genflowly.models.EmbeddingVendor
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.KeyValidationResult
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

/**
 * The HUGGINGFACE row in CustomerVendorApiKeys is a Hub download token, not an
 * AI-vendor key: it must flow through the embedding-key store/status/delete
 * endpoints while staying invisible to every AI/embedding vendor listing. The
 * "HUGGINGFACE" sort key is a contract with the retrieval server.
 */
class CustomerCredentialsHuggingFaceTest {

    private val kms = mockk<KMSProvider>()
    private val credsRepo = mockk<CustomerCredentialsRepository>(relaxed = true)
    private val profileRepo = mockk<CustomerProfileRepository>()
    private val encoding = mockk<EncodingServerClient>(relaxed = true)
    private val retrieval = mockk<RetrievalServerClient>()
    private val allowlist = mockk<VendorAllowlistService>()
    private val catalog = mockk<EmbeddingModelCatalogService>(relaxed = true)
    private val service = CustomerCredentialsService(
        kms, credsRepo, profileRepo, encoding, retrieval, allowlist, AppScope(), catalog
    )

    private val cid = "CU1"

    private fun keyItem(vendor: String, encryptedKey: String, model: String? = null, priority: Int? = null) =
        buildMap {
            put(DynamoDBConstants.CUSTOMER_ID_KEY, AttributeValue.builder().s(cid).build())
            put(DynamoDBConstants.AI_VENDOR_KEY, AttributeValue.builder().s(vendor).build())
            put("apiKey", AttributeValue.builder().s(encryptedKey).build())
            put("isAPIKeyValid", AttributeValue.builder().bool(true).build())
            model?.let { put("selectedModel", AttributeValue.builder().s(it).build()) }
            priority?.let { put("priority", AttributeValue.builder().n(it.toString()).build()) }
        }

    @Test
    fun `HUGGINGFACE is not a text-generation vendor`() {
        assertNull(AIVendor.fromStoredNameOrNull("HUGGINGFACE"))
        assertNull(AIVendor.fromStoredNameOrNull("VOYAGE"))
        assertEquals(AIVendor.OPENAI, AIVendor.fromStoredNameOrNull("OPENAI"))
    }

    @Test
    fun `storing the HUGGINGFACE token encrypts and stores without provider validation or probe`() = runTest {
        coEvery { kms.encrypt("hf_abc") } returns "enc-hf"

        val status = service.validateAndStoreEmbeddingKey(cid, EmbeddingVendor.HUGGINGFACE, "hf_abc")

        assertEquals(EmbeddingVendor.HUGGINGFACE, status.vendor)
        assertEquals(APIKeyStatus.VALID, status.status)
        assertTrue(status.updateSuccessful)
        coVerify { credsRepo.saveCustomerApiKey(cid, "HUGGINGFACE", "enc-hf") }
        coVerify(exactly = 0) { retrieval.validateProviderKeyDetailed(any(), any()) }
        verify(exactly = 0) { catalog.probeOnKeyChangeAsync(any(), any(), any()) }
    }

    @Test
    fun `storing a VOYAGE key still validates against the provider`() = runTest {
        coEvery { retrieval.validateProviderKeyDetailed("voyage", "pa-key") } returns KeyValidationResult(valid = true)
        coEvery { kms.encrypt("pa-key") } returns "enc-voyage"

        val status = service.validateAndStoreEmbeddingKey(cid, EmbeddingVendor.VOYAGE, "pa-key")

        assertEquals(APIKeyStatus.VALID, status.status)
        coVerify { retrieval.validateProviderKeyDetailed("voyage", "pa-key") }
        coVerify { credsRepo.saveCustomerApiKey(cid, "VOYAGE", "enc-voyage") }
    }

    @Test
    fun `key statuses include HUGGINGFACE but never consult the embed-probe cache for it`() = runTest {
        coEvery { credsRepo.getCustomerVendorItems(cid) } returns listOf(keyItem("HUGGINGFACE", "enc-hf"))
        coEvery { catalog.cachedKeyCannotEmbed(cid, any()) } returns false

        val statuses = service.getEmbeddingKeyStatuses(cid)

        assertEquals(
            setOf(EmbeddingVendor.OPENAI, EmbeddingVendor.VOYAGE, EmbeddingVendor.HUGGINGFACE),
            statuses.map { it.vendor }.toSet()
        )
        assertEquals(APIKeyStatus.VALID, statuses.first { it.vendor == EmbeddingVendor.HUGGINGFACE }.status)
        assertEquals(APIKeyStatus.NOT_SET, statuses.first { it.vendor == EmbeddingVendor.VOYAGE }.status)
        coVerify(exactly = 0) { catalog.cachedKeyCannotEmbed(cid, EmbeddingVendor.HUGGINGFACE) }
    }

    @Test
    fun `embedding model listing never includes HUGGINGFACE even with a stored token`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("OPENAI", cid) } returns null
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns null
        coEvery { credsRepo.getCustomerApiKey("HUGGINGFACE", cid) } returns "enc-hf"
        coEvery { kms.decrypt("enc-hf") } returns "hf_abc"

        assertTrue(service.getEmbeddingModels(cid).isEmpty())
        coVerify(exactly = 0) { catalog.getCatalog(any(), EmbeddingVendor.HUGGINGFACE, any()) }
    }

    @Test
    fun `AI-vendor key readers skip the HUGGINGFACE row`() = runTest {
        coEvery { profileRepo.getAIConfigPreferences(cid) } returns null
        coEvery { credsRepo.getCustomerVendorItems(cid) } returns listOf(
            // Config attributes present, so exclusion can only come from the vendor itself.
            keyItem("HUGGINGFACE", "enc-hf", model = "some-model", priority = 1),
            keyItem("OPENAI", "enc-openai", model = "gpt-5", priority = 2)
        )
        coEvery { kms.decrypt("enc-openai") } returns "sk-key"

        assertEquals(AIVendor.OPENAI, service.getPrimaryProvider(cid)?.aiVendor)
    }

    @Test
    fun `delete removes the HUGGINGFACE row and rejects embedding vendors`() = runTest {
        service.deleteEmbeddingKey(cid, EmbeddingVendor.HUGGINGFACE)
        coVerify { credsRepo.deleteCustomerApiKey(cid, "HUGGINGFACE") }

        assertFailsWith<IllegalArgumentException> { service.deleteEmbeddingKey(cid, EmbeddingVendor.VOYAGE) }
        assertFailsWith<IllegalArgumentException> { service.deleteEmbeddingKey(cid, EmbeddingVendor.OPENAI) }
    }
}
