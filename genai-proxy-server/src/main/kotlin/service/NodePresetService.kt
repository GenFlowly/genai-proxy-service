package com.genflowly.service

import com.genflowly.models.api.GetNodePresetsResponse
import com.genflowly.models.api.NodePreset
import com.genflowly.models.api.UpsertNodePresetRequest
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.NodePresetRepository
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * The admin-curated "pre-made nodes" of the graph editor palette. Reads are
 * customer-facing (both apps build their palettes from them); writes are
 * admin-only. Presets are data, primitives are code: a preset never defines
 * behavior, only a ready-made config on top of a runtime node type.
 */
class NodePresetService(
    private val nodePresetRepository: NodePresetRepository,
    private val instructionRepository: InstructionRepository,
) {

    private val jsonParser = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

    suspend fun listPresets(): GetNodePresetsResponse =
        GetNodePresetsResponse(
            presets = nodePresetRepository.listPresets()
                .sortedWith(compareBy({ it.sortOrder }, { it.name }))
        )

    suspend fun createPreset(req: UpsertNodePresetRequest): NodePreset {
        validate(req)
        val preset = NodePreset(
            presetId = com.genflowly.models.generatePresetId(),
            name = req.name.trim(),
            nodeType = req.nodeType.trim(),
            description = req.description.trim(),
            config = req.config,
            requiredAttributes = req.requiredAttributes.filter { it.isNotBlank() },
            sortOrder = req.sortOrder,
        )
        nodePresetRepository.putPreset(preset)
        return preset
    }

    /** @throws IllegalStateException when the preset does not exist (→ 404). */
    suspend fun updatePreset(presetId: String, req: UpsertNodePresetRequest): NodePreset {
        val existing = nodePresetRepository.getPreset(presetId)
            ?: throw IllegalStateException("Node preset '$presetId' not found.")
        validate(req)
        val updated = existing.copy(
            name = req.name.trim(),
            nodeType = req.nodeType.trim(),
            description = req.description.trim(),
            config = req.config,
            requiredAttributes = req.requiredAttributes.filter { it.isNotBlank() },
            sortOrder = req.sortOrder,
        )
        nodePresetRepository.putPreset(updated)
        return updated
    }

    /** @throws IllegalStateException when the preset does not exist (→ 404). */
    suspend fun deletePreset(presetId: String) {
        nodePresetRepository.getPreset(presetId)
            ?: throw IllegalStateException("Node preset '$presetId' not found.")
        nodePresetRepository.deletePreset(presetId)
    }

    private suspend fun validate(req: UpsertNodePresetRequest) {
        require(req.name.isNotBlank()) { "Preset name must not be blank." }
        require(req.nodeType.isNotBlank()) { "Preset nodeType must not be blank." }
        val obj = try {
            jsonParser.parseToJsonElement(req.config).jsonObject
        } catch (e: Exception) {
            throw IllegalArgumentException("Preset config is not valid JSON: ${e.message}")
        }
        // Presets composing with the centralized-prompt system must reference
        // a real instruction — a broken ref would silently fall back at runtime.
        val instructionId = (obj["instruction_id"] as? JsonPrimitive)?.contentOrNull
        if (instructionId != null) {
            val pinned = (obj["instruction_version"] as? JsonPrimitive)?.intOrNull
            val version = pinned
                ?: instructionRepository.getLatestInstructionVersion(instructionId)
                ?: throw IllegalArgumentException("Instruction $instructionId not found.")
            requireNotNull(instructionRepository.getInstruction(instructionId, version)) {
                "Instruction $instructionId v$version not found."
            }
        }
        logger.debug { "Validated preset '${req.name}' (${req.nodeType})" }
    }
}
