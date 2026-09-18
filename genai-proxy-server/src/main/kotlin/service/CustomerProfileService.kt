package com.genflowly.service

import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
import com.genflowly.models.api.OnboardCustomerResponse
import com.genflowly.repository.CustomerProfileRepository
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import com.genflowly.models.AIConfig
import com.genflowly.models.generateCustomerId
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * The customer profile domain: onboarding orchestration, profile reads,
 * username/discoverability settings, user search and AI-config preferences.
 * Credentials live in CustomerCredentialsService; instructions in
 * InstructionService; graphs in GraphService.
 */
class CustomerProfileService(
    private val customerProfileRepository: CustomerProfileRepository,
    private val customerCredentialsService: CustomerCredentialsService,
    private val instructionService: InstructionService,
    private val appConfig: com.genflowly.config.AppConfig
) {

    suspend fun savePreferences(
        customerId: String,
        preferredModels: List<AIConfig>?,
        preferredGenerativeMode: AIMode?,
        otherPreferences: Map<String, String>?,
        embeddingMode: String? = null,
        embeddingModel: String? = null,
        embeddingModelConversations: String? = null,
        embeddingModelNotes: String? = null,
        preferredInstructionId: String? = null,
        instructionFallbackMode: String? = null,
        preferredAgentId: String? = null
    ) {
        customerProfileRepository.savePreferences(
            customerId,
            preferredModels,
            preferredGenerativeMode,
            otherPreferences,
            embeddingMode,
            embeddingModel,
            embeddingModelConversations,
            embeddingModelNotes,
            preferredInstructionId,
            instructionFallbackMode,
            preferredAgentId
        )
    }

    suspend fun getAIConfigPreferences(customerId: String): AIConfigPreferences? {
        return customerProfileRepository.getAIConfigPreferences(customerId)
    }

    /**
     * Resolve the customerId for an Auth0 token. The same person (sub) holds a
     * separate customer account per app, so when the token's azp maps to a known
     * app the lookup is keyed by (sub, client) — an admin-panel token can never
     * resolve to the web-app account or vice versa. An unmapped azp falls back
     * to sub-only resolution for backward compatibility.
     */
    suspend fun getCustomerIdForToken(sub: String, azp: String?): String? {
        val client = appConfig.clientAppForAzp(azp)
        if (client != null) {
            // No cross-app fallback: a missing profile means this app's account
            // doesn't exist yet and the frontend must onboard it.
            return customerProfileRepository.getCustomerProfile(sub, client)?.get("customerId")?.s()
        }
        return getCustomerIdBySub(sub)
    }

    /**
     * Get customerId from sub claim (for JWT authentication)
     * Queries by sub only (partition key) - does not require client
     * @param sub Auth0 subject claim from JWT
     * @return customerId if profile exists, null otherwise
     */
    suspend fun getCustomerIdBySub(sub: String): String? {
        val profile = customerProfileRepository.queryCustomerProfileBySub(sub)
        return profile?.get("customerId")?.s()
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?,
        authHeader: String? = null
    ): com.genflowly.models.CustomerProfile {
        // Check if customer exists
        val existingCustomer = customerProfileRepository.getCustomerProfile(sub, client)
        if (existingCustomer != null) {
            val existingCustomerId = existingCustomer["customerId"]?.s()
                ?: error("Customer profile exists but missing customerId field")

            logger.info { "User already onboarded with customerId=$existingCustomerId" }

            customerCredentialsService.ensureCollectionsExistAsync(existingCustomerId, authHeader)

            return com.genflowly.models.CustomerProfile(
                customerId = existingCustomerId,
                sub = sub,
                client = client,
                email = existingCustomer["email"]?.s(),
                name = existingCustomer["name"]?.s(),
                picture = existingCustomer["picture"]?.s(),
                username = existingCustomer["username"]?.s(),
                isDiscoverable = existingCustomer["isDiscoverable"]?.bool() ?: false
            )
        }

        // New user path
        return handleNewUserOnboarding(sub, client, email, name, picture, authHeader)
    }

    private suspend fun handleNewUserOnboarding(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?,
        authHeader: String?
    ): com.genflowly.models.CustomerProfile {
        val newCustomerId = generateCustomerId()
        val generatedUsername = customerProfileRepository.onboardCustomer(
            sub,
            client,
            newCustomerId,
            email,
            name,
            picture
        )

        // Initialize API key entries for all vendors as INVALID (false)
        customerCredentialsService.initCustomerApiKeys(newCustomerId)

        // Note: no per-customer default instruction or graph is seeded here.
        // The global SYSTEM/PUBLIC instruction and the System-published default
        // graph (both managed via the admin panel) serve as the defaults for
        // all customers; a customer's first edit forks them a private copy.

        logger.info { "New user onboarded with customerId=$newCustomerId" }

        customerCredentialsService.ensureCollectionsExistAsync(newCustomerId, authHeader)

        return com.genflowly.models.CustomerProfile(
            customerId = newCustomerId,
            sub = sub,
            client = client,
            email = email,
            name = name,
            picture = picture,
            username = generatedUsername,
            isDiscoverable = false
        )
    }

    /**
     * Onboards (or re-fetches) the customer and assembles the full bootstrap
     * state the web app needs: preferences, key statuses, instructions and
     * config statuses. Independent reads run concurrently; the AI persona
     * backfill is fired and forgotten.
     */
    suspend fun onboardAndBootstrap(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?,
        authHeader: String? = null
    ): OnboardCustomerResponse {
        val customerProfile = onboardCustomer(sub, client, email, name, picture, authHeader)

        // Fetch additional details — independent reads keyed only by
        // customerId, so run them concurrently
        return coroutineScope {
            val aiConfigPreferences = async { getAIConfigPreferences(customerProfile.customerId) }
            val aiVendorAPIKeyStatusList = async { customerCredentialsService.getAIVendorAPIKeyStatusList(customerProfile.customerId) }
            val vectorDBConfigStatusList = async { customerCredentialsService.getCustomerVectorDBConfigStatusList(customerProfile.customerId) }
            val customerInstructions = async { instructionService.getLatestCustomerInstructions(customerProfile.customerId) }

            // Fire and forget backfill missing categories/icons using AI
            instructionService.backfillInstructionsAsync(customerProfile.customerId, customerInstructions.await())

            OnboardCustomerResponse(
                customerId = customerProfile.customerId,
                aiConfigPreferences = aiConfigPreferences.await() ?: AIConfigPreferences(),
                aiVendorAPIKeyStatusList = aiVendorAPIKeyStatusList.await(),
                customerName = customerProfile.name ?: "User",
                customerPicture = customerProfile.picture,
                customerInstructions = customerInstructions.await(),
                vectorDBConfigStatusList = vectorDBConfigStatusList.await()
            )
        }
    }

    // ─── Profile settings & search (thin delegations for the API layer) ───────

    suspend fun getProfile(sub: String, client: String) =
        customerProfileRepository.getCustomerProfile(sub, client)

    suspend fun updateUsername(sub: String, client: String, customerId: String, oldUsername: String?, newUsername: String) =
        customerProfileRepository.updateUsername(sub, client, customerId, oldUsername, newUsername)

    suspend fun updateDiscoverability(sub: String, client: String, isDiscoverable: Boolean) =
        customerProfileRepository.updateDiscoverability(sub, client, isDiscoverable)

    suspend fun searchByUsername(usernamePrefix: String) =
        customerProfileRepository.searchByUsername(usernamePrefix)

    suspend fun getProfileByCustomerId(customerId: String) =
        customerProfileRepository.getCustomerProfileByCustomerId(customerId)
}
