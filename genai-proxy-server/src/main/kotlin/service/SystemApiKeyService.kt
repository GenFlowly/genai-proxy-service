package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.repository.SystemApiKeyRepository
import com.genflowly.providers.KMSProvider
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * One usable system AI provider: a vendor with a valid stored key, an
 * admin-selected model and a failover priority (1 = primary).
 * Carries decrypted key material — server-side only, never serialized.
 */
data class SystemAIProviderConfig(
    val aiVendor: AIVendor,
    val model: String,
    val apiKey: String,
    val priority: Int
)

/**
 * System-wide (not per-customer) AI vendor API keys, managed through the
 * admin panel. Keys live in the SystemVendorApiKeys table keyed solely by
 * aiVendor, so [getSystemApiKeyForVendor] is a single O(1) GetItem — other
 * services can call it on the hot path.
 */
class SystemApiKeyService(
    private val kmsProvider: KMSProvider,
    private val systemApiKeyRepository: SystemApiKeyRepository,
    private val retrievalServerClient: com.genflowly.providers.RetrievalServerClient
) {

    suspend fun storeSystemApiKey(
        aiVendor: String,
        apiKey: String,
        updatedBy: String
    ) {
        val encrypted = kmsProvider.encrypt(apiKey)
        systemApiKeyRepository.saveSystemApiKey(aiVendor, encrypted, updatedBy)
    }

    /**
     * Validates the key against the vendor before storing; invalid keys are
     * rejected and never stored. Returns the resulting status either way.
     */
    suspend fun validateAndStoreSystemKey(
        vendor: AIVendor,
        apiKey: String,
        updatedBy: String
    ): models.AIVendorAPIKeyStatus {
        val isKeyValid = retrievalServerClient.validateApiKey(vendor, apiKey)

        return if (isKeyValid) {
            storeSystemApiKey(aiVendor = vendor.name, apiKey = apiKey, updatedBy = updatedBy)
            models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = true,
                status = models.APIKeyStatus.VALID,
                updateSuccessful = true
            )
        } else {
            logger.warn { "Invalid system API key provided for vendor $vendor. Not saving." }
            models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = false,
                status = models.APIKeyStatus.INVALID,
                updateSuccessful = false
            )
        }
    }

    /**
     * O(1) retrieval of the decrypted system key for a vendor.
     * Returns null when no key is set.
     */
    suspend fun getSystemApiKeyForVendor(vendor: AIVendor): String? {
        val item = systemApiKeyRepository.getSystemApiKeyItem(vendor.name) ?: return null
        val encrypted = item["apiKey"]?.s()
        if (encrypted.isNullOrBlank()) {
            logger.warn { "System API key not set for vendor: ${vendor.name}" }
            return null
        }
        return kmsProvider.decrypt(encrypted)
    }

    /**
     * Status per vendor (never the key material itself) plus the admin-selected
     * model and failover priority. One GetItem per known vendor.
     */
    suspend fun getSystemApiKeyStatusList(): List<models.SystemVendorApiKeyInfo> {
        return AIVendor.entries.map { vendor ->
            val item = systemApiKeyRepository.getSystemApiKeyItem(vendor.name)
            val hasKey = !item?.get("apiKey")?.s().isNullOrBlank()
            val isStoredValid = item?.get("isAPIKeyValid")?.bool() ?: false
            val status = when {
                !hasKey -> models.APIKeyStatus.NOT_SET
                isStoredValid -> models.APIKeyStatus.VALID
                else -> models.APIKeyStatus.INVALID
            }
            models.SystemVendorApiKeyInfo(
                aiVendor = vendor,
                isAPIKeyValid = hasKey && isStoredValid,
                status = status,
                selectedModel = item?.get("selectedModel")?.s(),
                priority = item?.get("priority")?.n()?.toIntOrNull()
            )
        }
    }

    /**
     * The fully configured system provider (valid key + selected model) for
     * ONE specific vendor, ignoring priorities. Returns null — with a warn
     * log — when the vendor has no key stored or no model selected, so
     * callers can degrade gracefully instead of failing over.
     */
    suspend fun getProviderConfigForVendor(vendor: AIVendor): SystemAIProviderConfig? {
        val item = systemApiKeyRepository.getSystemApiKeyItem(vendor.name)
        val encrypted = item?.get("apiKey")?.s()?.takeIf { it.isNotBlank() }
        val isValid = item?.get("isAPIKeyValid")?.bool() ?: false
        val model = item?.get("selectedModel")?.s()?.takeIf { it.isNotBlank() }
        if (encrypted == null || !isValid || model == null) {
            logger.warn {
                "System provider ${vendor.name} is not fully configured " +
                        "(key present=${encrypted != null}, valid=$isValid, model=${model ?: "unset"})"
            }
            return null
        }
        return SystemAIProviderConfig(
            aiVendor = vendor,
            model = model,
            apiKey = kmsProvider.decrypt(encrypted),
            priority = item["priority"]?.n()?.toIntOrNull() ?: Int.MAX_VALUE
        )
    }

    /**
     * All fully configured system providers (valid key + selected model +
     * priority), sorted by priority ascending — the order the system should
     * try them in. Vendors missing any piece of configuration are skipped.
     */
    suspend fun getPrioritizedProviderConfigs(): List<SystemAIProviderConfig> {
        return AIVendor.entries.mapNotNull { vendor ->
            val item = systemApiKeyRepository.getSystemApiKeyItem(vendor.name) ?: return@mapNotNull null
            val encrypted = item["apiKey"]?.s()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val isValid = item["isAPIKeyValid"]?.bool() ?: false
            val model = item["selectedModel"]?.s()?.takeIf { it.isNotBlank() }
            val priority = item["priority"]?.n()?.toIntOrNull()
            if (!isValid || model == null || priority == null) {
                logger.debug { "Skipping system provider ${vendor.name}: incomplete configuration" }
                return@mapNotNull null
            }
            SystemAIProviderConfig(
                aiVendor = vendor,
                model = model,
                apiKey = kmsProvider.decrypt(encrypted),
                priority = priority
            )
        }.sortedBy { it.priority }
    }

    /**
     * Store which model to use for a vendor and its failover priority
     * (1 = primary). Fails if the vendor has no stored key.
     */
    suspend fun updateSystemVendorConfig(aiVendor: String, model: String, priority: Int) {
        systemApiKeyRepository.updateSystemApiKeyConfig(aiVendor, model, priority)
    }

    suspend fun deleteSystemApiKey(aiVendor: String) {
        systemApiKeyRepository.deleteSystemApiKey(aiVendor)
    }
}
