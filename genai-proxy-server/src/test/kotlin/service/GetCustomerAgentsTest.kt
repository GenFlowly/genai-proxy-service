package com.genflowly.service

import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GetCustomerAgentsTest {

    private val graphRepo = mockk<GraphRepository>(relaxed = true)
    private val instructionRepo = mockk<InstructionRepository>(relaxed = true)
    private val requestAgentMapRepo = mockk<RequestAgentMapRepository>(relaxed = true)
    private val service = GraphService(graphRepo, instructionRepo, requestAgentMapRepo)

    private fun graphItem(graphId: String, isDefault: Boolean, name: String = graphId): Map<String, AttributeValue> =
        mapOf(
            "graphId" to AttributeValue.builder().s(graphId).build(),
            "name" to AttributeValue.builder().s(name).build(),
            "isDefault" to AttributeValue.builder().bool(isDefault).build(),
            "entryPoint" to AttributeValue.builder().s("N1").build(),
            "edges" to AttributeValue.builder().s("{}").build(),
            "nodeIds" to AttributeValue.builder().l(emptyList()).build(),
        )

    private fun mapEntry(graphId: String, requestType: String, scope: String = SYSTEM_SCOPE) =
        RequestAgentMapEntry(scope = scope, requestType = requestType, mapKey = "k", graphId = graphId)

    @Test
    fun `System default is listed even when the customer has an own default`() = runTest {
        coEvery { graphRepo.listCustomerGraphs("CU1") } returns listOf(graphItem("GRP-OWN", isDefault = true))
        coEvery { graphRepo.listCustomerGraphs(SYSTEM_GRAPH_OWNER) } returns listOf(graphItem("GRP-SYS", isDefault = true))
        coEvery { graphRepo.listCustomerGraphNodes(any()) } returns emptyList()
        coEvery { requestAgentMapRepo.listMapEntries(any()) } returns emptyList()

        val agents = service.getCustomerAgents("CU1").agents

        assertEquals(listOf("GRP-SYS", "GRP-OWN"), agents.map { it.graphId })
        assertTrue(agents.first { it.graphId == "GRP-SYS" }.isSystem)
        assertTrue(!agents.first { it.graphId == "GRP-OWN" }.isSystem)
    }

    @Test
    fun `request agents are tagged with their request type`() = runTest {
        coEvery { graphRepo.listCustomerGraphs("CU1") } returns listOf(graphItem("GRP-FORKED-TITLE", isDefault = false))
        coEvery { graphRepo.listCustomerGraphs(SYSTEM_GRAPH_OWNER) } returns listOf(
            graphItem("GRP-SYS", isDefault = true),
            graphItem("GRP-TITLE", isDefault = false),
        )
        coEvery { graphRepo.listCustomerGraphNodes(any()) } returns emptyList()
        coEvery { requestAgentMapRepo.listMapEntries(SYSTEM_SCOPE) } returns listOf(
            mapEntry("GRP-TITLE", "CONVERSATION_TITLE"),
        )
        coEvery { requestAgentMapRepo.listMapEntries("CU1") } returns listOf(
            mapEntry("GRP-FORKED-TITLE", "NOTE_TITLE", scope = "CU1"),
        )

        val agents = service.getCustomerAgents("CU1").agents

        assertEquals("CONVERSATION_TITLE", agents.first { it.graphId == "GRP-TITLE" }.requestType)
        assertEquals("NOTE_TITLE", agents.first { it.graphId == "GRP-FORKED-TITLE" }.requestType)
        assertNull(agents.first { it.graphId == "GRP-SYS" }.requestType)
    }
}
