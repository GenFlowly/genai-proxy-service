package com.genflowly.service

import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.models.api.InstructionResponse
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
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

    suspend fun savePreferences(
        customerId: String,
        preferredModels: List<AIConfig>?,
        preferredGenerativeMode: AIMode?,
        otherPreferences: Map<String, String>?
    ) {
        dynamoDBProvider.savePreferences(
            customerId,
            preferredModels,
            preferredGenerativeMode,
            otherPreferences
        )
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?
    ): models.CustomerProfile {
        // Check if customer exists
        val existingCustomer = dynamoDBProvider.getCustomerProfile(sub, client)
        if (existingCustomer != null) {
            val existingCustomerId = existingCustomer["customerId"]?.s()
                ?: error("Customer profile exists but missing customerId field")
            
            logger.info { "User already onboarded with customerId=$existingCustomerId" }
            
            return models.CustomerProfile(
                customerId = existingCustomerId,
                sub = sub,
                client = client,
                email = existingCustomer["email"]?.s(),
                name = existingCustomer["name"]?.s(),
                picture = existingCustomer["picture"]?.s()
            )
        }

        // New user path
        return handleNewUserOnboarding(sub, client, email, name, picture)
    }

    private suspend fun handleNewUserOnboarding(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?
    ): models.CustomerProfile {
        val newCustomerId = generateCustomerId()
        dynamoDBProvider.onboardCustomer(
            sub,
            client,
            newCustomerId,
            email,
            name,
            picture
        )
        
        // Initialize API key entries for all vendors as INVALID (false)
        AIVendor.entries.forEach { vendor ->
            dynamoDBProvider.initCustomerApiKey(newCustomerId, vendor.name)
        }

        // Create default instruction
        createInstruction(
            customerId = newCustomerId,
            instructionName = "You are a helpful assistant",
            instruction = "You are a helpful assistant",
            existingInstructionId = null
        )
        
        logger.info { "New user onboarded with customerId=$newCustomerId" }
        return models.CustomerProfile(
            customerId = newCustomerId,
            sub = sub,
            client = client,
            email = email,
            name = name,
            picture = picture
        )
    }

    suspend fun storeApiKey(
        customerId: String, aiVendor: String, apiKey: String
    ): Boolean {
        val encrypted = kmsProvider.encrypt(apiKey)
        dynamoDBProvider.saveCustomerApiKey(customerId, aiVendor, encrypted)
        return true
    }

    suspend fun storeCustomerVectorDBConfig(
        customerId: String,
        vendor: String,
        endpoint: String,
        token: String
    ): Boolean {
        val encryptedEndpoint = kmsProvider.encrypt(endpoint)
        val encryptedToken = kmsProvider.encrypt(token)
        dynamoDBProvider.saveCustomerVectorDBConfig(customerId, vendor, encryptedEndpoint, encryptedToken)
        return true
    }

    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<models.VectorDBConfigStatus> {
        return dynamoDBProvider.getCustomerVectorDBConfigStatusList(customerId)
    }

    suspend fun getCustomerApiKeyForVendor(
        vendor: AIVendor,
        customerId: String
    ): String? {
        val apiKey = dynamoDBProvider.getCustomerApiKey(vendor.name, customerId)
        val decrypted = apiKey?.let { kmsProvider.decrypt(it) }
        
        if (decrypted.isNullOrBlank()) {
            logger.warn { "API key not found for vendor: ${vendor.name}" }
            return null
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

    suspend fun getAIConfigPreferences(customerId: String): AIConfigPreferences? {
        return dynamoDBProvider.getAIConfigPreferences(customerId)
    }

    suspend fun getAIVendorAPIKeyStatusList(customerId: String): List<models.AIVendorAPIKeyStatus> {
        val storedKeys = dynamoDBProvider.getCustomerApiKeys(customerId)
        val storedMap = storedKeys.associateBy { it.aiVendor }

        return AIVendor.entries.map { vendor ->
            storedMap[vendor] ?: models.AIVendorAPIKeyStatus(
                aiVendor = vendor,
                isAPIKeyValid = false,
                status = models.APIKeyStatus.NOT_SET
            )
        }
    }

    suspend fun createInstruction(
        customerId: String,
        instructionName: String,
        instruction: String,
        existingInstructionId: String?,
    ): InstructionResponse {
        var instructionId = existingInstructionId
        var version = 1

        if (instructionId != null) {
            val latestVersion = dynamoDBProvider.getLatestInstructionVersion(instructionId) ?: 0
            version = latestVersion + 1
        } else {
            instructionId = "INS-${UUID.randomUUID()}"
            version = 1
        }

        val newInstruction = models.Instruction(
            id = instructionId!!,
            creator = customerId,
            name = instructionName,
            instructions = instruction,
            version = version
        )

        dynamoDBProvider.saveInstruction(newInstruction)

        return InstructionResponse(
            id = instructionId,
            version = version,
            name = instructionName,
            instruction = instruction
        )
    }

    suspend fun getCustomerInstructions(customerId: String): GetCustomerInstructionListResponse {
        val instructions = dynamoDBProvider.getInstructionsByCreator(customerId)
        
        // Return all versions, sorted by ID and version desc
        val responseItems = instructions.sortedWith(
            compareBy<models.Instruction> { it.id }.thenByDescending { it.version }
        ).map { instruction ->
            InstructionResponse(
                id = instruction.id,
                name = instruction.name,
                version = instruction.version ?: 1,
                instruction = instruction.instructions
            )
        }
        
        return GetCustomerInstructionListResponse(
            instructions = responseItems
        )
    }

    suspend fun getLatestCustomerInstructions(customerId: String): List<InstructionResponse> {
        val response = getCustomerInstructions(customerId)
        
        // Group by ID and find max version for each
        return response.instructions
            .groupBy { it.id }
            .mapValues { (_, versions) -> 
                versions.maxByOrNull { it.version } 
            }
            .values
            .filterNotNull()
            .sortedByDescending { it.version }
    }

    suspend fun getInstructionVersion(
        customerId: String,
        instructionId: String,
        version: Int
    ): InstructionResponse? {
        val instruction = dynamoDBProvider.getInstruction(instructionId, version)
        
        // Ensure the instruction belongs to the customer
        if (instruction == null || instruction.creator != customerId) {
            return null
        }

        return InstructionResponse(
            id = instruction.id,
            version = instruction.version ?: 1,
            name = instruction.name,
            instruction = instruction.instructions // Add this locally to models
        )
    }
}

fun generateCustomerId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CU$uuid"
}

fun generateInstructionId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "INS$uuid"
}
