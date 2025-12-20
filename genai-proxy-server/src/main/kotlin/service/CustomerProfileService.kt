package service

import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.AIConfigPreferences
import com.genflowly.models.AIMode
import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import java.util.*
import models.AIConfig
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

class CustomerProfileService(
    private val kmsProvider: KMSProvider,
    private val dynamoDBProvider: DynamoDBProvider
) {


    suspend fun saveAIConfigPreferences(
        customerId: String,
        preferredModels: AIConfig?,
        preferredGenerativeMode: AIMode,
        otherPreferences: Map<String, String>
    ) {
        // todo reshape data



        // todo dynamoDBProvider.saveAIConfigPreferences(customerId,preferredModels, preferredGenerativeMode, otherPreferences)
    }


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

    suspend fun getCustomerApiKeyForVendor(
        vendor: AIVendor,
        customerId: String
    ): String {
        val apiKey = dynamoDBProvider.getCustomerApiKey(vendor.name, customerId)
        val decrypted = apiKey?.let { kmsProvider.decrypt(it) }
        require(!decrypted.isNullOrBlank()) {
            "API key not found for vendor: " +
                    vendor.name
        }
        return decrypted
    }

    /**
     * Get customerId from sub claim (for JWT authentication)
     * Queries by sub only (partition key) - does not require client
     * @param sub Auth0 subject claim from JWT
     * @return customerId if profile exists, null otherwise
     */
    suspend fun getCustomerIdBySub(sub: String): String? {
        val profile = dynamoDBProvider.queryCustomerProfileBySub(sub)
        return profile?.get("customerId")?.s()
    }
}


fun generateCustomerId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CU$uuid"
}
