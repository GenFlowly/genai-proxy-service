package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.SystemApiKeyRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SystemApiKeyServiceTest {

    private val kms = mockk<KMSProvider>()
    private val repo = mockk<SystemApiKeyRepository>()
    private val service = SystemApiKeyService(kms, repo, mockk<RetrievalServerClient>())

    private fun storedKey(ciphertext: String, plaintext: String) {
        coEvery { repo.getSystemApiKeyItem("CLAUDE") } returns
                mapOf("apiKey" to AttributeValue.builder().s(ciphertext).build())
        coEvery { kms.decrypt(ciphertext) } returns plaintext
    }

    @Test
    fun `the rejected key is marked invalid, pinned to its ciphertext`() = runTest {
        storedKey("enc-old", "sk-old")
        coEvery { repo.markSystemApiKeyInvalid("CLAUDE", "enc-old") } returns true

        assertTrue(service.markSystemApiKeyInvalid(AIVendor.CLAUDE, "sk-old"))
        coVerify { repo.markSystemApiKeyInvalid("CLAUDE", "enc-old") }
    }

    @Test
    fun `a key rotated since the check is left valid`() = runTest {
        storedKey("enc-new", "sk-new")

        assertFalse(service.markSystemApiKeyInvalid(AIVendor.CLAUDE, "sk-old"))
        coVerify(exactly = 0) { repo.markSystemApiKeyInvalid(any(), any()) }
    }

    @Test
    fun `a deleted key is a no-op`() = runTest {
        coEvery { repo.getSystemApiKeyItem("CLAUDE") } returns null

        assertFalse(service.markSystemApiKeyInvalid(AIVendor.CLAUDE, "sk-old"))
        coVerify(exactly = 0) { repo.markSystemApiKeyInvalid(any(), any()) }
    }
}
