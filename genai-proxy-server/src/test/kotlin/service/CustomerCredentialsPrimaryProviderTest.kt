package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.di.AppScope
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Background tasks run on the customer's primary provider only, so which key
 * counts as primary decides which vendor sees titles and memory work: the
 * lowest priority, else the key added first, never an invalid key.
 */
class CustomerCredentialsPrimaryProviderTest {

    private val cid = "CU1"
    private val kms = mockk<KMSProvider> {
        coEvery { decrypt(any()) } answers { "plain-" + firstArg<String>() }
    }
    private val credsRepo = mockk<CustomerCredentialsRepository>()
    private val profileRepo = mockk<CustomerProfileRepository> {
        coEvery { getAIConfigPreferences(any()) } returns null
    }
    private val service = CustomerCredentialsService(
        kms, credsRepo, profileRepo, mockk<EncodingServerClient>(relaxed = true),
        mockk<RetrievalServerClient>(), mockk<VendorAllowlistService>(), AppScope(),
        mockk<EmbeddingModelCatalogService>(relaxed = true), mockk<CustomerEntitlementService>(relaxed = true)
    )

    private fun keyItem(
        vendor: String,
        priority: Int? = null,
        createdAt: String? = null,
        valid: Boolean = true,
        model: String? = null
    ) = buildMap {
        put(DynamoDBConstants.CUSTOMER_ID_KEY, AttributeValue.builder().s(cid).build())
        put(DynamoDBConstants.AI_VENDOR_KEY, AttributeValue.builder().s(vendor).build())
        put("apiKey", AttributeValue.builder().s("enc-$vendor").build())
        put("isAPIKeyValid", AttributeValue.builder().bool(valid).build())
        priority?.let { put("priority", AttributeValue.builder().n(it.toString()).build()) }
        createdAt?.let { put("createdAt", AttributeValue.builder().s(it).build()) }
        model?.let { put("selectedModel", AttributeValue.builder().s(it).build()) }
    }

    private fun keys(vararg items: Map<String, AttributeValue>) {
        coEvery { credsRepo.getCustomerVendorItems(cid) } returns items.toList()
    }

    @Test
    fun `the lowest priority wins over the key added first`() = runTest {
        keys(
            keyItem("OPENAI", priority = 2, createdAt = "2026-01-01T00:00:00Z"),
            keyItem("CLAUDE", priority = 1, createdAt = "2026-06-01T00:00:00Z")
        )

        val primary = service.getPrimaryProvider(cid)

        assertEquals(AIVendor.CLAUDE, primary?.aiVendor)
        assertEquals("plain-enc-CLAUDE", primary?.apiKey)
    }

    @Test
    fun `with no priority set, the key added first is primary`() = runTest {
        keys(
            keyItem("OPENAI", createdAt = "2026-03-01T00:00:00Z"),
            keyItem("GEMINI", createdAt = "2026-01-01T00:00:00.250Z")
        )

        assertEquals(AIVendor.GEMINI, service.getPrimaryProvider(cid)?.aiVendor)
    }

    @Test
    fun `an invalid key is never primary`() = runTest {
        keys(
            keyItem("CLAUDE", priority = 1, valid = false),
            keyItem("OPENAI", priority = 2)
        )

        assertEquals(AIVendor.OPENAI, service.getPrimaryProvider(cid)?.aiVendor)
    }

    @Test
    fun `undated legacy keys rank after dated ones, then in legacy-vendor order`() = runTest {
        keys(keyItem("CLAUDE"), keyItem("OPENAI"))
        assertEquals(AIVendor.OPENAI, service.getPrimaryProvider(cid)?.aiVendor)

        keys(keyItem("CLAUDE"), keyItem("groq", createdAt = "2026-02-01T00:00:00Z"))
        assertEquals(AIVendor.of("groq"), service.getPrimaryProvider(cid)?.aiVendor)
    }

    @Test
    fun `the chat model comes from the saved preferences, else the key's selected model`() = runTest {
        keys(keyItem("CLAUDE", priority = 1, model = "claude-sonnet-4-5"))
        assertEquals("claude-sonnet-4-5", service.getPrimaryProvider(cid)?.chatModel)

        coEvery { profileRepo.getAIConfigPreferences(cid) } returns AIConfigPreferences(
            preferredModels = listOf(
                AIConfig(AIVendor.OPENAI, "gpt-5"),
                AIConfig(AIVendor.CLAUDE, "claude-opus-4-1")
            )
        )
        assertEquals("claude-opus-4-1", service.getPrimaryProvider(cid)?.chatModel)
    }

    @Test
    fun `only the primary key is decrypted`() = runTest {
        keys(keyItem("OPENAI", priority = 1), keyItem("CLAUDE", priority = 2), keyItem("GEMINI"))

        service.getPrimaryProvider(cid)

        coVerify(exactly = 1) { kms.decrypt(any()) }
        coVerify { kms.decrypt("enc-OPENAI") }
    }

    @Test
    fun `no valid AI key means no primary`() = runTest {
        keys(keyItem("VOYAGE", priority = 1), keyItem("OPENAI", valid = false))

        assertNull(service.getPrimaryProvider(cid))
    }
}
