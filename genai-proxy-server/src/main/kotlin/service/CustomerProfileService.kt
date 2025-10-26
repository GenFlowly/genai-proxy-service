package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import java.util.*
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

class CustomerProfileService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {
    suspend fun onboardCustomer(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?
    ): String {
        // Check if customer exists
        val existingCustomer = dynamoDBProvider.getCustomerProfile(sub, client)
        if (existingCustomer != null) {
            val existingCustomerId = existingCustomer["customerId"]?.s()
            logger.info { "User already onboarded with customerId=$existingCustomerId" }
            return existingCustomerId
                ?: error("Customer profile exists but missing customerId field")
        }

        // New user path
        val newCustomerId = generateCustomerId()
        dynamoDBProvider.onboardCustomer(
            sub,
            client,
            newCustomerId,
            email,
            name,
            picture
        )
        logger.info { "New user onboarded with customerId=$newCustomerId" }
        return newCustomerId


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


fun generateCustomerId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CUSTOMER-$uuid"
}
