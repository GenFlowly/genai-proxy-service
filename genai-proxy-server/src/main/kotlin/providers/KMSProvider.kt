package com.genflowly.providers

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.core.SdkBytes
import software.amazon.awssdk.services.kms.KmsClient
import software.amazon.awssdk.services.kms.model.DecryptRequest
import software.amazon.awssdk.services.kms.model.EncryptRequest

class KMSProvider(
    private val kmsClient: KmsClient,
    private val logger: KLogger
) {
    private val keyId =
        System.getenv("KMS_KEY_ID") ?: error("KMS_KEY_ID is not set")


    suspend fun encrypt(plainText: String): String =
        withContext(Dispatchers.IO) {
            try {
                val request = EncryptRequest.builder()
                    .keyId(keyId)
                    .plaintext(SdkBytes.fromUtf8String(plainText))
                    .build()

                val result = kmsClient.encrypt(request)
                val cipherTextBytes = result.ciphertextBlob().asByteArray()
                java.util.Base64.getEncoder().encodeToString(cipherTextBytes)
            } catch (e: Exception) {
                logger.error("Failed to encrypt text with KMS", e)
                throw e
            }
        }

    suspend fun decrypt(cipherTextBase64: String): String =
        withContext(Dispatchers.IO) {
            try {
                val cipherBytes = java.util.Base64.getDecoder().decode(cipherTextBase64)
                val request = DecryptRequest.builder()
                    .ciphertextBlob(SdkBytes.fromByteArray(cipherBytes))
                    .build()

                val result = kmsClient.decrypt(request)
                result.plaintext().asUtf8String()
            } catch (e: Exception) {
                logger.error("Failed to decrypt text with KMS", e)
                throw e
            }
        }
}