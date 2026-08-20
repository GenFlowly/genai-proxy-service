package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.DeveloperApiKeyCreatedResponse
import com.genflowly.models.api.DeveloperApiKeySummary
import com.genflowly.repository.DeveloperApiKeyRepository
import com.genflowly.providers.KMSProvider
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory

/**
 * Developer API keys: an alternative to Auth0 JWTs for programmatic access.
 *
 * Format: "gfy_" + 40 random base62 chars, shown to the user exactly once.
 * Storage: partition key is the SHA-256 hash of the full key (for O(1) auth lookup);
 * the key itself is stored KMS-encrypted (same key as the AI vendor API keys table).
 */
class DeveloperApiKeyService(
    private val developerApiKeyRepository: DeveloperApiKeyRepository,
    private val kmsProvider: KMSProvider,
    private val appScope: AppScope
) {
    private val logger = LoggerFactory.getLogger("DeveloperApiKeyService")
    private val secureRandom = SecureRandom()

    companion object {
        const val KEY_PREFIX = "gfy_"
        private const val KEY_RANDOM_LENGTH = 40
        private const val DISPLAY_PREFIX_LENGTH = 12
        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    }

    suspend fun createKey(customerId: String, name: String): DeveloperApiKeyCreatedResponse {
        val apiKey = KEY_PREFIX + buildString {
            repeat(KEY_RANDOM_LENGTH) { append(ALPHABET[secureRandom.nextInt(ALPHABET.length)]) }
        }
        val keyId = UUID.randomUUID().toString()
        val prefix = apiKey.take(DISPLAY_PREFIX_LENGTH)
        val createdAt = Instant.now().toString()

        val encryptedKey = kmsProvider.encrypt(apiKey)
        developerApiKeyRepository.saveDeveloperApiKey(
            keyHash = sha256(apiKey),
            keyId = keyId,
            customerId = customerId,
            name = name,
            prefix = prefix,
            encryptedKey = encryptedKey
        )

        logger.info("Created developer API key {} for customer {}", keyId, customerId)

        return DeveloperApiKeyCreatedResponse(
            keyId = keyId,
            name = name,
            apiKey = apiKey,
            prefix = prefix,
            createdAt = createdAt
        )
    }

    suspend fun listKeys(customerId: String): List<DeveloperApiKeySummary> {
        return developerApiKeyRepository.queryDeveloperApiKeysByCustomer(customerId).map { item ->
            DeveloperApiKeySummary(
                keyId = item["keyId"]?.s() ?: "",
                name = item["name"]?.s() ?: "",
                prefix = item["prefix"]?.s() ?: "",
                createdAt = item["createdAt"]?.s(),
                lastUsedAt = item["lastUsedAt"]?.s()
            )
        }
    }

    /**
     * Deletes the key with the given keyId, verifying it belongs to [customerId].
     * @return true if a key was deleted, false if no such key exists for this customer
     */
    suspend fun revokeKey(customerId: String, keyId: String): Boolean {
        val item = developerApiKeyRepository.queryDeveloperApiKeysByCustomer(customerId)
            .firstOrNull { it["keyId"]?.s() == keyId }
            ?: return false

        val keyHash = item["keyHash"]?.s() ?: return false
        developerApiKeyRepository.deleteDeveloperApiKey(keyHash)
        logger.info("Revoked developer API key {} for customer {}", keyId, customerId)
        return true
    }

    /**
     * Resolves an API key presented as a bearer token to a customerId.
     * @return the customerId, or null if the key is unknown or revoked
     */
    suspend fun authenticate(apiKey: String): String? {
        if (!apiKey.startsWith(KEY_PREFIX)) return null

        return try {
            val keyHash = sha256(apiKey)
            val item = developerApiKeyRepository.getDeveloperApiKeyByHash(keyHash) ?: return null
            if (item["revoked"]?.bool() == true) return null

            val customerId = item["customerId"]?.s() ?: return null

            // Best-effort usage tracking; must not block or fail the request
            appScope.launch {
                developerApiKeyRepository.updateDeveloperApiKeyLastUsed(keyHash)
            }

            customerId
        } catch (e: Exception) {
            // Fail closed: any lookup error means the key is not accepted
            logger.error("Developer API key lookup failed", e)
            null
        }
    }

    private fun sha256(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
