package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.AIVendor
import com.genflowly.models.AgentOutputFormat
import com.genflowly.models.Instruction
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
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
import kotlin.test.assertNull

/**
 * Request-agent resolution with ONE source of truth: the published DynamoDB
 * agent. Pinned here: the chain validation and preference lift for
 * single-GENERATION-node agents, graph-path resolution for multi-node agents,
 * the customer-override precedence, and — crucially — that an unmapped or
 * disabled or broken action THROWS RequestAgentUnresolvedException instead of
 * silently running on hidden bundled defaults (which no longer exist).
 */
class AgentResolutionServiceTest {

    private val mapRepo = mockk<RequestAgentMapRepository>()
    private val graphRepo = mockk<GraphRepository>()
    private val instructionRepo = mockk<InstructionRepository>()
    private val service = AgentResolutionService(mapRepo, graphRepo, instructionRepo)

    private fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    private val entry = RequestAgentMapEntry(
        scope = SYSTEM_SCOPE,
        requestType = RequestType.INSTRUCTION_PERSONA.name,
        mapKey = "CustomPersonaMap",
        graphId = "GRP1"
    )

    private fun graphItem(nodeIds: List<String> = listOf("NOD1")) = mapOf(
        DynamoDBConstants.CUSTOMER_ID_KEY to s(SYSTEM_SCOPE),
        DynamoDBConstants.GRAPH_ENTRY_POINT_KEY to s("NOD1"),
        DynamoDBConstants.GRAPH_NODE_IDS_KEY to AttributeValue.builder()
            .l(nodeIds.map { s(it) }).build()
    )

    private fun nodeItem(type: String = com.genflowly.GENERATION_NODE_TYPE, config: String) = mapOf(
        DynamoDBConstants.NODE_TYPE_KEY to s(type),
        DynamoDBConstants.NODE_CONFIG_KEY to s(config)
    )

    private val instruction = Instruction(
        id = "INS1", creator = "System", name = "Persona prompt",
        instructions = "Custom prompt with {{categoryJson}}", version = 3
    )

    @Test
    fun `resolves the full DDB chain and lifts the node's generation preferences`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, "INSTRUCTION_PERSONA") } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem()
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(
            config = """{"instruction_id":"INS1","input_template":"{{instructionText}}","output_format":"json","model_preference":{"vendor":"OPENAI","model":"gpt-5"},"max_tokens":4000,"thinking_level":"none"}"""
        )
        coEvery { instructionRepo.getLatestInstructionVersion("INS1") } returns 3
        coEvery { instructionRepo.getInstruction("INS1", 3) } returns instruction

        val agent = service.resolve(RequestType.INSTRUCTION_PERSONA)

        assertEquals("GRP1", agent.graphId)
        assertEquals("CustomPersonaMap", agent.mapKey)
        assertEquals(AgentOutputFormat.JSON, agent.outputFormat)
        assertEquals(AIVendor.OPENAI, agent.modelPreference?.aiVendor)
        assertEquals("gpt-5", agent.modelPreference?.model)
        assertEquals(4000, agent.maxTokens)
    }

    @Test
    fun `pinned instruction_version skips the latest-version lookup`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem()
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(
            config = """{"instruction_id":"INS1","instruction_version":2}"""
        )
        coEvery { instructionRepo.getInstruction("INS1", 2) } returns instruction.copy(version = 2)

        service.resolve(RequestType.INSTRUCTION_PERSONA)

        coVerify(exactly = 0) { instructionRepo.getLatestInstructionVersion(any()) }
    }

    @Test
    fun `multi-node agents resolve to the graph with no lifted preferences`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem(nodeIds = listOf("NOD1", "NOD2"))
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(config = "{}")

        val agent = service.resolve(RequestType.INSTRUCTION_PERSONA)

        assertEquals("GRP1", agent.graphId)
        assertNull(agent.modelPreference)
        assertNull(agent.maxTokens)
        // The single-node chain validation (instruction lookup) does not apply
        coVerify(exactly = 0) { instructionRepo.getInstruction(any(), any()) }
    }

    @Test
    fun `no mapping anywhere throws unresolved - there is no bundled fallback`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns null

        assertFailsWith<RequestAgentUnresolvedException> {
            service.resolve(RequestType.MEMORY_EXTRACTION)
        }
    }

    @Test
    fun `a disabled mapping is unresolved`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry.copy(enabled = false)

        assertFailsWith<RequestAgentUnresolvedException> {
            service.resolve(RequestType.INSTRUCTION_PERSONA)
        }
    }

    @Test
    fun `a broken chain (missing instruction) is unresolved, not a crash`() = runTest {
        coEvery { mapRepo.getMapEntry(any(), any()) } returns entry
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphItem()
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(
            config = """{"instruction_id":"INS-GONE"}"""
        )
        coEvery { instructionRepo.getLatestInstructionVersion("INS-GONE") } returns null

        assertFailsWith<RequestAgentUnresolvedException> {
            service.resolve(RequestType.INSTRUCTION_PERSONA)
        }
    }

    @Test
    fun `a customer override beats the SYSTEM mapping`() = runTest {
        val customerEntry = entry.copy(scope = "CU1", mapKey = "MyPersonaAgent", graphId = "GRP9")
        coEvery { mapRepo.getMapEntry("CU1", "INSTRUCTION_PERSONA") } returns customerEntry
        coEvery { graphRepo.getCustomerGraph("GRP9") } returns mapOf(
            DynamoDBConstants.CUSTOMER_ID_KEY to s("CU1"),
            DynamoDBConstants.GRAPH_ENTRY_POINT_KEY to s("NOD1"),
            DynamoDBConstants.GRAPH_NODE_IDS_KEY to AttributeValue.builder().l(listOf(s("NOD1"), s("NOD2"))).build()
        )
        coEvery { graphRepo.getCustomerGraphNode("NOD1") } returns nodeItem(config = "{}")

        val agent = service.resolve(RequestType.INSTRUCTION_PERSONA, customerId = "CU1")

        assertEquals("GRP9", agent.graphId)
        assertEquals("MyPersonaAgent", agent.mapKey)
        coVerify(exactly = 0) { mapRepo.getMapEntry(SYSTEM_SCOPE, any()) }
    }
}
