package com.genflowly.service

import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.models.api.GetToolCredentialStatusListResponse
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.api.StoreToolCredentialsResponse
import com.genflowly.models.api.ToolCredentialStatus
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
import com.genflowly.providers.DynamoDBProvider
import com.genflowly.providers.KMSProvider
import java.util.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
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

            val hasDefaultGraph = dynamoDBProvider.getDefaultCustomerGraph(existingCustomerId) != null
            if (!hasDefaultGraph) {
                logger.info { "No default graph found for customerId=$existingCustomerId — seeding now" }
                seedDefaultGraph(existingCustomerId)
            }

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

        // Seed the default RAG pipeline graph for this customer
        seedDefaultGraph(newCustomerId)

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

    suspend fun storeCustomerSupabaseConfig(
        customerId: String,
        endpoint: String,
        token: String,
        password: String
    ): Boolean {
        val encryptedEndpoint = kmsProvider.encrypt(endpoint)
        val encryptedToken = kmsProvider.encrypt(token)
        val encryptedPassword = kmsProvider.encrypt(password)
        dynamoDBProvider.saveCustomerSupabaseConfig(customerId, encryptedEndpoint, encryptedToken, encryptedPassword)
        return true
    }


    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<models.VectorDBConfigStatus> {
        return dynamoDBProvider.getCustomerVectorDBConfigStatusList(customerId)
    }

    suspend fun getCustomerSupabaseConfigStatus(customerId: String): models.SupabaseConfigStatus? {
        return dynamoDBProvider.getCustomerSupabaseConfigStatus(customerId)
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

    private suspend fun seedDefaultGraph(customerId: String) {
        try {
            val queryAnalyzerId = generateNodeId()
            val queryRewriterId = generateNodeId()
            val retrievalId = generateNodeId()
            val resultRankerId = generateNodeId()
            val responseGeneratorId = generateNodeId()

            val queryAnalyzerConfig = """{"system_prompt":"You are a query analysis expert for a vector similarity search system. Analyze the user query and determine the intent and whether it needs rewriting to improve retrieval. Return ONLY valid JSON: {\"intent\": \"<brief description>\", \"needs_rewrite\": <true|false>}","input_template":"Query: {original_query}","response_format":"json","json_output_mapping":{"intent":"query_intent","needs_rewrite":"needs_rewrite"}}"""
            val queryRewriterConfig = """{"system_prompt":"You are a query rewriting expert for a vector similarity search system. Rewrite the query to be more specific and retrievable: expand abbreviations, add missing context, clarify ambiguity. Return ONLY the rewritten query text, nothing else.","input_template":"Original query: {original_query}\nIntent: {query_intent}","output_key":"rewritten_query","response_format":"text"}"""
            val resultRankerConfig = """{"system_prompt":"You are a result ranking expert. Given a query and retrieved document chunks, re-rank them by relevance and remove irrelevant ones. Return ONLY a JSON array of 0-based indices in order of relevance (most relevant first). Include only indices of relevant results. Example: [2, 0, 4]","input_template":"Query: {query}\n\nChunks:\n{chunks_text}","output_key":"ranked_results","response_format":"json_indices","json_indices_source_key":"retrieval_results"}"""
            val responseGeneratorConfig = """{"system_prompt":"You are a helpful AI assistant. Answer the user's question using the provided context. Be concise, accurate, and helpful. If the context lacks enough information, say so clearly but remain as helpful as possible with what is available.","input_template":"Context:\n{context}\n\nQuestion: {query}","output_key":"generated_response","response_format":"text","include_conversation_history":true,"is_streaming":true}"""

            dynamoDBProvider.createCustomerGraphNode(customerId, queryAnalyzerId, "QUERY_ANALYZER", "Query Analyzer", queryAnalyzerConfig)
            dynamoDBProvider.createCustomerGraphNode(customerId, queryRewriterId, "QUERY_REWRITER", "Query Rewriter", queryRewriterConfig)
            dynamoDBProvider.createCustomerGraphNode(customerId, retrievalId, "RETRIEVAL", "Retrieval", "{}")
            dynamoDBProvider.createCustomerGraphNode(customerId, resultRankerId, "RESULT_RANKER", "Result Ranker", resultRankerConfig)
            dynamoDBProvider.createCustomerGraphNode(customerId, responseGeneratorId, "RESPONSE_GENERATOR", "Response Generator", responseGeneratorConfig)

            val edges = """{"edges":[{"from":"$queryRewriterId","to":"$retrievalId"},{"from":"$retrievalId","to":"$resultRankerId"},{"from":"$resultRankerId","to":"$responseGeneratorId"},{"from":"$responseGeneratorId","to":"__end__"}],"conditional_edges":[{"from":"$queryAnalyzerId","condition_key":"needs_rewrite","routes":{"true":"$queryRewriterId","false":"$retrievalId"}}]}"""

            dynamoDBProvider.createCustomerGraph(
                customerId = customerId,
                graphId = generateGraphId(),
                name = "Default Graph",
                isDefault = true,
                nodeIds = listOf(queryAnalyzerId, queryRewriterId, retrievalId, resultRankerId, responseGeneratorId),
                edges = edges,
                entryPoint = queryAnalyzerId
            )
            logger.info { "Seeded default graph for customerId=$customerId" }
        } catch (e: Exception) {
            logger.warn { "Failed to seed default graph for customerId=$customerId: ${e.message}" }
        }
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

    suspend fun storeToolCredentials(
        customerId: String,
        toolType: String,
        authType: String,
        credentials: Map<String, String>,
    ): StoreToolCredentialsResponse {
        val credentialsJson = Json.encodeToString(credentials)
        val encrypted = kmsProvider.encrypt(credentialsJson)
        dynamoDBProvider.saveCustomerToolCredentials(customerId, toolType, authType, encrypted)
        return StoreToolCredentialsResponse(
            toolCredentialStatus = ToolCredentialStatus(
                toolType = toolType,
                authType = authType,
                connected = true,
            )
        )
    }

    suspend fun getToolCredentials(customerId: String, toolType: String): Map<String, String>? {
        val item = dynamoDBProvider.getCustomerToolCredentials(customerId, toolType) ?: return null
        val encrypted = item["credentials"]?.s() ?: return null
        val decrypted = kmsProvider.decrypt(encrypted)
        return Json.decodeFromString(decrypted)
    }

    suspend fun listToolCredentialStatuses(customerId: String): GetToolCredentialStatusListResponse {
        val statuses = dynamoDBProvider.listCustomerToolCredentials(customerId).map { item ->
            ToolCredentialStatus(
                toolType = item["toolType"]?.s() ?: "",
                authType = item["authType"]?.s() ?: "api_key",
                connected = !item["credentials"]?.s().isNullOrBlank(),
                connectedAt = item["createdAt"]?.s(),
            )
        }
        return GetToolCredentialStatusListResponse(toolCredentialStatuses = statuses)
    }

    suspend fun removeToolCredentials(customerId: String, toolType: String) {
        dynamoDBProvider.deleteCustomerToolCredentials(customerId, toolType)
    }
}

fun generateCustomerId(): String {
    val uuid =
        UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CU$uuid"
}

fun generateInstructionId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "INS$uuid"
}

fun generateNodeId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "NOD$uuid"
}

fun generateGraphId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "GRP$uuid"
}
