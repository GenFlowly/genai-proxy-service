package com.genflowly.utils

/**
 * Masks identifiers in log lines that survive in production (WARN/ERROR).
 * Auth0 subs are pseudonymous user ids: production shows only the IdP prefix
 * plus two characters; development shows the full value. Reads APP_ENV
 * directly (default "development", same convention as AppConfig) so leaf code
 * — repositories, activities — can use it without threading config through
 * constructors. See development.md, "Logging policy".
 */
object LogSanitize {
    private val isProduction: Boolean =
        (System.getenv("APP_ENV")?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            ?: "development") == "production"

    fun sub(sub: String?): String {
        if (sub == null) return "null"
        if (!isProduction) return sub
        val sep = sub.indexOf('|')
        return (if (sep >= 0) sub.take(sep + 3) else sub.take(3)) + "…"
    }
}
