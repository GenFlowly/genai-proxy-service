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

/** WEB_SEARCH settings key: hard per-message web-search limit. Name and the
 * 1..20 bounds must stay in sync with the retrieval-server's tool_executor
 * and the react app's WebSearchToolSettings card. */
private const val MAX_SEARCHES_SETTING = "max_searches_per_turn"

class CustomerCredentialsService(
    private val kmsProvider: KMSProvider,
    private val customerCredentialsRepository: CustomerCredentialsRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val encodingServerClient: EncodingServerClient,
    private val retrievalServerClient: RetrievalServerClient,
    private val vendorAllowlistService: VendorAllowlistService,
    private val appScope: AppScope,
    private val embeddingModelCatalogService: EmbeddingModelCatalogService,
    private val customerEntitlementService: CustomerEntitlementService
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
            customerEntitlementService.refresh(customerId)
            // An OPENAI chat key doubles as the embedding key, and chat
            // validation (models.list) can pass for a key that cannot embed.
            // Refresh the embedding catalog now so capability — or the lack
            // of it — is known before any embedding picker opens.
            if (vendor.name == com.genflowly.models.EmbeddingVendor.OPENAI.name) {
                embeddingModelCatalogService.probeOnKeyChangeAsync(
                    customerId, com.genflowly.models.EmbeddingVendor.OPENAI, apiKey
                )
            }
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
        priority: Int,
        /** Default reasoning effort for the vendor; null/blank = vendor default. */
        thinkingLevel: String? = null
    ) {
        val normalizedThinking = thinkingLevel?.takeIf { it.isNotBlank() }
        customerCredentialsRepository.updateCustomerVendorConfig(
            customerId = customerId,
            aiVendor = vendor.name,
            selectedModel = model,
            priority = priority,
            thinkingLevel = normalizedThinking
        )
        val current = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }
            .getOrNull()?.preferredModels.orEmpty()
        val existing = current.firstOrNull { it.aiVendor == vendor }
        val updated = current.filterNot { it.aiVendor == vendor } +
            com.genflowly.models.AIConfig(
                aiVendor = vendor, model = model, maxTokens = existing?.maxTokens,
                thinkingLevel = normalizedThinking
            )
        customerProfileRepository.savePreferences(
            customerId = customerId,
            preferredModels = updated,
            otherPreferences = null
        )
    }

    /**
     * The provider every background task (titles, learning facts, instruction
     * personas) runs on, so their content reaches only the vendor the customer
     * ranked first: the valid key with the lowest priority or, when no key has
     * a priority, the key added first. Null when no valid AI key is stored.
     */
    suspend fun getPrimaryProvider(customerId: String): com.genflowly.models.PrimaryAIProvider? {
        val primary = customerCredentialsRepository.getCustomerVendorItems(customerId).mapNotNull { item ->
            val vendor = item[com.genflowly.DynamoDBConstants.AI_VENDOR_KEY]?.s()
                ?.let { AIVendor.fromStoredNameOrNull(it) }
                ?: return@mapNotNull null
            val encrypted = item["apiKey"]?.s()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            // Legacy items may lack the validity flag: a stored key counts as valid.
            if (item["isAPIKeyValid"]?.bool() == false) return@mapNotNull null
            StoredAIKey(
                vendor = vendor,
                encryptedKey = encrypted,
                priority = item["priority"]?.n()?.toIntOrNull(),
                createdAt = item["createdAt"]?.s()?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() },
                selectedModel = item["selectedModel"]?.s()
            )
        }.minWithOrNull(
            compareBy<StoredAIKey>(
                { it.priority ?: Int.MAX_VALUE },
                // Legacy rows without createdAt rank after dated ones, then
                // in the stable legacy-vendor order.
                { it.createdAt ?: java.time.Instant.MAX },
                { AIVendor.entries.indexOf(it.vendor).takeIf { i -> i >= 0 } ?: AIVendor.entries.size },
                { it.vendor.name }
            )
        ) ?: return null

        // preferredModels (shared with the AI-config widget) is the source of
        // truth for each vendor's model; the vendor item's selectedModel is a
        // legacy fallback for customers who never saved widget preferences.
        val chatModel = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }
            .getOrNull()?.preferredModels?.firstOrNull { it.aiVendor == primary.vendor }?.model
            ?: primary.selectedModel
        return com.genflowly.models.PrimaryAIProvider(
            aiVendor = primary.vendor,
            apiKey = kmsProvider.decrypt(primary.encryptedKey),
            chatModel = chatModel?.takeIf { it.isNotBlank() }
        )
    }

    private data class StoredAIKey(
        val vendor: AIVendor,
        val encryptedKey: String,
        val priority: Int?,
        val createdAt: java.time.Instant?,
        val selectedModel: String?
    )

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
    // and HUGGINGFACE get their own rows that the AIVendor-based readers above
    // silently skip. The HUGGINGFACE row's sort key is a contract with the
    // retrieval server, which reads it for Hub tokenizer downloads.

    /**
     * Validates an embedding key against the provider and stores it encrypted
     * only when valid — the embedding twin of [validateAndStoreVendorKey].
     */
    suspend fun validateAndStoreEmbeddingKey(
        customerId: String,
        vendor: com.genflowly.models.EmbeddingVendor,
        apiKey: String
    ): com.genflowly.models.EmbeddingKeyStatus {
        if (!vendor.embeds) {
            // A Hub token is not an inference key — there is no provider call
            // to validate it against, and nothing to probe. Store as-is.
            storeApiKey(customerId = customerId, aiVendor = vendor.name, apiKey = apiKey)
            logger.info { "Stored $vendor token without provider validation" }
            customerEntitlementService.refresh(customerId)
            return com.genflowly.models.EmbeddingKeyStatus(
                vendor = vendor,
                isAPIKeyValid = true,
                status = com.genflowly.models.APIKeyStatus.VALID,
                updateSuccessful = true
            )
        }
        val result = retrievalServerClient.validateProviderKeyDetailed(vendor.toProviderString(), apiKey)

        return if (result.valid) {
            storeApiKey(customerId = customerId, aiVendor = vendor.name, apiKey = apiKey)
            logger.info { "Embedding API key validated and stored for vendor $vendor" }
            customerEntitlementService.refresh(customerId)
            // Discover which models THIS key can actually embed, so the model
            // picker is accurate by the time the customer opens it.
            embeddingModelCatalogService.probeOnKeyChangeAsync(customerId, vendor, apiKey)
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
     * Only providers with a stored API key that can actually embed are listed
     * — no key, no models; a key the vendor rejects for embeddings hides the
     * provider exactly as if no key were set.
     */
    suspend fun getEmbeddingModels(customerId: String): List<com.genflowly.models.EmbeddingVendorModels> {
        val keysByVendor = com.genflowly.models.EmbeddingVendor.entries.filter { it.embeds }.mapNotNull { vendor ->
            val decrypted = customerCredentialsRepository.getCustomerApiKey(vendor.name, customerId)
                ?.let { kmsProvider.decrypt(it) }
            if (decrypted.isNullOrBlank()) null else vendor to decrypted
        }.toMap()
        if (keysByVendor.isEmpty()) return emptyList()

        // Serve the probed list — only models this key actually embeds — never
        // the raw LiteLLM catalog (which lists models the encoder rejects, e.g.
        // voyage-multimodal-*). Undetermined (probe infra down, no cache)
        // surfaces as an empty list rather than reintroducing unvalidated
        // options.
        return keysByVendor.mapNotNull { (vendor, key) ->
            when (val catalog = embeddingModelCatalogService.getCatalog(customerId, vendor, key)) {
                is EmbeddingCatalog.Models ->
                    com.genflowly.models.EmbeddingVendorModels(vendor = vendor, models = catalog.models)
                EmbeddingCatalog.KeyCannotEmbed -> null
                EmbeddingCatalog.Undetermined ->
                    com.genflowly.models.EmbeddingVendorModels(vendor = vendor, models = emptyList())
            }
        }
    }

    /**
     * Throws IllegalArgumentException if [modelName] is set but the customer's
     * key can't embed it — the save-time gate for embedding-model preferences.
     * Delegates to the probe-backed catalog (no hardcoded allowlist).
     */
    suspend fun assertEmbeddingModelSupported(customerId: String, modelName: String?) =
        embeddingModelCatalogService.assertModelSupported(customerId, modelName)

    /** See [EmbeddingModelCatalogService.isModelUnusable]. */
    suspend fun isEmbeddingModelUnusable(customerId: String, modelName: String): Boolean =
        embeddingModelCatalogService.isModelUnusable(customerId, modelName)

    /** Key status per [com.genflowly.models.EmbeddingVendor], NOT_SET when absent. */
    suspend fun getEmbeddingKeyStatuses(customerId: String): List<com.genflowly.models.EmbeddingKeyStatus> {
        val itemsByVendor = customerCredentialsRepository.getCustomerVendorItems(customerId)
            .associateBy { it[com.genflowly.DynamoDBConstants.AI_VENDOR_KEY]?.s() }

        return com.genflowly.models.EmbeddingVendor.entries.map { vendor ->
            val item = itemsByVendor[vendor.name]
            val hasKey = !item?.get("apiKey")?.s().isNullOrBlank()
            // Legacy items may lack the validity flag: a stored key counts as valid.
            val isValid = hasKey && (item?.get("isAPIKeyValid")?.bool() ?: true)
            // A stored, vendor-accepted key can still be unable to EMBED (an
            // OpenAI key passes chat validation but 403s on /v1/embeddings).
            // Fold the probe verdict in so the embedding UI reports such a key
            // as unusable instead of silently offering no models. Non-embedding
            // credentials (the HUGGINGFACE token) are never probed.
            val cannotEmbed = vendor.embeds && isValid &&
                embeddingModelCatalogService.cachedKeyCannotEmbed(customerId, vendor)
            com.genflowly.models.EmbeddingKeyStatus(
                vendor = vendor,
                isAPIKeyValid = isValid && !cannotEmbed,
                status = when {
                    !hasKey -> com.genflowly.models.APIKeyStatus.NOT_SET
                    cannotEmbed -> com.genflowly.models.APIKeyStatus.INVALID
                    isValid -> com.genflowly.models.APIKeyStatus.VALID
                    else -> com.genflowly.models.APIKeyStatus.INVALID
                },
                detail = if (cannotEmbed) {
                    "This key cannot access embedding models — update its permissions, or save a key that can."
                } else null
            )
        }
    }

    /**
     * Removes a stored embedding-page credential. Restricted to non-embedding
     * tokens (HUGGINGFACE): the OPENAI row doubles as the LLM key, and VOYAGE
     * removal would strand stored embedding-model preferences and collections.
     */
    suspend fun deleteEmbeddingKey(customerId: String, vendor: com.genflowly.models.EmbeddingVendor) {
        require(!vendor.embeds) { "Only the ${com.genflowly.models.EmbeddingVendor.HUGGINGFACE.name} token can be deleted" }
        customerCredentialsRepository.deleteCustomerApiKey(customerId, vendor.name)
        customerEntitlementService.refresh(customerId)
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
        customerEntitlementService.refresh(customerId)
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
                if (customerEntitlementService.getOrNull(customerId)?.canIndex == false) return@launch
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
        credentials: Map<String, String>?,
        settings: Map<String, String>? = null,
    ): StoreToolCredentialsResponse {
        require(!credentials.isNullOrEmpty() || settings != null) {
            "Provide credentials and/or settings"
        }
        settings?.let { validateToolSettings(it) }
        val encrypted = credentials?.takeIf { it.isNotEmpty() }
            ?.let { kmsProvider.encrypt(Json.encodeToString(it)) }
        val settingsJson = settings?.let { Json.encodeToString(it) }
        customerCredentialsRepository.saveCustomerToolCredentials(
            customerId, toolType, authType, encrypted, settingsJson
        )
        customerEntitlementService.refresh(customerId)
        // Read back so `connected` reflects what is actually stored — a
        // settings-only save on an item with no key must not report connected.
        val item = customerCredentialsRepository.getCustomerToolCredentials(customerId, toolType)
        return StoreToolCredentialsResponse(
            toolCredentialStatus = ToolCredentialStatus(
                toolType = toolType,
                authType = item?.get("authType")?.s() ?: authType,
                connected = !item?.get("credentials")?.s().isNullOrBlank(),
                connectedAt = item?.get("createdAt")?.s(),
                settings = parseToolSettings(item?.get(com.genflowly.DynamoDBConstants.TOOL_SETTINGS_KEY)?.s()),
            )
        )
    }

    /**
     * Plain non-secret per-tool config. Only known keys are validated;
     * unknown keys pass through so a newer client is never rejected by an
     * older server. Bounds must stay in sync with the retrieval-server's
     * tool_executor (_HARD_CAP_BOUNDS) and the Settings → Tools card.
     */
    private fun validateToolSettings(settings: Map<String, String>) {
        settings[MAX_SEARCHES_SETTING]?.let { raw ->
            val n = raw.toIntOrNull()
            require(n != null && n in 1..20) {
                "$MAX_SEARCHES_SETTING must be an integer between 1 and 20"
            }
        }
    }

    private fun parseToolSettings(json: String?): Map<String, String>? =
        json?.takeIf { it.isNotBlank() }?.let {
            runCatching { Json.decodeFromString<Map<String, String>>(it) }.getOrNull()
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
                settings = parseToolSettings(item[com.genflowly.DynamoDBConstants.TOOL_SETTINGS_KEY]?.s()),
            )
        }
        return GetToolCredentialStatusListResponse(toolCredentialStatuses = statuses)
    }

    suspend fun removeToolCredentials(customerId: String, toolType: String) {
        customerCredentialsRepository.deleteCustomerToolCredentials(customerId, toolType)
        customerEntitlementService.refresh(customerId)
    }

    /**
     * Removes every key and credential the customer stored: AI and embedding
     * keys, the vector DB connection, and tool and connector credentials.
     * Tools keep their non-secret settings. Vectors already in the customer's
     * vector DB stay there. Returns how many credentials were removed.
     */
    suspend fun deleteAllCredentials(customerId: String): Int {
        val keys = customerCredentialsRepository.deleteAllCustomerApiKeys(customerId)
        val vectorDb = if (customerCredentialsRepository.deleteCustomerVectorDBConfig(customerId)) 1 else 0
        val tools = customerCredentialsRepository.removeAllToolCredentials(customerId)
        customerEntitlementService.refresh(customerId)
        val removed = keys + vectorDb + tools
        logger.info { "Removed $removed credential(s) for customer $customerId" }
        return removed
    }
}
