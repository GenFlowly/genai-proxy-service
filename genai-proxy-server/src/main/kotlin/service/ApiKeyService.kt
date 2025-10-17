package service

import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider

class ApiKeyService(
    private val kmsProvider: KMSProvider,
    private val ddbProvider: DynamoDBProvider
) {
    suspend fun saveApiKey(email: String, provider: String, apiKey: String) {
        val encrypted = kmsProvider.encrypt(apiKey)
        ddbProvider.saveApiKey(email, provider, encrypted)
    }
}
