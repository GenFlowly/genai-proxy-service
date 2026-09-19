package com.genflowly.service

import com.genflowly.models.AIVendor
import com.genflowly.models.toProviderString
import com.genflowly.di.AppScope
import com.genflowly.models.api.GetToolCredentialStatusListResponse
import com.genflowly.models.api.StoreToolCredentialsResponse
import com.genflowly.models.api.ToolCredentialStatus
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.KMSProvider
import com.genflowly.providers.RetrievalServerClient
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Customer-owned secret configuration: AI vendor API keys, external tool
 * credentials and vector-DB configs. All values are KMS-encrypted
 * before they reach the repository, and decrypted here — never anywhere else.
 */
// Provider rejection messages can embed whole JSON error bodies — cap what
// is echoed back to the client.
private const val VALIDATION_DETAIL_MAX_CHARS = 300

class CustomerCredentialsService(
    private val kmsProvider: KMSProvider,
    private val customerCredentialsRepository: CustomerCredentialsRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val encodingServerClient: EncodingServerClient,
    private val retrievalServerClient: RetrievalServerClient,
    private val vendorAllowlistService: VendorAllowlistService,
    private val appScope: AppScope
) {

    // ─── AI vendor API keys ───────────────────────────────────────────────────

    suspend fun storeApiKey(
        customerId: String, aiVendor: String, apiKey: String
    ): Boolean {
        val encrypted = kmsProvider.encrypt(apiKey)
        customerCredentialsRepository.saveCustomerApiKey(customerId, aiVendor, encrypted)
        return true
    }

    /**
     * Validates the key against the vendor (one cheap authenticated call via
     * the retrieval-server) and stores it encrypted only when valid. Returns
     * the resulting status either way — invalid keys are never stored.
     */
    suspend fun validateAndStoreVendorKey(
        customerId: String,
        vendor: AIVendor,
        apiKey: String
    ): com.genflowly.models.AIVendorAPIKeyStatus {
        val result = retrievalServerClient.validateProviderKeyDetailed(vendor.toProviderString(), apiKey)

        return if (result.valid) {
            val stored = storeApiKey(customerId = customerId, aiVendor = vendor.name, apiKey = apiKey)
            logger.info { "API Key validated and stored for vendor $vendor: $stored" }
            com.genflowly.models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = true,
                status = com.genflowly.models.APIKeyStatus.VALID,
                updateSuccessful = true
            )
        } else {
            logger.warn { "Invalid API Key provided for vendor $vendor. Not saving." }
            com.genflowly.models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = false,
                status = com.genflowly.models.APIKeyStatus.INVALID,
                updateSuccessful = false,
                detail = result.error?.take(VALIDATION_DETAIL_MAX_CHARS)
            )
        }
    }

    suspend fun getCustomerApiKeyForVendor(
        vendor: AIVendor,
        customerId: String
    ): String? {
        val apiKey = customerCredentialsRepository.getCustomerApiKey(vendor.name, customerId)
        val decrypted = apiKey?.let { kmsProvider.decrypt(it) }

        if (decrypted.isNullOrBlank()) {
            logger.warn { "API key not found for vendor: ${vendor.name}" }
            return null
        }
        return decrypted
    }

    /**
     * Store the customer's selected model + failover priority (1 = primary)
     * for a vendor. Throws ConditionalCheckFailedException when the vendor
     * has no stored key.
     *
     * The model is also mirrored into AIConfigPreferences.preferredModels —
     * the single source of truth for a vendor's default model, shared with
     * the sidebar AI-config widget — so both surfaces read and write the
     * same default.
     */
    suspend fun updateVendorConfig(
        customerId: String,
        vendor: AIVendor,
        model: String,
        priority: Int
    ) {
        customerCredentialsRepository.updateCustomerVendorConfig(
            customerId = customerId,
            aiVendor = vendor.name,
            selectedModel = model,
            priority = priority
        )
        val current = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }
            .getOrNull()?.preferredModels.orEmpty()
        val existing = current.firstOrNull { it.aiVendor == vendor }
        val updated = current.filterNot { it.aiVendor == vendor } +
            com.genflowly.models.AIConfig(aiVendor = vendor, model = model, maxTokens = existing?.maxTokens)
        customerProfileRepository.savePreferences(
            customerId = customerId,
            preferredModels = updated,
            preferredGenerativeMode = null,
            otherPreferences = null
        )
    }

    /**
     * All fully configured customer providers (valid key + selected model +
     * priority), decrypted and sorted by priority ascending — the order
     * internal generations should try them in. Vendors missing any piece of
     * configuration are skipped; customers who never configured a model or
     * priority get an empty list.
     */
    suspend fun getPrioritizedProviderConfigs(customerId: String): List<com.genflowly.models.CustomerAIProviderConfig> {
        // preferredModels (shared with the AI-config widget) is the source of
        // truth for each vendor's model; the vendor item's selectedModel is a
        // legacy fallback for customers who never saved widget preferences.
        val preferredByVendor = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }
            .getOrNull()?.preferredModels.orEmpty()
            .associateBy({ it.aiVendor }, { it.model })
        return customerCredentialsRepository.getCustomerVendorItems(customerId).mapNotNull { item ->
            val vendor = item[com.genflowly.DynamoDBConstants.AI_VENDOR_KEY]?.s()
                ?.let { AIVendor.fromStoredNameOrNull(it) }
                ?: return@mapNotNull null
            val encrypted = item["apiKey"]?.s()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            // Legacy items may lack the validity flag: a stored key counts as valid.
            val isValid = item["isAPIKeyValid"]?.bool() ?: true
            val model = (preferredByVendor[vendor] ?: item["selectedModel"]?.s())?.takeIf { it.isNotBlank() }
            val priority = item["priority"]?.n()?.toIntOrNull()
            if (!isValid || model == null || priority == null) return@mapNotNull null
            com.genflowly.models.CustomerAIProviderConfig(
                aiVendor = vendor,
                model = model,
                apiKey = kmsProvider.decrypt(encrypted),
                priority = priority
            )
        }.sortedBy { it.priority }
    }

    /**
     * Decrypted keys for every vendor the customer has a usable (present +
     * valid) key for, in [AIVendor] enum order. Used to build fallback
     * candidates when no prioritized configs are set.
     */
    suspend fun getUsableVendorKeys(customerId: String): Map<AIVendor, String> {
        val byVendor = customerCredentialsRepository.getCustomerVendorItems(customerId)
            .mapNotNull { item ->
                val vendor = item[com.genflowly.DynamoDBConstants.AI_VENDOR_KEY]?.s()
                    ?.let { AIVendor.fromStoredNameOrNull(it) }
                    ?: return@mapNotNull null
                val encrypted = item["apiKey"]?.s()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                // Legacy items may lack the validity flag: a stored key counts as valid.
                if (item["isAPIKeyValid"]?.bool() == false) return@mapNotNull null
                vendor to encrypted
            }.toMap()
        // Legacy vendors first (stable, preferred fallback order), then any
        // long-tail vendors the customer brought a key for.
        val ordered = AIVendor.entries.filter { it in byVendor } +
            byVendor.keys.filter { it !in AIVendor.entries }.sortedBy { it.name }
        return ordered.associateWith { kmsProvider.decrypt(byVendor.getValue(it)) }
    }

    suspend fun getAIVendorAPIKeyStatusList(customerId: String): List<com.genflowly.models.AIVendorAPIKeyStatus> {
        val storedKeys = customerCredentialsRepository.getCustomerApiKeys(customerId)
        val storedMap = storedKeys.associateBy { it.aiVendor }

        // Legacy vendors always appear (NOT_SET when keyless); long-tail
        // vendors appear once the customer has stored a key for them.
        val legacy = AIVendor.entries.map { vendor ->
            storedMap[vendor] ?: com.genflowly.models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = false,
                status = com.genflowly.models.APIKeyStatus.NOT_SET
            )
        }
        val longTail = storedKeys
            .filter { it.aiVendor !in AIVendor.entries }
            .sortedBy { it.aiVendor.name }
        // Vendors the admin removed from the allowlist disappear from the
        // app entirely — cards, sidebar widget, everything status-driven.
        // Stored keys are kept; the vendor reappears if re-allowed.
        return (legacy + longTail).filter { vendorAllowlistService.isAllowed(it.aiVendor) }
    }

    /** Seeds an INVALID key-status row per vendor for a fresh customer. */
    suspend fun initCustomerApiKeys(customerId: String) {
        AIVendor.entries.forEach { vendor ->
            customerCredentialsRepository.initCustomerApiKey(customerId, vendor.name)
        }
    }

    // ─── Embedding API keys ───────────────────────────────────────────────────
    // Same CustomerVendorApiKeys table, keyed by EmbeddingVendor name. OPENAI
    // shares the text-generation vendor's row (one key for both uses); VOYAGE
    // gets its own row that the AIVendor-based readers above silently skip.

    /**
     * Validates an embedding key against the provider and stores it encrypted
     * only when valid — the embedding twin of [validateAndStoreVendorKey].
     */
    suspend fun validateAndStoreEmbeddingKey(
        customerId: String,
        vendor: com.genflowly.models.EmbeddingVendor,
        apiKey: String
    ): com.genflowly.models.EmbeddingKeyStatus {
        val result = retrievalServerClient.validateProviderKeyDetailed(vendor.toProviderString(), apiKey)

        return if (result.valid) {
            storeApiKey(customerId = customerId, aiVendor = vendor.name, apiKey = apiKey)
            logger.info { "Embedding API key validated and stored for vendor $vendor" }
            com.genflowly.models.EmbeddingKeyStatus(
                vendor = vendor,
                isAPIKeyValid = true,
                status = com.genflowly.models.APIKeyStatus.VALID,
                updateSuccessful = true
            )
        } else {
            logger.warn { "Invalid embedding API key provided for vendor $vendor. Not saving." }
            com.genflowly.models.EmbeddingKeyStatus(
                vendor = vendor,
                isAPIKeyValid = false,
                status = com.genflowly.models.APIKeyStatus.INVALID,
                updateSuccessful = false,
                detail = result.error?.take(VALIDATION_DETAIL_MAX_CHARS)
            )
        }
    }

    /**
     * Embedding models the customer can pick as their default, per provider.
     * Only providers with a stored API key are listed — no key, no models.
     */
    suspend fun getEmbeddingModels(customerId: String): List<com.genflowly.models.EmbeddingVendorModels> {
        val keysByVendor = com.genflowly.models.EmbeddingVendor.entries.mapNotNull { vendor ->
            val decrypted = customerCredentialsRepository.getCustomerApiKey(vendor.name, customerId)
                ?.let { kmsProvider.decrypt(it) }
            if (decrypted.isNullOrBlank()) null else vendor to decrypted
        }.toMap()
        if (keysByVendor.isEmpty()) return emptyList()

        val modelsByProvider = retrievalServerClient.listModelsByProvider(
            keysByVendor.entries.associate { (vendor, key) -> vendor.toProviderString() to key },
            capability = "embedding"
        )
        return keysByVendor.keys.map { vendor ->
            com.genflowly.models.EmbeddingVendorModels(
                vendor = vendor,
                models = modelsByProvider[vendor.toProviderString()].orEmpty()
            )
        }
    }

    /** Key status per [com.genflowly.models.EmbeddingVendor], NOT_SET when absent. */
    suspend fun getEmbeddingKeyStatuses(customerId: String): List<com.genflowly.models.EmbeddingKeyStatus> {
        val itemsByVendor = customerCredentialsRepository.getCustomerVendorItems(customerId)
            .associateBy { it[com.genflowly.DynamoDBConstants.AI_VENDOR_KEY]?.s() }

        return com.genflowly.models.EmbeddingVendor.entries.map { vendor ->
            val item = itemsByVendor[vendor.name]
            val hasKey = !item?.get("apiKey")?.s().isNullOrBlank()
            // Legacy items may lack the validity flag: a stored key counts as valid.
            val isValid = hasKey && (item?.get("isAPIKeyValid")?.bool() ?: true)
            com.genflowly.models.EmbeddingKeyStatus(
                vendor = vendor,
                isAPIKeyValid = isValid,
                status = when {
                    !hasKey -> com.genflowly.models.APIKeyStatus.NOT_SET
                    isValid -> com.genflowly.models.APIKeyStatus.VALID
                    else -> com.genflowly.models.APIKeyStatus.INVALID
                }
            )
        }
    }

    // ─── Vector DB config ─────────────────────────────────────────────────────

    suspend fun storeCustomerVectorDBConfig(
        customerId: String,
        vendor: String,
        endpoint: String,
        token: String
    ): Boolean {
        val encryptedEndpoint = kmsProvider.encrypt(endpoint)
        val encryptedToken = kmsProvider.encrypt(token)
        customerCredentialsRepository.saveCustomerVectorDBConfig(customerId, vendor, encryptedEndpoint, encryptedToken)
        return true
    }

    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<com.genflowly.models.VectorDBConfigStatus> {
        return customerCredentialsRepository.getCustomerVectorDBConfigStatusList(customerId)
    }

    /**
     * Fire-and-forget check that the customer's vector collections exist on the
     * encoding server. A best-effort onboarding enhancement — requires the
     * caller's auth header, skipped when none is available.
     */
    fun ensureCollectionsExistAsync(customerId: String, authHeader: String?) {
        if (authHeader != null) {
            appScope.launch {
                val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
                encodingServerClient.ensureCollections(customerId, authHeader, prefs?.embeddingModel)
            }
        }
    }

    // ─── Tool credentials ─────────────────────────────────────────────────────

    suspend fun storeToolCredentials(
        customerId: String,
        toolType: String,
        authType: String,
        credentials: Map<String, String>,
    ): StoreToolCredentialsResponse {
        val credentialsJson = Json.encodeToString(credentials)
        val encrypted = kmsProvider.encrypt(credentialsJson)
        customerCredentialsRepository.saveCustomerToolCredentials(customerId, toolType, authType, encrypted)
        return StoreToolCredentialsResponse(
            toolCredentialStatus = ToolCredentialStatus(
                toolType = toolType,
                authType = authType,
                connected = true,
            )
        )
    }

    suspend fun getToolCredentials(customerId: String, toolType: String): Map<String, String>? {
        val item = customerCredentialsRepository.getCustomerToolCredentials(customerId, toolType) ?: return null
        val encrypted = item["credentials"]?.s() ?: return null
        val decrypted = kmsProvider.decrypt(encrypted)
        return Json.decodeFromString(decrypted)
    }

    suspend fun listToolCredentialStatuses(customerId: String): GetToolCredentialStatusListResponse {
        val statuses = customerCredentialsRepository.listCustomerToolCredentials(customerId).map { item ->
            ToolCredentialStatus(
                toolType = item["toolType"]?.s() ?: "",
                authType = item["authType"]?.s() ?: "api_key",
                connected = !item["credentials"]?.s().isNullOrBlank(),
                connectedAt = item["createdAt"]?.s(),
            )
        }
        return GetToolCredentialStatusListResponse(toolCredentialStatuses = statuses)
    }

    suspend fun removeToolCredentials(customerId: String, toolType: String) {
        customerCredentialsRepository.deleteCustomerToolCredentials(customerId, toolType)
    }
}
