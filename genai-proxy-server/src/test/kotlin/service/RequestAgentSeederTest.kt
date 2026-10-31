package com.genflowly.service

import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.repository.GraphRepository
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
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * Bootstrap-only seeding of the System request agents. Pinned here:
 *
 *  * a request type with NO map row gets instruction + graph + entry published,
 *    with the seed's full generation config (model/max_tokens/thinking_level)
 *    on the node — the MEMORY_EXTRACTION defaults that un-hardcode the model
 *  * an EXISTING row — enabled OR disabled — is never touched (admin intent,
 *    e.g. the panel's "Disable", survives restarts)
 *  * every seeded id is DETERMINISTIC (derived from the mapKey), so racing
 *    instances converge on one graph instead of each publishing an orphan —
 *    the root cause of the duplicate System agents in prod
 *  * seeds sharing a mapKey (both title types → TitleCreatorDefault) share
 *    ONE graph with a map row per request type
 *  * the map entry is a conditional create; a lost race never overwrites
 *  * one type failing never blocks the others
 */
class RequestAgentSeederTest {

    private val graphService = mockk<GraphService>()
    private val graphRepo = mockk<GraphRepository>()
    private val instructionRepo = mockk<InstructionRepository>(relaxed = true)
    private val mapRepo = mockk<RequestAgentMapRepository>()
    private val resolution = mockk<AgentResolutionService>(relaxed = true)
    private val seeder =
        RequestAgentSeeder(RequestAgentSeeds(), graphService, graphRepo, instructionRepo, mapRepo, resolution, mockk<CacheVersionService>(relaxed = true))

    private fun agentResponse(graphId: String) = AgentResponse(
        graphId = graphId, name = "a", isDefault = false, entryPoint = "NOD1",
        maxIterations = 1, edges = "{}", nodes = emptyList(), isSystem = true,
    )

    private val existingEntry = RequestAgentMapEntry(
        scope = SYSTEM_SCOPE, requestType = "X", mapKey = "k", graphId = "GRP0"
    )

    /** Live-row shape is irrelevant to the seeder — it only checks existence. */
    private val someGraphItem = mapOf("graphId" to AttributeValue.builder().s("GRP-ANY").build())

    @Test
    fun `seeds only the missing request types with the full node config`() = runTest {
        // Everything already mapped except MEMORY_EXTRACTION
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any(), any()) } answers {
            if (secondArg<String>() == RequestType.MEMORY_EXTRACTION.name) null else existingEntry
        }
        coEvery { graphRepo.getCustomerGraph(any()) } returns null
        coEvery { instructionRepo.getLatestInstructionVersion(any()) } returns null
        val createReq: CapturingSlot<CreateGraphAgentRequest> = slot()
        val seededGraphId: CapturingSlot<String> = slot()
        coEvery {
            graphService.publishSeededSystemAgent(capture(createReq), capture(seededGraphId), any())
        } answers { agentResponse(secondArg()) }
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns true

        seeder.seedMissing()

        // Exactly one publish, for the missing type, at its deterministic id
        val expectedGraphId = RequestAgentSeeder.seededId("GRP", "graph", "MemoryExtractionDefault")
        coVerify(exactly = 1) { graphService.publishSeededSystemAgent(any(), any(), any()) }
        assertEquals(expectedGraphId, seededGraphId.captured)
        coVerify(exactly = 1) {
            mapRepo.putMapEntryIfAbsent(match {
                it.scope == SYSTEM_SCOPE &&
                        it.requestType == RequestType.MEMORY_EXTRACTION.name &&
                        it.graphId == expectedGraphId &&
                        it.enabled &&
                        it.updatedBy == RequestAgentSeeder.SEED_UPDATED_BY
            })
        }
        coVerify { resolution.invalidate(RequestType.MEMORY_EXTRACTION) }

        // The seeded node carries the manifest's generation config — the
        // extraction defaults that replace the old hardcoded ones.
        assertEquals("MEMORY", createReq.captured.category)
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
    fun `a DISABLED existing row is respected — never re-seeded`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any(), any()) } answers {
            if (secondArg<String>() == RequestType.NOTE_TITLE.name) existingEntry.copy(enabled = false)
            else existingEntry
        }

        seeder.seedMissing()

        coVerify(exactly = 0) { graphService.publishSeededSystemAgent(any(), any(), any()) }
        coVerify(exactly = 0) { mapRepo.putMapEntryIfAbsent(any()) }
    }

    @Test
    fun `seeded ids are deterministic — same mapKey always yields the same ids`() {
        assertEquals(
            RequestAgentSeeder.seededId("GRP", "graph", "TitleCreatorDefault"),
            RequestAgentSeeder.seededId("GRP", "graph", "TitleCreatorDefault"),
        )
        assertNotEquals(
            RequestAgentSeeder.seededId("GRP", "graph", "TitleCreatorDefault"),
            RequestAgentSeeder.seededId("GRP", "graph", "MemoryExtractionDefault"),
        )
        // Domain id shape: prefix + 12 uppercase hex
        val id = RequestAgentSeeder.seededId("GRP", "graph", "TitleCreatorDefault")
        assertTrue(Regex("^GRP[0-9A-F]{12}$").matches(id))
    }

    @Test
    fun `both title types converge on ONE shared TitleCreatorDefault graph with a map row each`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any(), any()) } answers {
            val type = secondArg<String>()
            if (type == RequestType.CONVERSATION_TITLE.name || type == RequestType.NOTE_TITLE.name) null
            else existingEntry
        }
        // Stateful graph existence: once published, subsequent checks find it.
        val publishedGraphIds = mutableSetOf<String>()
        coEvery { graphRepo.getCustomerGraph(any()) } answers {
            if (firstArg<String>() in publishedGraphIds) someGraphItem else null
        }
        coEvery { instructionRepo.getLatestInstructionVersion(any()) } returns null
        coEvery { graphService.publishSeededSystemAgent(any(), any(), any()) } answers {
            publishedGraphIds.add(secondArg())
            agentResponse(secondArg())
        }
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns true

        seeder.seedMissing()

        val sharedGraphId = RequestAgentSeeder.seededId("GRP", "graph", "TitleCreatorDefault")
        // ONE graph published...
        coVerify(exactly = 1) { graphService.publishSeededSystemAgent(any(), any(), any()) }
        assertEquals(setOf(sharedGraphId), publishedGraphIds)
        // ...but BOTH title types got their own map row pointing at it.
        coVerify(exactly = 1) {
            mapRepo.putMapEntryIfAbsent(match {
                it.requestType == RequestType.CONVERSATION_TITLE.name && it.graphId == sharedGraphId
            })
        }
        coVerify(exactly = 1) {
            mapRepo.putMapEntryIfAbsent(match {
                it.requestType == RequestType.NOTE_TITLE.name && it.graphId == sharedGraphId
            })
        }
    }

    @Test
    fun `a racer that finds the graph already created publishes nothing — no orphans possible`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any(), any()) } answers {
            if (secondArg<String>() == RequestType.CONVERSATION_TITLE.name) null else existingEntry
        }
        // Another instance already created the deterministic graph...
        coEvery { graphRepo.getCustomerGraph(any()) } returns someGraphItem
        // ...and wins the map row too.
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns false

        seeder.seedMissing()

        // The loser creates NOTHING: no graph, no instruction, no invalidate.
        coVerify(exactly = 0) { graphService.publishSeededSystemAgent(any(), any(), any()) }
        coVerify(exactly = 0) { instructionRepo.saveInstruction(any()) }
        coVerify(exactly = 0) { resolution.invalidate(any()) }
    }

    @Test
    fun `one type failing never blocks the others`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, any(), any()) } returns null
        coEvery { graphRepo.getCustomerGraph(any()) } returns null
        coEvery { instructionRepo.getLatestInstructionVersion(any()) } returns null
        coEvery {
            graphService.publishSeededSystemAgent(any(), any(), any())
        } throws IllegalStateException("ddb down") andThenAnswer { agentResponse(secondArg()) }
        coEvery { mapRepo.putMapEntryIfAbsent(any()) } returns true

        seeder.seedMissing()

        // First type blew up; the remaining three still seeded their map rows.
        coVerify(exactly = 3) { mapRepo.putMapEntryIfAbsent(any()) }
    }
}
