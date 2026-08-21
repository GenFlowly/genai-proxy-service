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
import com.genflowly.models.AIConfig
import com.genflowly.models.GeneratedPersona
import com.genflowly.models.Message
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
    private val utilityGenerationService: UtilityGenerationService,
    private val systemAIFailoverService: SystemAIFailoverService,
    private val appScope: AppScope
) {

    /**
     * Resolve the instruction to use when a request selects none. Honors the
     * customer's fallback mode (preferred vs last-used) and ultimately falls back
     * to the SYSTEM default. Returns the full instruction or null if nothing
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
            role = ShareRole.VIEW
        )
    }

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
        category: String? = null
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

    /**
     * Generates persona metadata (icon, color, tags, category — and the name
     * unless one was provided) via AI, then creates the instruction/version.
     */
    suspend fun createInstructionWithGeneratedPersona(
        customerId: String,
        instructionName: String?,
        instruction: String,
        existingInstructionId: String?
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
            category = generatedPersona.category
        )
    }

    /** True when [customerId] has EDIT via a direct or PUBLIC share on [instructionId]. */
    private suspend fun hasEditAccess(customerId: String, instructionId: String): Boolean {
        val sharedUsers = sharedUsersResolver.getUsersWithSharedEntity(instructionId)
        val specificShare = sharedUsers.find { it.customerId == customerId }
        val publicShare = sharedUsers.find { it.customerId == "PUBLIC" }
        return specificShare?.role == ShareRole.EDIT || publicShare?.role == ShareRole.EDIT
    }

    suspend fun getCustomerInstructions(customerId: String): GetCustomerInstructionListResponse {
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
        val responseItems = allInstructions.sortedWith(
            compareBy<com.genflowly.models.Instruction> { it.id }.thenByDescending { it.version }
        ).map { instruction ->
            val role = if (instruction.creator == customerId) ShareRole.OWNER else roleMap[instruction.id] ?: ShareRole.VIEW
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

        val prompt = """
            Create a persona for these system instructions.
            You must return a valid JSON object with exactly these five keys: "name", "icon", "color", "category", and "tags". Do not include any other text or markdown formatting.

            1. "category": You MUST pick exactly one categoryName from the following JSON list of allowed categories. Do not invent a new category.
            $categoryJson

            2. "icon": You MUST use the exact 'baseIcon' for the category you picked, but you may append a secondary emoji to differentiate it (e.g. 💻🚀).

            3. "color": You MUST use the exact 'baseColor' for the category you picked.

            4. "name": A 2-3 word display name. Make names scannable. Put the distinguishing word first (e.g., "Security Risk Reviewer", not "Reviewer for Security Risks"). Use the naming formula: Domain + Role (e.g., "Python Debugging Coach").

            5. "tags": An array of 3-5 string metadata tags to support searching/filtering in large collections. Include tags for domain, task, tone, or tool (e.g., ["coding", "python", "debugging", "helpful"]).
        """.trimIndent()

        // Persona generation runs on the SYSTEM API keys (admin-configured
        // vendor/model pairs), trying providers in priority order. A JSON
        // parse failure also counts as a generation failure and moves on to
        // the next provider.
        return systemAIFailoverService.executeWithFailover("persona-generation") { config ->
            val responseText = utilityGenerationService.generateTextWithApiKey(
                config.aiVendor,
                config.model,
                listOf(
                    Message(
                        conversationId = "instruction-creation",
                        text = instructionText,
                        client = "internal",
                        role = "user",
                        customerId = customerId,
                        systemPrompt = "",
                        aiConfig = listOf(AIConfig(config.aiVendor, config.model)),
                        previousMessageId = null
                    )
                ),
                prompt,
                config.apiKey
            ).text

            val jsonString = responseText.substringAfter("{").substringBeforeLast("}")
            jsonParser.decodeFromString<GeneratedPersona>("{$jsonString}")
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
    }
}
