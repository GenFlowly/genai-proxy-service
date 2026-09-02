package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.Instruction
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.models.ResolvedAgentSource
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class AgentResolutionServiceTest {

    private val mapRepo = mockk<RequestAgentMapRepository>()
    private val graphRepo = mockk<GraphRepository>()
    private val instructionRepo = mockk<InstructionRepository>()
    private val service = AgentResolutionService(
        mapRepo, graphRepo, instructionRepo, RequestAgentDefaultsLoader()
    )

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    private val entry = RequestAgentMapEntry(
        scope = SYSTEM_SCOPE,
        requestType = RequestType.INSTRUCTION_PERSONA.name,
        mapKey = "CustomPersonaMap",
        graphId = "GRP1"
    )

    private val graphItem = mapOf(
        DynamoDBConstants.CUSTOMER_ID_KEY to s(SYSTEM_SCOPE),
        DynamoDBConstants.GRAPH_ENTRY_POINT_KEY to s("NOD1")
    )

    private fun nodeItem(type: String = com.genflowly.GENERATION_NODE_TYPE, config: String) = mapOf(
        DynamoDBConstants.NODE_TYPE_KEY to s(type),
        DynamoDBConstants.NODE_CONFIG_KEY to s(config)
    )

    private val instruction = Instruction(
        id = "INS1", creator = "SystemAgent", name = "Persona prompt",
        instructions = "Custom prompt with {{categoryJson}}", version = 3
    )

    @Test
    fun `resolves the full DDB chain when a usable map entry exists`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, "INSTRUCTION_PERSONA") } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(
            config = """{"instruction_id":"INS1","input_template":"{{instructionText}}","output_format":"json","model_preference":{"vendor":"OPENAI","model":"gpt-5"}}"""
        )
        coEvery { instructionRepo.getLatestInstructionVersion("INS1") } returns 3
        coEvery { instructionRepo.getInstruction("INS1", 3) } returns instruction

        val agent = service.resolve(RequestType.INSTRUCTION_PERSONA)

        assertEquals(ResolvedAgentSource.DDB, agent.source)
        assertEquals("CustomPersonaMap", agent.mapKey)
        assertEquals("Custom prompt with {{categoryJson}}", agent.systemPromptTemplate)
        assertEquals(AgentOutputFormat.JSON, agent.outputFormat)
        assertEquals(AIVendor.OPENAI, agent.modelPreference?.aiVendor)
    }

    @Test
    fun `pinned instruction_version skips the latest-version lookup`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(
            config = """{"instruction_id":"INS1","instruction_version":2}"""
        )
        coEvery { instructionRepo.getInstruction("INS1", 2) } returns instruction.copy(version = 2)

        val agent = service.resolve(RequestType.INSTRUCTION_PERSONA)

        assertEquals(ResolvedAgentSource.DDB, agent.source)
        coVerify(exactly = 0) { instructionRepo.getLatestInstructionVersion(any()) }
    }

    @Test
    fun `falls back to bundled default when there is no map entry, with negative caching`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns null

        val first = service.resolve(RequestType.CONVERSATION_TITLE)
        val second = service.resolve(RequestType.CONVERSATION_TITLE)

        assertEquals(ResolvedAgentSource.CONFIG, first.source)
        assertEquals("ConversationTitleDefault", second.mapKey)
        // Second resolve served from the (negative) cache
        coVerify(exactly = 1) { mapRepo.getMapEntry(SYSTEM_SCOPE, "CONVERSATION_TITLE") }
    }

    @Test
    fun `disabled entry and missing graph fall back`() = runTest {
        // disabled
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry.copy(enabled = false)
        assertEquals(ResolvedAgentSource.CONFIG, service.resolve(RequestType.INSTRUCTION_PERSONA).source)
        service.invalidate()

        // graph missing
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns null
        assertEquals(ResolvedAgentSource.CONFIG, service.resolve(RequestType.INSTRUCTION_PERSONA).source)
    }

    @Test
    fun `non-GENERATION entry node resolves to graph execution instead of falling back`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns
                nodeItem(type = "RESPONSE_GENERATOR", config = "{}")

        val resolved = service.resolve(RequestType.INSTRUCTION_PERSONA)
        assertEquals(ResolvedAgentSource.DDB, resolved.source)
        assertTrue(resolved.executeAsGraph)
        assertEquals("GRP1", resolved.graphId)
    }

    @Test
    fun `invalidate drops the cached resolution`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns null
        service.resolve(RequestType.NOTE_TITLE)
        service.invalidate(RequestType.NOTE_TITLE)
        service.resolve(RequestType.NOTE_TITLE)

        coVerify(exactly = 2) { mapRepo.getMapEntry(SYSTEM_SCOPE, "NOTE_TITLE") }
    }

    @Test
    fun `transient repository error falls back without caching`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } throws RuntimeException("ddb down") andThen null

        assertEquals(ResolvedAgentSource.CONFIG, service.resolve(RequestType.NOTE_TITLE).source)
        service.resolve(RequestType.NOTE_TITLE)
        // Error was not cached: the second resolve queried DDB again
        coVerify(exactly = 2) { mapRepo.getMapEntry(SYSTEM_SCOPE, "NOTE_TITLE") }
    }

    @Test
    fun `buildAgentFromGraph names the broken link for admin validation`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP-missing") } returns null

        val e = assertFailsWith<IllegalArgumentException> {
            service.buildAgentFromGraph("GRP-missing", RequestType.NOTE_TITLE, "k")
        }
        assertTrue(e.message!!.contains("not found"))
    }
}
