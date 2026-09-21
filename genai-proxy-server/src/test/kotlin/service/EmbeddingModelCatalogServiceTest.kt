package com.genflowly.service

import com.genflowly.models.EmbeddingVendor
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.providers.VendorProbeResult
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.EmbeddingModelCatalogRepository
import com.genflowly.repository.ProbedModels
import io.mockk.Runs
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.just
import io.mockk.mockk
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class EmbeddingModelCatalogServiceTest {

    private val kms = mockk<KMSProvider>()
    private val credsRepo = mockk<CustomerCredentialsRepository>()
    private val catalogRepo = mockk<EmbeddingModelCatalogRepository>(relaxed = true)
    private val retrieval = mockk<RetrievalServerClient>()
    private val service = EmbeddingModelCatalogService(
        kms, credsRepo, catalogRepo, retrieval, CoroutineScope(Dispatchers.Unconfined)
    )

    private val cid = "CU1"
    private val voyage = EmbeddingVendor.VOYAGE

    @Test
    fun `vendorForModel maps by prefix`() {
        assertEquals(EmbeddingVendor.VOYAGE, service.vendorForModel("voyage-4-large"))
        assertEquals(EmbeddingVendor.OPENAI, service.vendorForModel("text-embedding-3-small"))
        assertNull(service.vendorForModel("gpt-4"))
    }

    @Test
    fun `probeAndStore keeps supported plus previously-valid inconclusive, drops the rest`() = runTest {
        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(
                provider = "voyage",
                supported = listOf("voyage-4"),
                inconclusive = listOf("voyage-3"),   // kept only because it was previously valid
                error = null
            )
        )
        val existing = ProbedModels(
            models = listOf("voyage-3", "voyage-stale"), // voyage-3 inconclusive->kept; voyage-stale dropped
            lastProbedAt = Instant.now(),
            keyFingerprint = "fp"
        )

        val result = service.probeAndStore(cid, voyage, "key", existing)

        assertEquals(listOf("voyage-3", "voyage-4"), result)
        coVerify { catalogRepo.putProbed(cid, "VOYAGE", listOf("voyage-3", "voyage-4"), any()) }
    }

    @Test
    fun `probeAndStore returns null and does not persist on vendor error`() = runTest {
        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(provider = "voyage", supported = emptyList(), inconclusive = emptyList(), error = "authentication failed")
        )
        val result = service.probeAndStore(cid, voyage, "badkey", existing = null)

        assertNull(result)
        coVerify(exactly = 0) { catalogRepo.putProbed(any(), any(), any(), any()) }
    }

    @Test
    fun `getValidModels serves fresh cache without probing`() = runTest {
        val key = "key"
        val fp = service.fingerprint(key)
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = listOf("voyage-4-large"),
            lastProbedAt = Instant.now(),   // fresh
            keyFingerprint = fp
        )

        val models = service.getValidModels(cid, voyage, key)

        assertEquals(listOf("voyage-4-large"), models)
        coVerify(exactly = 0) { retrieval.probeEmbeddingModels(any()) }
    }

    @Test
    fun `assertModelSupported throws for a model the key cannot embed`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        val fp = service.fingerprint("key")
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = listOf("voyage-4-large"),
            lastProbedAt = Instant.now(),
            keyFingerprint = fp
        )

        val ex = assertFailsWith<IllegalArgumentException> {
            service.assertModelSupported(cid, "voyage-multimodal-3.5")
        }
        assertEquals(true, ex.message!!.contains("voyage-multimodal-3.5"))
    }

    @Test
    fun `assertModelSupported passes for a supported model and for blank`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        val fp = service.fingerprint("key")
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = listOf("voyage-4-large"),
            lastProbedAt = Instant.now(),
            keyFingerprint = fp
        )

        service.assertModelSupported(cid, "voyage-4-large") // no throw
        service.assertModelSupported(cid, "")               // blank always allowed
        service.assertModelSupported(cid, null)
    }

    @Test
    fun `assertModelSupported throws when no key is configured`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns null

        assertFailsWith<IllegalArgumentException> {
            service.assertModelSupported(cid, "voyage-4-large")
        }
    }

    @Test
    fun `assertModelSupported allows the save when the valid set cannot be determined`() = runTest {
        // Probe infra down (empty result) AND no cache -> getValidModels null -> don't block.
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns null
        coEvery { retrieval.probeEmbeddingModels(any()) } returns emptyList()

        service.assertModelSupported(cid, "voyage-multimodal-3.5") // no throw
    }
}
