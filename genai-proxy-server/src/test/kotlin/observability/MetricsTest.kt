package observability

import com.genflowly.models.AIVendor
import com.genflowly.observability.Metrics
import com.genflowly.observability.metricVendor
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

class MetricsTest {

    private fun freshRegistry(): PrometheusMeterRegistry {
        val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
        Metrics.init(registry, service = "test-svc")
        return registry
    }

    @Test
    fun `counter keeps single _total suffix and allowed dims`() {
        val registry = freshRegistry()
        Metrics.count(
            "llm_cost_usd_total", 0.5,
            "vendor" to "anthropic", "model" to "claude-sonnet-4-6",
        )
        val scraped = registry.scrape()
        assertContains(scraped, "llm_cost_usd_total{")
        assertFalse(scraped.contains("llm_cost_usd_total_total"))
        assertContains(scraped, "vendor=\"anthropic\"")
        assertContains(scraped, "service=\"test-svc\"")
    }

    @Test
    fun `disallowed dimensions are dropped`() {
        val registry = freshRegistry()
        Metrics.count("some_op_total", 1.0, "customer_id" to "cust-1", "status" to "ok")
        val scraped = registry.scrape()
        assertFalse(scraped.contains("customer_id"))
        assertContains(scraped, "status=\"ok\"")
    }

    @Test
    fun `tracked emits status ok and error and rethrows`() = runTest {
        val registry = freshRegistry()
        val result = Metrics.tracked("unit_op") { 42 }
        assertEquals(42, result)
        assertFailsWith<IllegalStateException> {
            Metrics.tracked("unit_op") { error("boom") }
        }
        val scraped = registry.scrape()
        assertContains(scraped, "unit_op_total{service=\"test-svc\",status=\"error\"")
        assertContains(scraped, "unit_op_total{service=\"test-svc\",status=\"ok\"")
        assertContains(scraped, "unit_op_duration_seconds_count")
    }

    @Test
    fun `metric emission never throws without init`() {
        // A second registry init replaces the first; emitting on a name that
        // already exists with different tags must not propagate errors.
        val registry = freshRegistry()
        Metrics.count("clash_total", 1.0, "status" to "ok")
        Metrics.count("clash_total", 1.0, "vendor" to "openai")
        assertContains(registry.scrape(), "clash_total")
    }

    @Test
    fun `vendor label aligns with retrieval-server naming`() {
        assertEquals("anthropic", AIVendor.CLAUDE.metricVendor())
        assertEquals("openai", AIVendor.OPENAI.metricVendor())
        assertEquals("gemini", AIVendor.GEMINI.metricVendor())
    }
}
