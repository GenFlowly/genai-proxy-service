package com.genflowly.service

import com.genflowly.models.SystemAIProviderConfig
import kotlinx.coroutines.CancellationException
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Thrown when every configured system provider failed for an operation.
 * [failures] holds one "VENDOR/model: reason" entry per attempted provider.
 */
class SystemAIFailoverException(
    message: String,
    val failures: List<String>
) : RuntimeException(message)

/**
 * Runs AI operations on the system-wide vendor API keys with failover.
 *
 * Providers are the admin-configured (vendor, model, key) triples from the
 * SystemVendorApiKeys table, tried in priority order (1 = primary). Failure
 * is defined as response generation failure: any exception thrown by the
 * operation block moves on to the next provider. The first successful result
 * wins; if every provider fails a [SystemAIFailoverException] is thrown with
 * the per-provider reasons.
 *
 * Usage (e.g. instruction persona generation, hooked up separately):
 *
 *   val result = systemAIFailoverService.executeWithFailover("persona-generation") { config ->
 *       // call the vendor with config.aiVendor / config.model / config.apiKey;
 *       // throw on any generation failure to trigger the next provider
 *   }
 */
class SystemAIFailoverService(
    private val systemApiKeyService: SystemApiKeyService
) {

    suspend fun <T> executeWithFailover(
        operationName: String = "ai-generation",
        block: suspend (SystemAIProviderConfig) -> T
    ): T {
        val configs = systemApiKeyService.getPrioritizedProviderConfigs()
        if (configs.isEmpty()) {
            throw SystemAIFailoverException(
                "No system AI provider is configured (a vendor needs a valid key, " +
                        "a selected model and a priority set in the admin panel)",
                failures = emptyList()
            )
        }

        val failures = mutableListOf<String>()
        for (config in configs) {
            try {
                logger.info {
                    "[$operationName] Trying system provider ${config.aiVendor}/${config.model} " +
                            "(priority ${config.priority})"
                }
                return block(config)
            } catch (e: CancellationException) {
                // Never swallow coroutine cancellation
                throw e
            } catch (e: Exception) {
                logger.warn(e) {
                    "[$operationName] System provider ${config.aiVendor}/${config.model} " +
                            "(priority ${config.priority}) failed — trying next"
                }
                failures.add("${config.aiVendor}/${config.model}: ${e.message}")
            }
        }

        throw SystemAIFailoverException(
            "All ${configs.size} system AI provider(s) failed for $operationName: " +
                    failures.joinToString("; "),
            failures = failures
        )
    }

    /**
     * Run an AI operation against ONE specific system vendor — no failover.
     * Returns null (after logging) when the vendor isn't fully configured or
     * the operation fails, so callers can degrade gracefully. Use
     * [executeWithFailover] when any configured provider will do.
     */
    suspend fun <T> executeWithVendorOrNull(
        vendor: com.genflowly.models.AIVendor,
        operationName: String = "ai-generation",
        block: suspend (SystemAIProviderConfig) -> T
    ): T? {
        val config = systemApiKeyService.getProviderConfigForVendor(vendor) ?: return null
        return try {
            logger.info { "[$operationName] Using system provider ${config.aiVendor}/${config.model}" }
            block(config)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logger.error(e) {
                "[$operationName] System provider ${config.aiVendor}/${config.model} failed"
            }
            null
        }
    }
}
