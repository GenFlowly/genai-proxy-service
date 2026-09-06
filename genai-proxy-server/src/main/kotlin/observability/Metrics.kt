package com.genflowly.observability

import com.genflowly.models.AIVendor
import io.micrometer.core.instrument.MeterRegistry
import io.micrometer.core.instrument.Tag
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Kotlin side of the shared observability conventions (see the
 * "Observability" section of development.md — the Python twin lives in
 * encoding_library.observability). Counters end in `_total`, duration
 * summaries in `_duration_seconds` (seconds), and only the allowed dimension
 * keys are emitted — never customer_id or any per-request value.
 *
 * Metric emission must never break the caller: every failure is swallowed
 * and logged at debug.
 */
object Metrics {

    private val allowedDimensions = setOf(
        "operation", "status", "vendor", "model", "data_type",
        "tool", "direction", "source",
    )

    @Volatile
    private var registry: MeterRegistry? = null

    @Volatile
    private var service: String = "genai-proxy-server"

    fun init(registry: MeterRegistry, service: String) {
        this.registry = registry
        this.service = service
    }

    /** Increment a monotonic counter. Name convention: `*_total`. */
    fun count(name: String, value: Double = 1.0, vararg dims: Pair<String, String>) {
        runCatching {
            registry?.counter(name, tags(dims))?.increment(value)
        }.onFailure { logger.debug(it) { "Metric emission failed for $name" } }
    }

    /** Record a distribution sample. Name convention: `*_duration_seconds`. */
    fun observe(name: String, value: Double, vararg dims: Pair<String, String>) {
        runCatching {
            registry?.summary(name, tags(dims))?.record(value)
        }.onFailure { logger.debug(it) { "Metric emission failed for $name" } }
    }

    /**
     * Kotlin twin of the Python `@track` decorator: emits
     * `{operation}_total{status=ok|error}` + `{operation}_duration_seconds`
     * around [block], re-throwing unchanged.
     */
    suspend fun <T> tracked(
        operation: String,
        vararg dims: Pair<String, String>,
        block: suspend () -> T,
    ): T {
        val start = System.nanoTime()
        var status = "ok"
        try {
            return block()
        } catch (t: Throwable) {
            status = "error"
            throw t
        } finally {
            val elapsed = (System.nanoTime() - start) / 1e9
            count("${operation}_total", 1.0, "status" to status, *dims)
            observe("${operation}_duration_seconds", elapsed, "status" to status, *dims)
        }
    }

    private fun tags(dims: Array<out Pair<String, String>>): List<Tag> {
        val tags = mutableListOf(Tag.of("service", service))
        for ((key, value) in dims) {
            if (key in allowedDimensions) {
                tags.add(Tag.of(key, value))
            } else {
                logger.debug { "Dropping disallowed metric dimension '$key'" }
            }
        }
        return tags
    }
}

/**
 * Vendor label aligned with the retrieval-server's `llm_provider` values so
 * one Grafana query spans both services (CLAUDE is "anthropic" there).
 */
fun AIVendor.metricVendor(): String = when (this) {
    AIVendor.CLAUDE -> "anthropic"
    else -> name.lowercase()
}
