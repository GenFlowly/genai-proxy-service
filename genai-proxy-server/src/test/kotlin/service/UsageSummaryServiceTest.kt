package com.genflowly.service

import com.genflowly.models.UsageCategory
import com.genflowly.models.UsageRollupRow
import com.genflowly.models.api.UsageDayResponse
import com.genflowly.repository.UsageRateCardRepository
import com.genflowly.repository.UsageRollupRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The Cost and Usage pages chart spend per day from the same rollup rows the
 * totals come from: one entry per UTC date with usage, oldest first, summed
 * across vendors and models, never mixing categories.
 */
class UsageSummaryServiceTest {

    private val rollups = mockk<UsageRollupRepository>()
    private val rateCard = mockk<UsageRateCardRepository>()
    private val service = UsageSummaryService(rollups, rateCard)

    private fun row(
        date: String,
        category: UsageCategory,
        vendor: String,
        dim3: String,
        costUsd: Double,
        requests: Double
    ) = UsageRollupRow(
        category = category,
        date = date,
        vendor = vendor,
        dim3 = dim3,
        metrics = mapOf("costUsd" to costUsd, "requestCount" to requests, "totalTokens" to 100.0)
    )

    @Test
    fun `llm byDay sums every vendor and model per date, oldest first`() = runTest {
        coEvery { rollups.queryRange("CU-1", "2026-11-01", "2026-11-03") } returns listOf(
            row("2026-11-03", UsageCategory.LLM, "OPENAI", "gpt-5.4", 0.30, 3.0),
            row("2026-11-01", UsageCategory.LLM, "OPENAI", "gpt-5.4", 0.10, 1.0),
            row("2026-11-01", UsageCategory.LLM, "ANTHROPIC", "claude-opus-5-5", 0.25, 2.0),
            row("2026-11-01", UsageCategory.LLM, "OPENAI", "gpt-5.4-nano", 0.05, 4.0),
        )

        val usage = service.getLlmUsage("CU-1", "2026-11-01", "2026-11-03")

        assertEquals(
            listOf(
                UsageDayResponse(date = "2026-11-01", costUsd = 0.40, requestCount = 7),
                UsageDayResponse(date = "2026-11-03", costUsd = 0.30, requestCount = 3),
            ),
            usage.byDay.map { it.copy(costUsd = Math.round(it.costUsd * 100) / 100.0) }
        )
        assertEquals(0.70, Math.round(usage.totalCostUsd * 100) / 100.0)
    }

    @Test
    fun `byDay only counts the page's own category`() = runTest {
        coEvery { rollups.queryRange("CU-1", any(), any()) } returns listOf(
            row("2026-11-02", UsageCategory.LLM, "OPENAI", "gpt-5.4", 0.50, 5.0),
            row("2026-11-02", UsageCategory.EMBEDDING, "VOYAGE", "voyage-4-large", 0.02, 9.0),
            row("2026-11-04", UsageCategory.EMBEDDING, "VOYAGE", "voyage-4-large", 0.01, 3.0),
        )

        val embedding = service.getEmbeddingUsage("CU-1", "2026-11-01", "2026-11-30")

        assertEquals(listOf("2026-11-02", "2026-11-04"), embedding.byDay.map { it.date })
        assertEquals(listOf(9L, 3L), embedding.byDay.map { it.requestCount })
        assertEquals(listOf(0.02, 0.01), embedding.byDay.map { it.costUsd })
    }

    @Test
    fun `an empty window has no days and reads the table once`() = runTest {
        coEvery { rollups.queryRange("CU-1", any(), any()) } returns emptyList()

        val usage = service.getLlmUsage("CU-1", "2026-10-01", "2026-10-31")

        assertEquals(emptyList(), usage.byDay)
        assertEquals(0.0, usage.totalCostUsd)
        coVerify(exactly = 1) { rollups.queryRange("CU-1", "2026-10-01", "2026-10-31") }
    }
}
