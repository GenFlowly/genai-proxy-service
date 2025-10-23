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
    suspend fun onboardCustomer(
        sub: String,
        client: String,
        customerId: String,
        email: String?,
        name: String?,
        picture: String?
    ) {
        try {
            dynamoDBProvider.onboardCustomer(
                sub = sub,
                client = client,
                customerId = customerId,
                email = email,
                name = name,
                picture = picture
            )
            logger.info { "Synced user with sub=$sub, " +
                    "customerId=$customerId, email=${email ?: "not provided"}" }
        } catch (e: Exception) {
            logger.error(e) { "Failed to sync user with sub=$sub" }
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
