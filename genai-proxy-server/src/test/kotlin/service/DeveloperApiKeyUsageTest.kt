package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.ApiKeyPrincipal
import com.genflowly.models.DeveloperKeyUsage
import com.genflowly.models.UsageCategory
import com.genflowly.models.UsageRollupRow
import com.genflowly.models.api.DeveloperApiKeyUsageTotals
import com.genflowly.repository.DeveloperApiKeyRepository
import com.genflowly.repository.UsageRollupRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The Developer page lists each key with what its requests cost over the
 * last 30 days and all time; when usage can't be read it says so (null)
 * instead of showing zero.
 */
class DeveloperApiKeyUsageTest {

    private val keys = mockk<DeveloperApiKeyRepository>(relaxed = true)
    private val rollups = mockk<UsageRollupRepository>()
    private val clock = Clock.fixed(Instant.parse("2026-11-17T20:00:00Z"), ZoneOffset.UTC)
    private val service = DeveloperApiKeyService(keys, mockk(relaxed = true), AppScope(), rollups, clock)

    private fun s(value: String) = AttributeValue.builder().s(value).build()

    private fun keyItem(keyId: String, name: String) = mapOf(
        "keyId" to s(keyId),
        "name" to s(name),
        "prefix" to s("gfy_$keyId"),
        "customerId" to s("CU-1")
    )

    private fun developerRow(date: String, keyId: String, cost: Double, requests: Double) = UsageRollupRow(
        category = UsageCategory.DEVELOPER,
        date = date,
        vendor = "apikey",
        dim3 = keyId,
        metrics = mapOf("costUsd" to cost, "requestCount" to requests)
    )

    @Test
    fun `each key gets its last 30 days and all-time usage`() = runTest {
        coEvery { keys.queryDeveloperApiKeysByCustomer("CU-1") } returns
            listOf(keyItem("K1", "Notebook sync"), keyItem("K2", "Shortcuts"))
        coEvery { rollups.queryRange("CU-1", "2026-10-19", "2026-11-17") } returns listOf(
            developerRow("2026-11-01", "K1", 0.25, 10.0),
            developerRow("2026-11-17", "K1", 0.33, 5.0),
            UsageRollupRow(UsageCategory.LLM, "2026-11-17", "OPENAI", "gpt-5.4", mapOf("costUsd" to 9.0, "requestCount" to 99.0)),
        )
        coEvery { rollups.queryDeveloperKeyTotals("CU-1") } returns mapOf("K1" to DeveloperKeyUsage(1204, 1.37))

        val listed = service.listKeys("CU-1")

        val k1 = listed.single { it.keyId == "K1" }
        assertEquals(15L, k1.requests30d)
        assertEquals(0.58, Math.round(k1.costUsd30d!! * 100) / 100.0)
        assertEquals(1204L, k1.requestsAllTime)
        assertEquals(1.37, k1.costUsdAllTime)
        val k2 = listed.single { it.keyId == "K2" }
        assertEquals(0L, k2.requests30d)
        assertEquals(0.0, k2.costUsdAllTime)

        val totals = DeveloperApiKeyUsageTotals.of(listed)
        assertEquals(15L, totals.requests30d)
        assertEquals(1204L, totals.requestsAllTime)
        coVerify(exactly = 1) { rollups.queryRange(any(), any(), any()) }
    }

    @Test
    fun `usage that can't be read stays null, the keys still list`() = runTest {
        coEvery { keys.queryDeveloperApiKeysByCustomer("CU-1") } returns listOf(keyItem("K1", "Notebook sync"))
        coEvery { rollups.queryRange(any(), any(), any()) } throws RuntimeException("throttled")

        val listed = service.listKeys("CU-1")

        assertEquals("Notebook sync", listed.single().name)
        assertNull(listed.single().requests30d)
        assertNull(listed.single().costUsdAllTime)
        assertNull(DeveloperApiKeyUsageTotals.of(listed).costUsd30d)
    }

    @Test
    fun `no keys means no usage reads`() = runTest {
        coEvery { keys.queryDeveloperApiKeysByCustomer("CU-1") } returns emptyList()

        assertEquals(emptyList(), service.listKeys("CU-1"))
        coVerify(exactly = 0) { rollups.queryRange(any(), any(), any()) }
    }

    @Test
    fun `a valid key authenticates as its customer and names itself`() = runTest {
        coEvery { keys.getDeveloperApiKeyByHash(any()) } returns keyItem("K1", "Notebook sync")

        val principal = service.authenticate("gfy_" + "a".repeat(40))

        assertEquals(ApiKeyPrincipal(customerId = "CU-1", keyId = "K1"), principal)
    }
}
