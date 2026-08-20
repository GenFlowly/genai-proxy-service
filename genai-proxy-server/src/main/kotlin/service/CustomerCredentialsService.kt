package com.genflowly.service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.di.AppScope
import com.genflowly.models.api.GetToolCredentialStatusListResponse
import com.genflowly.models.api.StoreToolCredentialsResponse
import com.genflowly.models.api.ToolCredentialStatus
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.KMSProvider
import com.genflowly.repository.CustomerCredentialsRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Customer-owned secret configuration: AI vendor API keys, external tool
 * credentials, vector-DB and Supabase configs. All values are KMS-encrypted
 * before they reach the repository, and decrypted here — never anywhere else.
 */
class CustomerCredentialsService(
    private val kmsProvider: KMSProvider,
    private val customerCredentialsRepository: CustomerCredentialsRepository,
    private val encodingServerClient: EncodingServerClient,
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

    suspend fun getAIVendorAPIKeyStatusList(customerId: String): List<models.AIVendorAPIKeyStatus> {
        val storedKeys = customerCredentialsRepository.getCustomerApiKeys(customerId)
        val storedMap = storedKeys.associateBy { it.aiVendor }

        return AIVendor.entries.map { vendor ->
            storedMap[vendor] ?: models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = false,
                status = models.APIKeyStatus.NOT_SET
            )
        }
    }

    /** Seeds an INVALID key-status row per vendor for a fresh customer. */
    suspend fun initCustomerApiKeys(customerId: String) {
        AIVendor.entries.forEach { vendor ->
            customerCredentialsRepository.initCustomerApiKey(customerId, vendor.name)
        }
    }

    // ─── Vector DB / Supabase config ──────────────────────────────────────────

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

    suspend fun storeCustomerSupabaseConfig(
        customerId: String,
        endpoint: String,
        token: String,
        password: String
    ): Boolean {
        val encryptedEndpoint = kmsProvider.encrypt(endpoint)
        val encryptedToken = kmsProvider.encrypt(token)
        val encryptedPassword = kmsProvider.encrypt(password)
        customerCredentialsRepository.saveCustomerSupabaseConfig(customerId, encryptedEndpoint, encryptedToken, encryptedPassword)
        return true
    }

    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<models.VectorDBConfigStatus> {
        return customerCredentialsRepository.getCustomerVectorDBConfigStatusList(customerId)
    }

    suspend fun getCustomerSupabaseConfigStatus(customerId: String): models.SupabaseConfigStatus? {
        return customerCredentialsRepository.getCustomerSupabaseConfigStatus(customerId)
    }

    /**
     * Fire-and-forget check that the customer's vector collections exist on the
     * encoding server. A best-effort onboarding enhancement — requires the
     * caller's auth header, skipped when none is available.
     */
    fun ensureCollectionsExistAsync(customerId: String, authHeader: String?) {
        if (authHeader != null) {
            appScope.launch {
                encodingServerClient.ensureCollections(customerId, authHeader)
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
