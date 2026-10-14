package com.genflowly.service

import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.GENERATION_NODE_TYPE
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.Instruction
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.NewAgentNode
import com.genflowly.models.generateInstructionId
import com.genflowly.observability.Metrics
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Bootstrap-only publisher of the System request agents.
 *
 * At startup, every [RequestType] with NO RequestAgentMap row at all gets its
 * seed published as first-class, admin-editable data: a System-owned
 * instruction (the system prompt), a System-owned single-GENERATION-node
 * graph (input template + output format + model preference + max_tokens +
 * thinking_level), and the SYSTEM map entry — through the same code paths the
 * admin panel uses, so the result is indistinguishable from a hand-published
 * agent.
 *
 * One source of truth after that: a row that EXISTS — enabled or disabled —
 * is never touched, so an admin disabling an action (the panel's "Disable")
 * or remapping it can never be overridden by a restart. There is no runtime
 * fallback to the bundled config anymore; an unresolvable action fails loudly
 * (see [RequestAgentUnresolvedException]).
 *
 * Multi-instance safe: the map entry is written with a conditional create; a
 * raced loser logs and abandons its just-created assets (orphaned System
 * graph/instruction — harmless, logged with ids for cleanup).
 */
class RequestAgentSeeder(
    private val seeds: RequestAgentSeeds,
    private val graphService: GraphService,
    private val instructionRepository: InstructionRepository,
    private val requestAgentMapRepository: RequestAgentMapRepository,
    private val agentResolutionService: AgentResolutionService,
) {

    /** Publish seeds for request types with no map row; never updates existing rows. */
    suspend fun seedMissing() {
        for (requestType in RequestType.entries) {
            try {
                seedOne(requestType)
            } catch (e: Exception) {
                // A single type's failure must not take down startup or the
                // other types; the action stays unresolved (loud) until the
                // next restart retries or an admin publishes by hand.
                Metrics.count("request_agent_seed_total", 1.0, "status" to "error", "requestType" to requestType.name)
                logger.error(e) { "Seeding $requestType failed — action unresolved until retried/published" }
            }
        }
    }

    private suspend fun seedOne(requestType: RequestType) {
        val seed = seeds.seeds.getValue(requestType)
        if (requestAgentMapRepository.getMapEntry(SYSTEM_SCOPE, requestType.name) != null) {
            // Enabled or disabled — the row records an admin's intent; keep it.
            return
        }

        val instructionId = generateInstructionId()
        instructionRepository.saveInstruction(
            Instruction(
                id = instructionId,
                creator = SYSTEM_GRAPH_OWNER,
                name = "${requestType.displayName} Prompt",
                instructions = seed.systemPrompt,
                version = 1,
            )
        )

        val nodeConfig = buildJsonObject {
            put("instruction_id", instructionId)
            put("input_template", seed.userMessageTemplate)
            put("output_format", seed.outputFormat.name.lowercase())
            seed.modelPreference?.let { pref ->
                putJsonObject("model_preference") {
                    put("vendor", pref.aiVendor.name)
                    put("model", pref.model)
                }
            }
            seed.maxTokens?.let { put("max_tokens", it) }
            seed.thinkingLevel?.let { put("thinking_level", it) }
        }

        // Same shape the admin panel publishes (cf. the live
        // ConversationTitleDefaultAgent): one GENERATION node straight to end.
        val agent = graphService.publishSystemAgent(
            CreateGraphAgentRequest(
                name = "${seed.mapKey}Agent",
                maxIterations = 1,
                entryPoint = "gen",
                edges = """{"edges":[{"from":"gen","to":"__end__"}]}""",
                nodes = listOf(
                    NewAgentNode(
                        tempId = "gen",
                        nodeType = GENERATION_NODE_TYPE,
                        name = requestType.displayName,
                        config = nodeConfig.toString(),
                    )
                ),
            )
        )

        val created = requestAgentMapRepository.putMapEntryIfAbsent(
            RequestAgentMapEntry(
                scope = SYSTEM_SCOPE,
                requestType = requestType.name,
                mapKey = seed.mapKey,
                graphId = agent.graphId,
                enabled = true,
                updatedBy = SEED_UPDATED_BY,
            )
        )
        if (created) {
            agentResolutionService.invalidate(requestType)
            Metrics.count("request_agent_seed_total", 1.0, "status" to "seeded", "requestType" to requestType.name)
            logger.info {
                "Seeded $requestType → graph ${agent.graphId} (instruction $instructionId, '${seed.mapKey}')"
            }
        } else {
            // Another instance won the race; our assets are orphans.
            Metrics.count("request_agent_seed_total", 1.0, "status" to "lost_race", "requestType" to requestType.name)
            logger.warn {
                "Seeding $requestType lost a race — orphaned graph ${agent.graphId} / instruction $instructionId"
            }
        }
    }

    companion object {
        const val SEED_UPDATED_BY = "system-bootstrap"
    }
}
