package com.genflowly.service

import com.genflowly.GENERATION_NODE_TYPE
import com.genflowly.models.AIConfig
import com.genflowly.models.AIVendor
import com.genflowly.models.Instruction
import com.genflowly.models.api.CreateAgentRequest
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CreateGenerationAgentTest {

    private val graphRepo = mockk<GraphRepository>(relaxed = true)
    private val instructionRepo = mockk<InstructionRepository>()
    private val requestAgentMapRepo = mockk<com.genflowly.repository.RequestAgentMapRepository>(relaxed = true)
    private val cacheVersions = mockk<CacheVersionService>(relaxed = true)
    private val service = GraphService(graphRepo, instructionRepo, requestAgentMapRepo, cacheVersions)

    private val instruction = Instruction(
        id = "INS1", creator = "CU1", name = "Prompt", instructions = "Do {{x}}", version = 2
    )

    @Test
    fun `creates a 1-node GENERATION graph owned by the caller`() = runTest {
        coEvery { instructionRepo.getLatestInstructionVersion("INS1") } returns 2
        coEvery { instructionRepo.getInstruction("INS1", 2) } returns instruction

        val configSlot = slot<String>()
        coEvery {
            graphRepo.createCustomerGraphNode("CU1", any(), GENERATION_NODE_TYPE, "My Agent", capture(configSlot))
        } returns Unit

        val response = service.createGenerationAgent(
            "CU1",
            CreateAgentRequest(
                name = "My Agent",
                instructionId = "INS1",
                outputFormat = "json",
                modelPreference = AIConfig(AIVendor.OPENAI, "gpt-5"),
                inputTemplate = "{{x}}"
            )
        )

        assertTrue(configSlot.captured.contains("\"instruction_id\":\"INS1\""))
        assertTrue(configSlot.captured.contains("\"output_format\":\"json\""))
        assertTrue(configSlot.captured.contains("\"vendor\":\"OPENAI\""))
        assertEquals(1, response.maxIterations)
        assertEquals(response.entryPoint, response.nodes.single().nodeId)
        assertEquals(GENERATION_NODE_TYPE, response.nodes.single().nodeType)
        coVerify {
            graphRepo.createCustomerGraph(
                customerId = "CU1",
                graphId = response.graphId,
                name = "My Agent",
                isDefault = false,
                nodeIds = listOf(response.entryPoint),
                edges = response.edges,
                entryPoint = response.entryPoint,
                maxIterations = 1,
                category = "CONVERSATION",
            )
        }
    }

    @Test
    fun `deleteAgent removes the graph and its nodes`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns mapOf(
            "customerId" to av("CU1"),
            com.genflowly.DynamoDBConstants.GRAPH_IS_DEFAULT_KEY to
                software.amazon.awssdk.services.dynamodb.model.AttributeValue.builder().bool(false).build(),
            com.genflowly.DynamoDBConstants.GRAPH_NODE_IDS_KEY to
                software.amazon.awssdk.services.dynamodb.model.AttributeValue.builder()
                    .l(av("NOD1"), av("NOD2")).build(),
        )

        service.deleteAgent("CU1", "GRP1")

        coVerify { graphRepo.deleteCustomerGraphNode("NOD1") }
        coVerify { graphRepo.deleteCustomerGraphNode("NOD2") }
        coVerify { graphRepo.deleteCustomerGraph("GRP1") }
    }

    @Test
    fun `deleteAgent allows deleting an owned default graph and hides foreign graphs`() = runTest {
        // Deleting an owned default graph is a "reset to System default" now
        // that resolution falls back to the System-published graph.
        coEvery { graphRepo.getCustomerGraph("GRP-default") } returns mapOf(
            "customerId" to av("CU1"),
            com.genflowly.DynamoDBConstants.GRAPH_IS_DEFAULT_KEY to
                software.amazon.awssdk.services.dynamodb.model.AttributeValue.builder().bool(true).build(),
        )
        service.deleteAgent("CU1", "GRP-default")
        coVerify { graphRepo.deleteCustomerGraph("GRP-default") }

        coEvery { graphRepo.getCustomerGraph("GRP-foreign") } returns mapOf("customerId" to av("CU-other"))
        assertFailsWith<IllegalStateException> { service.deleteAgent("CU1", "GRP-foreign") }
        coVerify(exactly = 0) { graphRepo.deleteCustomerGraph("GRP-foreign") }
    }

    private fun av(v: String) =
        software.amazon.awssdk.services.dynamodb.model.AttributeValue.builder().s(v).build()

    @Test
    fun `rejects unknown instruction and blank name`() = runTest {
        coEvery { instructionRepo.getLatestInstructionVersion("INS-missing") } returns null

        assertFailsWith<IllegalArgumentException> {
            service.createGenerationAgent("CU1", CreateAgentRequest(name = "A", instructionId = "INS-missing"))
        }
        assertFailsWith<IllegalArgumentException> {
            service.createGenerationAgent("CU1", CreateAgentRequest(name = " ", instructionId = "INS1"))
        }
    }
}
