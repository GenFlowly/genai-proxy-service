package com.genflowly.service

import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.models.api.GetToolCredentialStatusListResponse
import com.genflowly.models.api.InstructionResponse
import com.genflowly.models.api.StoreToolCredentialsResponse
import com.genflowly.models.api.ToolCredentialStatus
import com.genflowly.aicallerlib.models.AIVendor
import com.genflowly.models.api.AIConfigPreferences
import com.genflowly.models.api.AIMode
import com.genflowly.di.AppScope
import com.genflowly.repository.CustomerCredentialsRepository
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.ShareRepository
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.KMSProvider
import java.util.*
import kotlinx.coroutines.launch
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import models.AIConfig
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

class CustomerProfileService(
    private val kmsProvider: KMSProvider,
    private val customerProfileRepository: CustomerProfileRepository,
    private val customerCredentialsRepository: CustomerCredentialsRepository,
    private val instructionRepository: InstructionRepository,
    private val shareRepository: ShareRepository,
    private val graphRepository: GraphRepository,
    private val encodingServerClient: EncodingServerClient,
    private val appScope: AppScope
) {

    suspend fun savePreferences(
        customerId: String,
        preferredModels: List<AIConfig>?,
        preferredGenerativeMode: AIMode?,
        otherPreferences: Map<String, String>?,
        embeddingMode: String? = null,
        embeddingModel: String? = null,
        preferredInstructionId: String? = null,
        instructionFallbackMode: String? = null
    ) {
        customerProfileRepository.savePreferences(
            customerId,
            preferredModels,
            preferredGenerativeMode,
            otherPreferences,
            embeddingMode,
            embeddingModel,
            preferredInstructionId,
            instructionFallbackMode
        )
    }

    /**
     * Resolve the instruction to use when a request selects none. Honors the
     * customer's fallback mode (preferred vs last-used) and ultimately falls back
     * to the SYSTEM default. Returns (instructionId, version) or null if nothing
     * resolves (caller then proceeds with no instruction).
     */
    suspend fun resolveDefaultInstruction(customerId: String): InstructionResponse? {
        val prefs = customerProfileRepository.getAIConfigPreferences(customerId)

        // Preferred mode (default): use the customer's preferred instruction.
        if (prefs?.instructionFallbackMode != "lastUsed") {
            val pid = prefs?.preferredInstructionId
            if (!pid.isNullOrBlank()) {
                val v = instructionRepository.getLatestInstructionVersion(pid)
                if (v != null) getInstructionVersion(customerId, pid, v)?.let { return it }
            }
        } else {
            // Last-used mode.
            val lastId = instructionRepository.getLastUsedInstructionId(customerId)
            if (!lastId.isNullOrBlank()) {
                val v = instructionRepository.getLatestInstructionVersion(lastId)
                if (v != null) getInstructionVersion(customerId, lastId, v)?.let { return it }
            }
        }

        // Ultimate fallback: the global SYSTEM default instruction. getDefaultSystemInstruction
        // already fetched it in full — map it directly rather than re-fetching.
        val system = instructionRepository.getDefaultSystemInstruction() ?: return null
        return InstructionResponse(
            id = system.id,
            version = system.version ?: 1,
            name = system.name,
            instruction = system.instructions,
            icon = system.icon,
            color = system.color,
            category = system.category,
            tags = system.tags,
            role = "VIEW"
        )
    }

    suspend fun onboardCustomer(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?,
        authHeader: String? = null
    ): models.CustomerProfile {
        // Check if customer exists
        val existingCustomer = customerProfileRepository.getCustomerProfile(sub, client)
        if (existingCustomer != null) {
            val existingCustomerId = existingCustomer["customerId"]?.s()
                ?: error("Customer profile exists but missing customerId field")

            logger.info { "User already onboarded with customerId=$existingCustomerId" }

            val hasDefaultGraph = graphRepository.getDefaultCustomerGraph(existingCustomerId) != null
            if (!hasDefaultGraph) {
                logger.info { "No default graph found for customerId=$existingCustomerId — seeding now" }
                seedDefaultGraph(existingCustomerId)
            }

            ensureCollectionsExistAsync(existingCustomerId, authHeader)

            return models.CustomerProfile(
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

    private fun ensureCollectionsExistAsync(customerId: String, authHeader: String?) {
        if (authHeader != null) {
            appScope.launch {
                encodingServerClient.ensureCollections(customerId, authHeader)
            }
        }
    }

    private suspend fun handleNewUserOnboarding(
        sub: String,
        client: String,
        email: String?,
        name: String?,
        picture: String?,
        authHeader: String?
    ): models.CustomerProfile {
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
        AIVendor.entries.forEach { vendor ->
            customerCredentialsRepository.initCustomerApiKey(newCustomerId, vendor.name)
        }

        // Note: no per-customer default instruction is seeded here. The global
        // SYSTEM/PUBLIC instruction (managed via the admin panel) serves as the
        // default for all customers.

        // Seed the default RAG pipeline graph for this customer
        seedDefaultGraph(newCustomerId)

        logger.info { "New user onboarded with customerId=$newCustomerId" }
        
        ensureCollectionsExistAsync(newCustomerId, authHeader)

        return models.CustomerProfile(
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

    suspend fun storeApiKey(
        customerId: String, aiVendor: String, apiKey: String
    ): Boolean {
        val encrypted = kmsProvider.encrypt(apiKey)
        customerCredentialsRepository.saveCustomerApiKey(customerId, aiVendor, encrypted)
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
        customerCredentialsRepository.saveCustomerVectorDBConfig(customerId, vendor, encryptedEndpoint, encryptedToken)
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
        customerCredentialsRepository.saveCustomerSupabaseConfig(customerId, encryptedEndpoint, encryptedToken, encryptedPassword)
        return true
    }


    suspend fun getCustomerVectorDBConfigStatusList(customerId: String): List<models.VectorDBConfigStatus> {
        return customerCredentialsRepository.getCustomerVectorDBConfigStatusList(customerId)
    }

    suspend fun getCustomerSupabaseConfigStatus(customerId: String): models.SupabaseConfigStatus? {
        return customerCredentialsRepository.getCustomerSupabaseConfigStatus(customerId)
    }

    suspend fun getCustomerApiKeyForVendor(
        vendor: AIVendor,
        customerId: String
    ): String? {
        val apiKey = customerCredentialsRepository.getCustomerApiKey(vendor.name, customerId)
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
        val profile = customerProfileRepository.queryCustomerProfileBySub(sub)
        return profile?.get("customerId")?.s()
    }

    suspend fun getAIConfigPreferences(customerId: String): AIConfigPreferences? {
        return customerProfileRepository.getAIConfigPreferences(customerId)
    }

    suspend fun getAIVendorAPIKeyStatusList(customerId: String): List<models.AIVendorAPIKeyStatus> {
        val storedKeys = customerCredentialsRepository.getCustomerApiKeys(customerId)
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
        icon: String? = null,
        color: String? = null,
        tags: List<String>? = null,
        category: String? = null
    ): InstructionResponse {
        var instructionId = existingInstructionId
        var version = 1

        var creator = customerId
        var role = "OWNER"

        if (instructionId != null) {
            val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId) ?: 0
            if (latestVersion > 0) {
                val existingInstruction = instructionRepository.getInstruction(instructionId, latestVersion)
                if (existingInstruction != null && existingInstruction.creator != customerId) {
                    // Check if they have EDIT role
                    val sharedUsers = shareRepository.getUsersWithSharedEntity(instructionId)
                    val specificShare = sharedUsers.find { it.customerId == customerId }
                    val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
                    val hasEdit = specificShare?.role == "EDIT" || publicShare?.role == "EDIT"
                    if (hasEdit) {
                        version = latestVersion + 1
                        creator = existingInstruction.creator
                        role = "EDIT"
                    } else {
                        // Branch off into a private copy if they only have VIEW or no access
                        instructionId = "INS-${UUID.randomUUID()}"
                        version = 1
                    }
                } else {
                    version = latestVersion + 1
                }
            } else {
                version = 1
            }
        } else {
            instructionId = "INS-${UUID.randomUUID()}"
            version = 1
        }

        val newInstruction = models.Instruction(
            id = instructionId!!,
            creator = creator,
            name = instructionName,
            instructions = instruction,
            version = version,
            icon = icon,
            color = color,
            tags = tags,
            category = category
        )

        instructionRepository.saveInstruction(newInstruction)

        return InstructionResponse(
            id = newInstruction.id,
            name = newInstruction.name,
            version = newInstruction.version ?: 1,
            instruction = newInstruction.instructions,
            icon = newInstruction.icon,
            color = newInstruction.color,
            tags = newInstruction.tags,
            category = newInstruction.category,
            role = role
        )
    }

    suspend fun getCustomerInstructions(customerId: String): GetCustomerInstructionListResponse {
        val ownedInstructions = instructionRepository.getInstructionsByCreator(customerId)
        
        val sharedInstructionIds = shareRepository.getSharedEntityIdsForCustomer(customerId, "INS-")
        val publicInstructionIds = shareRepository.getSharedEntityIdsForCustomer("PUBLIC", "INS-")

        val roleMap = mutableMapOf<String, String>()
        publicInstructionIds.forEach { (id, role) -> roleMap[id] = role }
        sharedInstructionIds.forEach { (id, role) ->
            if (role == "EDIT" || !roleMap.containsKey(id)) {
                roleMap[id] = role
            }
        }
        
        val sharedInstructions = mutableListOf<models.Instruction>()
        for (id in roleMap.keys) {
            val latestVersion = instructionRepository.getLatestInstructionVersion(id)
            if (latestVersion != null) {
                val instruction = instructionRepository.getInstruction(id, latestVersion)
                if (instruction != null) {
                    sharedInstructions.add(instruction)
                }
            }
        }

        val allInstructions = (ownedInstructions + sharedInstructions).distinctBy { it.id to it.version }
        
        // Return all versions, sorted by ID and version desc
        val responseItems = allInstructions.sortedWith(
            compareBy<models.Instruction> { it.id }.thenByDescending { it.version }
        ).map { instruction ->
            val role = if (instruction.creator == customerId) "OWNER" else roleMap[instruction.id] ?: "VIEW"
            InstructionResponse(
                id = instruction.id,
                name = instruction.name,
                version = instruction.version ?: 1,
                instruction = instruction.instructions,
                icon = instruction.icon,
                color = instruction.color,
                category = instruction.category,
                tags = instruction.tags,
                role = role
            )
        }
        
        return GetCustomerInstructionListResponse(
            instructions = responseItems
        )
    }

    suspend fun shareInstruction(instructionId: String, targetCustomerId: String, sharedByCustomerId: String, role: String) {
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        val instruction = if (latestVersion != null) instructionRepository.getInstruction(instructionId, latestVersion) else null

        if (instruction?.creator != sharedByCustomerId) {
            val sharedUsers = shareRepository.getUsersWithSharedEntity(instructionId)
            val specificShare = sharedUsers.find { it.customerId == sharedByCustomerId }
            val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
            val hasEdit = specificShare?.role == "EDIT" || publicShare?.role == "EDIT"
            if (!hasEdit) {
                throw SecurityException("Customer $sharedByCustomerId does not own or have EDIT rights to instruction $instructionId")
            }
        }
        shareRepository.shareEntityWithCustomer(instructionId, targetCustomerId, sharedByCustomerId, role)
    }

    suspend fun unshareInstruction(instructionId: String, targetCustomerId: String, sharedByCustomerId: String) {
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        val instruction = if (latestVersion != null) instructionRepository.getInstruction(instructionId, latestVersion) else null

        if (instruction?.creator != sharedByCustomerId) {
            val sharedUsers = shareRepository.getUsersWithSharedEntity(instructionId)
            val specificShare = sharedUsers.find { it.customerId == sharedByCustomerId }
            val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
            val hasEdit = specificShare?.role == "EDIT" || publicShare?.role == "EDIT"
            if (!hasEdit) {
                throw SecurityException("Customer $sharedByCustomerId does not own or have EDIT rights to instruction $instructionId")
            }
        }
        shareRepository.unshareEntityWithCustomer(instructionId, targetCustomerId)
    }

    suspend fun getSharedUsersForInstruction(customerId: String, instructionId: String): List<models.CustomerProfile> {
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        if (latestVersion != null) {
            val instruction = instructionRepository.getInstruction(instructionId, latestVersion)
            
            val isOwner = instruction != null && instruction.creator == customerId
            if (!isOwner) {
                val sharedUsers = shareRepository.getUsersWithSharedEntity(instructionId)
                val specificShare = sharedUsers.find { it.customerId == customerId }
                val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
                val hasEdit = specificShare?.role == "EDIT" || publicShare?.role == "EDIT"
                if (!hasEdit) {
                    throw SecurityException("Customer $customerId does not own or have EDIT rights to instruction $instructionId")
                }
                return sharedUsers
            }
            
            return shareRepository.getUsersWithSharedEntity(instructionId)
        }
        return emptyList()
    }

    suspend fun deleteInstruction(customerId: String, instructionId: String) {
        // Optional: verify ownership before deleting.
        // If the instruction is shared with them, they can't delete it globally, maybe only un-share it.
        // For now, we will verify they own the latest version.
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        if (latestVersion != null) {
            val instruction = instructionRepository.getInstruction(instructionId, latestVersion)
            if (instruction != null && instruction.creator == customerId) {
                instructionRepository.deleteInstruction(instructionId)
            } else {
                throw SecurityException("Customer $customerId does not own instruction $instructionId or it does not exist")
            }
        }
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
            val responseGeneratorConfig = """{"input_template":"Context:\n{context}\n\nQuestion: {query}","output_key":"generated_response","response_format":"text","include_conversation_history":true,"is_streaming":true}"""

            graphRepository.createCustomerGraphNode(customerId, queryAnalyzerId, "QUERY_ANALYZER", "Query Analyzer", queryAnalyzerConfig)
            graphRepository.createCustomerGraphNode(customerId, queryRewriterId, "QUERY_REWRITER", "Query Rewriter", queryRewriterConfig)
            graphRepository.createCustomerGraphNode(customerId, retrievalId, "RETRIEVAL", "Retrieval", "{}")
            graphRepository.createCustomerGraphNode(customerId, resultRankerId, "RESULT_RANKER", "Result Ranker", resultRankerConfig)
            graphRepository.createCustomerGraphNode(customerId, responseGeneratorId, "RESPONSE_GENERATOR", "Response Generator", responseGeneratorConfig)

            val edges = """{"edges":[{"from":"$queryRewriterId","to":"$retrievalId"},{"from":"$retrievalId","to":"$resultRankerId"},{"from":"$resultRankerId","to":"$responseGeneratorId"},{"from":"$responseGeneratorId","to":"__end__"}],"conditional_edges":[{"from":"$queryAnalyzerId","condition_key":"needs_rewrite","routes":{"true":"$queryRewriterId","false":"$retrievalId"}}]}"""

            graphRepository.createCustomerGraph(
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
        val instruction = instructionRepository.getInstruction(instructionId, version)
        
        if (instruction == null) return null

        var role = "OWNER"
        if (instruction.creator != customerId) {
            val sharedUsers = shareRepository.getUsersWithSharedEntity(instructionId)
            val specificShare = sharedUsers.find { it.customerId == customerId }
            val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
            
            val share = specificShare ?: publicShare
            if (share == null) return null // Not shared with this customer
            
            val specificRole = specificShare?.role
            val publicRole = publicShare?.role
            role = if (specificRole == "EDIT" || publicRole == "EDIT") "EDIT" else "VIEW"
        }

        return InstructionResponse(
            id = instruction.id,
            version = instruction.version ?: 1,
            name = instruction.name,
            instruction = instruction.instructions,
            icon = instruction.icon,
            color = instruction.color,
            category = instruction.category,
            tags = instruction.tags,
            role = role
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
        customerCredentialsRepository.saveCustomerToolCredentials(customerId, toolType, authType, encrypted)
        return StoreToolCredentialsResponse(
            toolCredentialStatus = ToolCredentialStatus(
                toolType = toolType,
                authType = authType,
                connected = true,
            )
        )
    }

    suspend fun getToolCredentials(customerId: String, toolType: String): Map<String, String>? {
        val item = customerCredentialsRepository.getCustomerToolCredentials(customerId, toolType) ?: return null
        val encrypted = item["credentials"]?.s() ?: return null
        val decrypted = kmsProvider.decrypt(encrypted)
        return Json.decodeFromString(decrypted)
    }

    suspend fun listToolCredentialStatuses(customerId: String): GetToolCredentialStatusListResponse {
        val statuses = customerCredentialsRepository.listCustomerToolCredentials(customerId).map { item ->
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
        customerCredentialsRepository.deleteCustomerToolCredentials(customerId, toolType)
    }

    /**
     * Tracks instruction (persona) usage strictly per (customerId, instructionId) pair,
     * counting each unique (conversationId, instructionId) combination at most once.
     *
     * Steps:
     *  1. Conditionally write to InstructionUsageSeen to mark this pair as seen.
     *  2. If it was new (first time), atomically increment the counter and update lastUsedAt
     *     in InstructionUsage.
     *  3. If it was already seen, skip — avoids double-counting messages in the same conversation.
     *
     * Any failure is swallowed with a warning so it never disrupts the generate-text flow.
     */
    suspend fun trackInstructionUsage(
        customerId: String,
        conversationId: String,
        instructionId: String
    ) {
        try {
            val isNew = instructionRepository.markInstructionUsageSeenIfNew(
                customerId, conversationId, instructionId
            )
            if (isNew) {
                val now = java.time.Instant.now().toString()
                instructionRepository.incrementInstructionUsage(customerId, instructionId, now)
            }
        } catch (e: Exception) {
            logger.warn { "Failed to track instruction usage for instructionId=$instructionId customerId=$customerId: ${e.message}" }
        }
    }
    fun backfillInstructionsAsync(
        customerId: String,
        instructionsToCheck: List<InstructionResponse>,
        aiRequestManager: AIRequestManager
    ) {
        appScope.launch {
            try {
                for (instructionRes in instructionsToCheck) {
                    if (instructionRes.icon == null || instructionRes.category == null) {
                        val existing = instructionRepository.getInstruction(instructionRes.id, instructionRes.version)
                        if (existing != null) {
                            val generatedPersona = aiRequestManager.generateInstructionPersona(existing.instructions, customerId)
                            val backfilled = existing.copy(
                                category = generatedPersona.category,
                                icon = generatedPersona.icon,
                                color = generatedPersona.color,
                                tags = generatedPersona.tags
                            )
                            instructionRepository.saveInstruction(backfilled)
                            logger.info { "AI backfilled instruction ${existing.id} for $customerId" }
                        }
                    }
                }
            } catch (e: Exception) {
                logger.error(e) { "Failed AI backfill for customer $customerId" }
            }
        }
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
