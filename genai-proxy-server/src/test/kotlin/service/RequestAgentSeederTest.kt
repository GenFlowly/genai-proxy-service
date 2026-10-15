package com.genflowly.service

import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.CapturingSlot
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Bootstrap-only seeding of the System request agents. Pinned here:
 *
 *  * a request type with NO map row gets instruction + graph + entry published,
 *    with the seed's full generation config (model/max_tokens/thinking_level)
 *    on the node — the MEMORY_EXTRACTION defaults that un-hardcode the model
 *  * an EXISTING row — enabled OR disabled — is never touched (admin intent,
 *    e.g. the panel's "Disable", survives restarts)
 *  * the map entry is a conditional create; a lost race never overwrites
 *  * one type failing never blocks the others
 */
class RequestAgentSeederTest {

    private val graphService = mockk<GraphService>()
    private val instructionRepo = mockk<InstructionRepository>(relaxed = true)
    private val mapRepo = mockk<RequestAgentMapRepository>()
    private val resolution = mockk<AgentResolutionService>(relaxed = true)
    private val seeder = RequestAgentSeeder(RequestAgentSeeds(), graphService, instructionRepo, mapRepo, resolution)

    private fun agentResponse(graphId: String) = AgentResponse(
        graphId = graphId, name = "a", isDefault = false, entryPoint = "NOD1",
        maxIterations = 1, edges = "{}", nodes = emptyList(), isSystem = true,
    )

    private val existingEntry = RequestAgentMapEntry(
        scope = SYSTEM_SCOPE, requestType = "X", mapKey = "k", graphId = "GRP0"
    )

    @Test
    fun `seeds only the missing request types with the full node config`() = runTest {
        // Everything already mapped except MEMORY_EXTRACTION
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any()) } answers {
            if (secondArg<String>() == RequestType.MEMORY_EXTRACTION.name) null else existingEntry
        }
        val createReq: CapturingSlot<CreateGraphAgentRequest> = slot()
        coEvery { graphService.publishSystemAgent(capture(createReq)) } returns agentResponse("GRP-NEW")
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns true

        seeder.seedMissing()

        // Exactly one publish, for the missing type
        coVerify(exactly = 1) { graphService.publishSystemAgent(any()) }
        coVerify(exactly = 1) {
            mapRepo.putMapEntryIfAbsent(match {
                it.scope == SYSTEM_SCOPE &&
                        it.requestType == RequestType.MEMORY_EXTRACTION.name &&
                        it.graphId == "GRP-NEW" &&
                        it.enabled &&
                        it.updatedBy == RequestAgentSeeder.SEED_UPDATED_BY
            })
        }
        coVerify { resolution.invalidate(RequestType.MEMORY_EXTRACTION) }

        // The seeded node carries the manifest's generation config — the
        // extraction defaults that replace the old hardcoded ones.
        val node = createReq.captured.nodes.single()
        val config = Json.parseToJsonElement(node.config).jsonObject
        assertEquals("gpt-5", config["model_preference"]!!.jsonObject["model"]!!.jsonPrimitive.content)
        assertEquals("4000", config["max_tokens"]!!.jsonPrimitive.content)
        assertEquals("none", config["thinking_level"]!!.jsonPrimitive.content)
        assertEquals("json", config["output_format"]!!.jsonPrimitive.content)
        assertTrue(config["instruction_id"]!!.jsonPrimitive.content.startsWith("INS"))
        assertTrue(node.config.contains("{{existingMemories}}"))
    }

    @Test
    fun `a DISABLED existing row is respected - never re-seeded`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any()) } answers {
            if (secondArg<String>() == RequestType.NOTE_TITLE.name) existingEntry.copy(enabled = false)
            else existingEntry
        }

        seeder.seedMissing()

        coVerify(exactly = 0) { graphService.publishSystemAgent(any()) }
        coVerify(exactly = 0) { mapRepo.putMapEntryIfAbsent(any()) }
    }

    @Test
    fun `a lost conditional-create race does not invalidate or throw`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any()) } answers {
            if (secondArg<String>() == RequestType.CONVERSATION_TITLE.name) null else existingEntry
        }
        coEvery { graphService.publishSystemAgent(any()) } returns agentResponse("GRP-LOSER")
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns false

        seeder.seedMissing()

        coVerify(exactly = 0) { resolution.invalidate(any()) }
    }

    @Test
    fun `one type failing never blocks the others`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any()) } returns null
        coEvery { graphService.publishSystemAgent(any()) } throws IllegalStateException("ddb down") andThenAnswer {
            agentResponse("GRP-OK")
        }
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns true

        seeder.seedMissing()

        // First type blew up; the remaining three still published
        coVerify(exactly = RequestType.entries.size) { graphService.publishSystemAgent(any()) }
        coVerify(exactly = RequestType.entries.size - 1) { mapRepo.putMapEntryIfAbsent(any()) }
    }
}
