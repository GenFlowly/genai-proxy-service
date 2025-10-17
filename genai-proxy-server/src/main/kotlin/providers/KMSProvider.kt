package com.genflowly.providers

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import mu.KLogger
import software.amazon.awssdk.core.SdkBytes
import software.amazon.awssdk.services.kms.KmsClient
import software.amazon.awssdk.services.kms.model.EncryptRequest

class KMSProvider(
    private val kmsClient: KmsClient,
    private val logger: KLogger
) {
    private val keyId =
        "arn:aws:kms:us-east-1:571600870493:key/8bc6d55c-6c42-4e0e-8851-eb59740223d4"

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
}