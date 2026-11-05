package com.genflowly.service

import com.genflowly.di.AppScope
import com.genflowly.models.api.GetCustomerInstructionListResponse
import com.genflowly.models.ShareRole
import com.genflowly.models.api.InstructionResponse
import com.genflowly.repository.CustomerProfileRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.ShareRepository
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import com.genflowly.EmbeddingConstants
import com.genflowly.models.GeneratedPersona
import com.genflowly.models.RequestType
import com.genflowly.models.encoding.EncodingInstructionData
import com.genflowly.models.encoding.EncodingSaveInstructionRequest
import com.genflowly.providers.EncodingServerClient
import com.genflowly.providers.RetrievalServerClient
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * The instruction (persona) domain: CRUD with immutable versioning, sharing
 * with role checks, default-instruction resolution, usage tracking, and
 * AI-generated persona metadata.
 */
class InstructionService(
    private val instructionRepository: InstructionRepository,
    private val shareRepository: ShareRepository,
    private val customerProfileRepository: CustomerProfileRepository,
    private val sharedUsersResolver: SharedUsersResolver,
    private val agentResolutionService: AgentResolutionService,
    private val generationAgentExecutor: GenerationAgentExecutor,
    private val encodingServerClient: EncodingServerClient,
    private val retrievalServerClient: RetrievalServerClient,
    private val appScope: AppScope
) {

    /**
     * Resolve the instruction to use when a request selects none. Honors the
     * customer's fallback mode (preferred vs last-used) and ultimately falls back
     * to the SYSTEM default. Returns the full instruction or null if nothing
     * resolves (caller then proceeds with no instruction).
     */
    suspend fun getInstructionVersion(
        customerId: String,
        instructionId: String,
        version: Int
    ): InstructionResponse? {
        val instruction = instructionRepository.getInstruction(instructionId, version)

        if (instruction == null) return null

        var role = ShareRole.OWNER
        if (instruction.creator != customerId) {
            val sharedUsers = sharedUsersResolver.getUsersWithSharedEntity(instructionId)
            val specificShare = sharedUsers.find { it.customerId == customerId }
            val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }

            val share = specificShare ?: publicShare
            if (share == null) return null // Not shared with this customer

            val specificRole = specificShare?.role
            val publicRole = publicShare?.role
            role = if (specificRole == ShareRole.EDIT || publicRole == ShareRole.EDIT) ShareRole.EDIT else ShareRole.VIEW
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

    suspend fun createInstruction(
        customerId: String,
        instructionName: String,
        instruction: String,
        existingInstructionId: String?,
        icon: String? = null,
        color: String? = null,
        tags: List<String>? = null,
        category: String? = null,
        bearerToken: String? = null
    ): InstructionResponse {
        var instructionId = existingInstructionId
        var version = 1

        var creator = customerId
        var role = ShareRole.OWNER

        if (instructionId != null) {
            val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId) ?: 0
            if (latestVersion > 0) {
                val existingInstruction = instructionRepository.getInstruction(instructionId, latestVersion)
                if (existingInstruction != null && existingInstruction.creator != customerId) {
                    // Check if they have EDIT role
                    val hasEdit = hasEditAccess(customerId, instructionId)
                    if (hasEdit) {
                        version = latestVersion + 1
                        creator = existingInstruction.creator
                        role = ShareRole.EDIT
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

        val newInstruction = com.genflowly.models.Instruction(
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

        // Push the new version into the embedding pipeline (semantic search
        // index). Only when the caller is the creator: index rows are stamped
        // with the encoder's customer_id and the store step's delete-before-
        // insert is scoped to it, so a shared-EDIT save would strand the
        // creator's chunks of prior versions under a different partition.
        // Search doesn't care whose partition the rows are in (it filters by
        // instruction key), but each instruction's rows must stay under
        // exactly one customer. Fire-and-forget — indexing is best-effort;
        // DDB is the source of truth.
        if (bearerToken != null && creator == customerId) {
            encodeInstructionAsync(customerId, newInstruction, bearerToken)
        }

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

    /** Async push of an instruction version into the embedding pipeline. */
    private fun encodeInstructionAsync(
        customerId: String,
        instruction: com.genflowly.models.Instruction,
        bearerToken: String
    ) {
        appScope.launch {
            try {
                val prefs = runCatching { customerProfileRepository.getAIConfigPreferences(customerId) }.getOrNull()
                encodingServerClient.encodeInstruction(
                    EncodingSaveInstructionRequest(
                        client = "instruction",
                        modelType = EmbeddingConstants.modelTypeFor(prefs?.embeddingModel),
                        modelName = prefs?.embeddingModel ?: EmbeddingConstants.MODEL_NAME,
                        data = EncodingInstructionData(
                            instruction_id = instruction.id,
                            instructionId = instruction.id,
                            version = instruction.version ?: 1,
                            name = instruction.name,
                            instructions = instruction.instructions,
                            category = instruction.category,
                            tags = instruction.tags,
                            created_at = java.time.Instant.now().toString(),
                            createdAt = java.time.Instant.now().toString()
                        )
                    ),
                    bearerToken
                )
            } catch (e: Exception) {
                logger.error(e) { "Failed to push instruction ${instruction.id} to embedding pipeline" }
            }
        }
    }

    /**
     * Generates persona metadata (icon, color, tags, category — and the name
     * unless one was provided) via AI, then creates the instruction/version.
     */
    suspend fun createInstructionWithGeneratedPersona(
        customerId: String,
        instructionName: String?,
        instruction: String,
        existingInstructionId: String?,
        bearerToken: String? = null
    ): InstructionResponse {
        // Always generate the persona metadata (icon, color, tags) via AI
        val generatedPersona = generateInstructionPersona(instruction, customerId)

        // Use user-provided name if available, otherwise use AI-generated name
        val effectiveName = if (!instructionName.isNullOrBlank()) instructionName else generatedPersona.name

        return createInstruction(
            customerId = customerId,
            instructionName = effectiveName,
            instruction = instruction,
            existingInstructionId = existingInstructionId,
            icon = generatedPersona.icon,
            color = generatedPersona.color,
            tags = generatedPersona.tags,
            category = generatedPersona.category,
            bearerToken = bearerToken
        )
    }

    /** True when [customerId] has EDIT via a direct or PUBLIC share on [instructionId]. */
    private suspend fun hasEditAccess(customerId: String, instructionId: String): Boolean {
        val sharedUsers = sharedUsersResolver.getUsersWithSharedEntity(instructionId)
        val specificShare = sharedUsers.find { it.customerId == customerId }
        val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
        return specificShare?.role == ShareRole.EDIT || publicShare?.role == ShareRole.EDIT
    }

    suspend fun getCustomerInstructions(customerId: String): GetCustomerInstructionListResponse =
        GetCustomerInstructionListResponse(instructions = accessibleInstructions(customerId).map { it.second })

    /** Every accessible version, sorted by id and version desc, with the stored row it came from. */
    private suspend fun accessibleInstructions(customerId: String): List<Pair<com.genflowly.models.Instruction, InstructionResponse>> {
        val ownedInstructions = instructionRepository.getInstructionsByCreator(customerId)

        val sharedInstructionIds = shareRepository.getSharedEntityIdsForCustomer(customerId, "INS-")
        val publicInstructionIds = shareRepository.getSharedEntityIdsForCustomer("PUBLIC", "INS-")

        val roleMap = mutableMapOf<String, ShareRole>()
        publicInstructionIds.forEach { (id, role) -> roleMap[id] = role }
        sharedInstructionIds.forEach { (id, role) ->
            if (role == ShareRole.EDIT || !roleMap.containsKey(id)) {
                roleMap[id] = role
            }
        }

        val sharedInstructions = mutableListOf<com.genflowly.models.Instruction>()
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
        return allInstructions.sortedWith(
            compareBy<com.genflowly.models.Instruction> { it.id }.thenByDescending { it.version }
        ).map { instruction ->
            val role = if (instruction.creator == customerId) ShareRole.OWNER else roleMap[instruction.id] ?: ShareRole.VIEW
            instruction to InstructionResponse(
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

    /**
     * Search over the latest version of every instruction the customer can
     * access — owned AND shared/SYSTEM. Semantic hits come from the vector
     * index (instruction text, name, category and tags are all embedded),
     * ordered by similarity. Each instruction is indexed exactly once, under
     * its creator; visibility is enforced at query time by sending the
     * accessible instruction ids as the index's allow-list, so sharing and
     * unsharing take effect on the next search with no index writes. Latest
     * versions not yet in the vector index (embed in flight or failed, or
     * a new version saved by a shared editor, which is never re-indexed) are
     * keyword-matched instead and listed first. Hits are hydrated back from
     * the accessible-latest set — content always comes from DDB; the index
     * knows only chunk text and keys. A blank query returns all latest
     * instructions. Vector-index failures propagate to the caller.
     */
    suspend fun searchInstructions(customerId: String, query: String): GetCustomerInstructionListResponse {
        val latestRows = accessibleInstructions(customerId)
            .groupBy { it.first.id }
            .values
            .mapNotNull { versions -> versions.maxByOrNull { it.second.version } }
            .sortedByDescending { it.second.version }
        val latest = latestRows.map { it.second }
        val q = query.trim()

        if (q.isEmpty()) {
            return GetCustomerInstructionListResponse(instructions = latest)
        }

        val matcher = KeywordMatcher(q)
        val keyword = latestRows
            .filter { (row, _) ->
                !row.syncedWithVectorDb &&
                        matcher.matches(row.name, row.instructions, row.category, row.tags?.joinToString(" "))
            }
            .map { it.second }
        val accessibleById = latest.associateBy { it.id }
        val semantic = retrievalServerClient
            .search(
                customerId,
                q,
                topN = SEMANTIC_SEARCH_TOP_N,
                types = listOf("instructions"),
                allowedKeys = mapOf("instructions" to latest.map { it.id })
            )
            .mapNotNull { accessibleById[it.key] }
        return GetCustomerInstructionListResponse(
            instructions = KeywordMatcher.mergeKeywordFirst(semantic, keyword, SEMANTIC_SEARCH_TOP_N) { it.id }
        )
    }

    /**
     * The latest versions of the customer's most-recently-used instructions,
     * ordered by recency. Instructions the customer can no longer access
     * (deleted or unshared) are silently dropped.
     */
    suspend fun getRecentlyUsedInstructions(customerId: String, limit: Int): GetCustomerInstructionListResponse {
        val recentIds = instructionRepository.getRecentlyUsedInstructionIds(customerId, limit)
        if (recentIds.isEmpty()) {
            return GetCustomerInstructionListResponse(instructions = emptyList())
        }

        val accessibleById = getLatestCustomerInstructions(customerId).associateBy { it.id }
        return GetCustomerInstructionListResponse(
            instructions = recentIds.mapNotNull { accessibleById[it] }
        )
    }

    suspend fun shareInstruction(instructionId: String, targetCustomerId: String, sharedByCustomerId: String, role: ShareRole) {
        requireOwnerOrEdit(sharedByCustomerId, instructionId)
        shareRepository.shareEntityWithCustomer(instructionId, targetCustomerId, sharedByCustomerId, role)
    }

    suspend fun unshareInstruction(instructionId: String, targetCustomerId: String, sharedByCustomerId: String) {
        requireOwnerOrEdit(sharedByCustomerId, instructionId)
        shareRepository.unshareEntityWithCustomer(instructionId, targetCustomerId)
    }

    private suspend fun requireOwnerOrEdit(customerId: String, instructionId: String) {
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        val instruction = if (latestVersion != null) instructionRepository.getInstruction(instructionId, latestVersion) else null

        if (instruction?.creator != customerId && !hasEditAccess(customerId, instructionId)) {
            throw SecurityException("Customer $customerId does not own or have EDIT rights to instruction $instructionId")
        }
    }

    suspend fun getSharedUsersForInstruction(customerId: String, instructionId: String): List<com.genflowly.models.CustomerProfile> {
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        if (latestVersion != null) {
            val instruction = instructionRepository.getInstruction(instructionId, latestVersion)

            val isOwner = instruction != null && instruction.creator == customerId
            if (!isOwner) {
                val sharedUsers = sharedUsersResolver.getUsersWithSharedEntity(instructionId)
                val specificShare = sharedUsers.find { it.customerId == customerId }
                val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
                val hasEdit = specificShare?.role == ShareRole.EDIT || publicShare?.role == ShareRole.EDIT
                if (!hasEdit) {
                    throw SecurityException("Customer $customerId does not own or have EDIT rights to instruction $instructionId")
                }
                return sharedUsers
            }

            return sharedUsersResolver.getUsersWithSharedEntity(instructionId)
        }
        return emptyList()
    }

    suspend fun deleteInstruction(customerId: String, instructionId: String) {
        // Deleting removes every version globally, so only the creator may do it;
        // shared users can merely un-share.
        val latestVersion = instructionRepository.getLatestInstructionVersion(instructionId)
        if (latestVersion != null) {
            val instruction = instructionRepository.getInstruction(instructionId, latestVersion)
            if (instruction != null && instruction.creator == customerId) {
                instructionRepository.deleteInstruction(instructionId)
                // Hard-delete its embeddings asynchronously (same fire-and-forget
                // convention as notes); a failure leaves orphaned vectors but
                // never blocks or fails the delete itself.
                appScope.launch {
                    try {
                        retrievalServerClient.deleteInstructionVectors(customerId, instructionId)
                    } catch (e: Exception) {
                        logger.error(e) { "Error deleting vectors for instruction $instructionId" }
                    }
                }
            } else {
                throw SecurityException("Customer $customerId does not own instruction $instructionId or it does not exist")
            }
        }
    }

    /**
     * Tracks instruction (persona) usage strictly per (customerId, instructionId) pair,
     * counting each unique (conversationId, instructionId) combination at most once.
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

    suspend fun generateInstructionPersona(
        instructionText: String,
        customerId: String
    ): GeneratedPersona {

        val categoryJson = Json.encodeToString(com.genflowly.PERSONA_CATEGORIES)

        val agent = agentResolutionService.resolve(RequestType.INSTRUCTION_PERSONA, customerId)

        // Persona generation runs on the CUSTOMER's API keys (their
        // prioritized vendor/model configs, or keyed-vendor fallbacks),
        // trying providers in priority order. A JSON parse failure also
        // counts as a generation failure and moves on to the next provider.
        return generationAgentExecutor.executeWithCustomerFailover(
            agent = agent,
            variables = mapOf(
                "categoryJson" to categoryJson,
                "instructionText" to instructionText
            ),
            customerId = customerId,
            conversationId = "instruction-creation",
            operationName = "persona-generation",
            responseSchema = PERSONA_SCHEMA
        ) { responseText ->
            // Structured output makes the response guaranteed JSON; the brace
            // extraction only remains for providers that degrade to raw text.
            runCatching { jsonParser.decodeFromString<GeneratedPersona>(responseText.trim()) }
                .getOrElse {
                    val jsonString = responseText.substringAfter("{").substringBeforeLast("}")
                    jsonParser.decodeFromString("{$jsonString}")
                }
        }
    }

    /** Fire-and-forget AI backfill of missing persona metadata (icon/category). */
    fun backfillInstructionsAsync(
        customerId: String,
        instructionsToCheck: List<InstructionResponse>
    ) {
        appScope.launch {
            try {
                for (instructionRes in instructionsToCheck) {
                    if (instructionRes.icon == null || instructionRes.category == null) {
                        val existing = instructionRepository.getInstruction(instructionRes.id, instructionRes.version)
                        if (existing != null) {
                            val generatedPersona = generateInstructionPersona(existing.instructions, customerId)
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

    companion object {
        private val jsonParser = Json { ignoreUnknownKeys = true }

        // Chunk hits collapse to one entry per instruction, so a modest
        // fan-out is enough to cover the accessible set.
        private const val SEMANTIC_SEARCH_TOP_N = 25

        /** JSON Schema for [GeneratedPersona] — vendor-enforced during persona generation. */
        private val PERSONA_SCHEMA: JsonObject = buildJsonObject {
            put("type", "object")
            put("description", "Persona metadata for a system instruction.")
            putJsonObject("properties") {
                putJsonObject("name") { put("type", "string") }
                putJsonObject("icon") { put("type", "string") }
                putJsonObject("color") { put("type", "string") }
                putJsonObject("category") { put("type", "string") }
                putJsonObject("tags") {
                    put("type", "array")
                    putJsonObject("items") { put("type", "string") }
                }
            }
            putJsonArray("required") {
                add("name"); add("icon"); add("color"); add("category"); add("tags")
            }
            put("additionalProperties", false)
        }
    }
}
