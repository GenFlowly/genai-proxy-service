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
    private val entitlements = mockk<CustomerEntitlementService>(relaxed = true)
    private val service = EmbeddingModelCatalogService(
        kms, credsRepo, catalogRepo, retrieval, CoroutineScope(Dispatchers.Unconfined), entitlements
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

        assertEquals(EmbeddingCatalog.Models(listOf("voyage-3", "voyage-4")), result)
        coVerify { catalogRepo.putProbed(cid, "VOYAGE", listOf("voyage-3", "voyage-4"), any(), false) }
    }

    @Test
    fun `probeAndStore persists the auth-failed verdict and reports KeyCannotEmbed`() = runTest {
        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(provider = "voyage", supported = emptyList(), inconclusive = emptyList(), error = "authentication failed")
        )
        val result = service.probeAndStore(cid, voyage, "badkey", existing = null)

        assertEquals(EmbeddingCatalog.KeyCannotEmbed, result)
        coVerify { catalogRepo.putProbed(cid, "VOYAGE", emptyList(), any(), true) }
    }

    @Test
    fun `a verdict that flips re-derives the customer's entitlements, an unchanged one doesn't`() = runTest {
        val rejected = ProbedModels(models = emptyList(), lastProbedAt = Instant.now(), keyFingerprint = "fp", authFailed = true)
        val accepted = rejected.copy(models = listOf("voyage-4"), authFailed = false)
        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(provider = "voyage", supported = listOf("voyage-4"), inconclusive = emptyList(), error = null)
        )

        service.probeAndStore(cid, voyage, "key", existing = accepted)
        coVerify(exactly = 0) { entitlements.refresh(any()) }

        service.probeAndStore(cid, voyage, "key", existing = rejected)
        coVerify(exactly = 1) { entitlements.refresh(cid) }

        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(provider = "voyage", supported = emptyList(), inconclusive = emptyList(), error = "authentication failed")
        )
        service.probeAndStore(cid, voyage, "key", existing = null)
        coVerify(exactly = 2) { entitlements.refresh(cid) }
    }

    @Test
    fun `probeAndStore returns null and does not persist on other vendor errors`() = runTest {
        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(provider = "voyage", supported = emptyList(), inconclusive = emptyList(), error = "no embedding models for provider voyage")
        )
        val result = service.probeAndStore(cid, voyage, "key", existing = null)

        assertNull(result)
        coVerify(exactly = 0) { catalogRepo.putProbed(any(), any(), any(), any(), any()) }
    }

    @Test
    fun `getCatalog serves fresh cache without probing`() = runTest {
        val key = "key"
        val fp = service.fingerprint(key)
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = listOf("voyage-4-large"),
            lastProbedAt = Instant.now(),   // fresh
            keyFingerprint = fp
        )

        val catalog = service.getCatalog(cid, voyage, key)

        assertEquals(EmbeddingCatalog.Models(listOf("voyage-4-large")), catalog)
        coVerify(exactly = 0) { retrieval.probeEmbeddingModels(any()) }
    }

    @Test
    fun `getCatalog keeps a recent auth-failed verdict without probing`() = runTest {
        val key = "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = emptyList(),
            lastProbedAt = Instant.now(),   // within the retry cooldown
            keyFingerprint = service.fingerprint(key),
            authFailed = true
        )

        val catalog = service.getCatalog(cid, voyage, key)

        assertEquals(EmbeddingCatalog.KeyCannotEmbed, catalog)
        coVerify(exactly = 0) { retrieval.probeEmbeddingModels(any()) }
    }

    @Test
    fun `getCatalog re-probes an auth-failed verdict after the retry window`() = runTest {
        val key = "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = emptyList(),
            lastProbedAt = Instant.now().minusSeconds(10 * 60),  // past the cooldown
            keyFingerprint = service.fingerprint(key),
            authFailed = true
        )
        // The customer fixed the key's permissions vendor-side: probe now passes.
        coEvery { retrieval.probeEmbeddingModels(any()) } returns listOf(
            VendorProbeResult(provider = "voyage", supported = listOf("voyage-4"), inconclusive = emptyList(), error = null)
        )

        val catalog = service.getCatalog(cid, voyage, key)

        assertEquals(EmbeddingCatalog.Models(listOf("voyage-4")), catalog)
        coVerify { catalogRepo.putProbed(cid, "VOYAGE", listOf("voyage-4"), any(), false) }
    }

    @Test
    fun `cachedKeyCannotEmbed reads the stored verdict only`() = runTest {
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = emptyList(), lastProbedAt = Instant.now(), keyFingerprint = "fp", authFailed = true
        )
        assertEquals(true, service.cachedKeyCannotEmbed(cid, voyage))

        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns null
        assertEquals(false, service.cachedKeyCannotEmbed(cid, voyage))
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
    fun `isModelUnusable is true only for a model the key's catalog doesn't offer, or an unknown name`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = listOf("voyage-4-large"),
            lastProbedAt = Instant.now(),
            keyFingerprint = service.fingerprint("key")
        )

        assertEquals(true, service.isModelUnusable(cid, "voyage-multimodal-3.5"))
        assertEquals(false, service.isModelUnusable(cid, "voyage-4-large"))
        assertEquals(true, service.isModelUnusable(cid, "gpt-4"))
    }

    @Test
    fun `isModelUnusable keeps the lock when the problem is the key, not the model`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("OPENAI", cid) } returns null
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = emptyList(),
            lastProbedAt = Instant.now(),
            keyFingerprint = service.fingerprint("key"),
            authFailed = true
        )

        assertEquals(false, service.isModelUnusable(cid, "text-embedding-3-large")) // no key yet
        assertEquals(false, service.isModelUnusable(cid, "voyage-4-large"))         // key can't embed
    }

    @Test
    fun `assertModelSupported throws when the key cannot embed at all`() = runTest {
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns ProbedModels(
            models = emptyList(),
            lastProbedAt = Instant.now(),
            keyFingerprint = service.fingerprint("key"),
            authFailed = true
        )

        val ex = assertFailsWith<IllegalArgumentException> {
            service.assertModelSupported(cid, "voyage-4-large")
        }
        assertEquals(true, ex.message!!.contains("cannot run embeddings"))
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
        // Probe infra down (empty result) AND no cache -> Undetermined -> don't block.
        coEvery { credsRepo.getCustomerApiKey("VOYAGE", cid) } returns "enc"
        coEvery { kms.decrypt("enc") } returns "key"
        coEvery { catalogRepo.getProbed(cid, "VOYAGE") } returns null
        coEvery { retrieval.probeEmbeddingModels(any()) } returns emptyList()

        service.assertModelSupported(cid, "voyage-multimodal-3.5") // no throw
    }

    @Test
    fun `weekly sweep scans only embedding vendors, never the HUGGINGFACE token rows`() = runTest {
        coEvery { catalogRepo.tryAcquireSweepLease(any()) } returns true
        coEvery { credsRepo.scanEmbeddingKeyItems(any()) } returns emptyList()

        service.refreshAll()

        coVerify { credsRepo.scanEmbeddingKeyItems(setOf("OPENAI", "VOYAGE")) }
    }
}
