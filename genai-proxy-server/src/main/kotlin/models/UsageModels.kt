package com.genflowly.models

/**
 * The usage categories tracked in CustomerAIUsage. [storageKey] is the
 * literal string stamped into the composite usageDate sort key and the
 * category attribute — stable across renames of the enum constant itself.
 * DEVELOPER rows re-count the LLM turns a developer API key paid for (vendor
 * "apikey", dim3 = keyId) so the Developer page can show cost per key; the
 * four Cost and Usage pages never read them, so nothing is counted twice.
 */
enum class UsageCategory(val storageKey: String) {
    LLM("llm"),
    EMBEDDING("embedding"),
    VECTOR_DB("vector_db"),
    WEB_SEARCH("web_search"),
    DEVELOPER("developer");

    companion object {
        fun fromStorageKey(value: String): UsageCategory? = entries.find { it.storageKey == value }
    }
}

/**
 * One row read back from CustomerAIUsage: a (date, category, vendor, dim3)
 * bucket with whatever numeric attributes that category writes. dim3 is
 * model for llm/embedding, opType for vector_db, searchDepth for web_search.
 * [metrics] holds exactly the numeric attributes present on the row — callers
 * know which keys to expect for a given [category].
 */
/** All-time totals for one developer API key, from its undated rollup row. */
data class DeveloperKeyUsage(
    val requestCount: Long,
    val costUsd: Double
)

data class UsageRollupRow(
    val category: UsageCategory,
    val date: String,
    val vendor: String,
    val dim3: String,
    val metrics: Map<String, Double>
)
