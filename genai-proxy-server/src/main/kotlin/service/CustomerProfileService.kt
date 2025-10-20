package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

class CustomerProfileService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {
    suspend fun onboardUser(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?
    ) {
        try {
            dynamoDBProvider.onboardCustomer(
                sub, client, customerId, email,
                name
            )
            logger.info { "Synced user $email ($sub)" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to sync user" }
            throw e
        }
    }

    suspend fun storeApiKey(
        customerId: String, aiVendor: String, apiKey: String
    ) {
        val encrypted = kmsProvider.encrypt(apiKey)
        dynamoDBProvider.saveCustomerApiKey(customerId, aiVendor, encrypted)
    }

    fun getCustomerApiKeyForVendor(
        vendor: AIVendor,
        customerId: String
    ): String {
        val apiKey = dynamoDBProvider.getCustomerApiKey(vendor.name, customerId)
        require(!apiKey.isNullOrBlank()) {
            "API key not found for vendor: " +
                    vendor.name
        }
        return apiKey
    }
}
