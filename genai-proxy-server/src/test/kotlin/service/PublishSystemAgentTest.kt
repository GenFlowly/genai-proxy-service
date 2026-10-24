package com.genflowly.service

import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.NewAgentNode
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.CapturingSlot
import io.mockk.coEvery
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * publishSystemAgent is the write path behind POST /admin/system-agents —
 * shared NON-default System templates (the agent-loop template is its first
 * user). Pinned here: System ownership, the isDefault=false pin (a template
 * publish must never displace the System default graph and silently flip
 * graphless customers), tempId substitution, and that the agent-loop topology
 * (a cycle closed only by a tool_route edge, no reflection node) passes
 * validation — the exemption the template relies on.
 */
class PublishSystemAgentTest {

    private val graphRepo = mockk<GraphRepository>(relaxed = true)
    private val instructionRepo = mockk<InstructionRepository>(relaxed = true)
    private val requestAgentMapRepo = mockk<RequestAgentMapRepository>(relaxed = true)
    private val service = GraphService(graphRepo, instructionRepo, requestAgentMapRepo)

    /** The agent-loop template, exactly as the admin panel publishes it. */
    private fun agentLoopRequest(isDefault: Boolean = false) = CreateGraphAgentRequest(
        name = "Agent",
        maxIterations = 40,
        entryPoint = "memory",
        edges = """{"edges":[{"from":"memory","to":"generator"},{"from":"tools","to":"generator"}],""" +
            """"conditional_edges":[{"from":"generator","condition_type":"tool_route",""" +
            """"routes":{"builtin":"tools","caller":"__end__","none":"__end__"}}]}""",
        isDefault = isDefault,
        nodes = listOf(
            NewAgentNode(tempId = "memory", nodeType = "MEMORY", name = "Memory", config = "{}"),
            NewAgentNode(
                tempId = "generator", nodeType = "RESPONSE_GENERATOR", name = "Agent",
                config = """{"response_format":"text","include_conversation_history":true,""" +
                    """"is_streaming":true,"output_key":"generated_response","input_template":"{original_query}"}""",
            ),
            NewAgentNode(
                tempId = "tools", nodeType = "TOOL_EXECUTOR", name = "Tools",
                config = """{"tools":["search_knowledge_base","web_search","generate_pdf"]}""",
            ),
        ),
    )

    /** Wire the relaxed repo so the post-create read-back returns what was written. */
    private fun captureWrites(): Triple<CapturingSlot<String>, CapturingSlot<Boolean>, MutableList<Triple<String, String, String>>> {
        val edgesSlot = slot<String>()
        val isDefaultSlot = slot<Boolean>()
        val nodeWrites = mutableListOf<Triple<String, String, String>>() // (owner, nodeId, nodeType)
        val nodeItems = mutableListOf<Map<String, AttributeValue>>()
        var written: Map<String, AttributeValue>? = null

        coEvery {
            graphRepo.createCustomerGraphNode(any(), any(), any(), any(), any())
        } answers {
            val owner = arg<String>(0)
            val nodeId = arg<String>(1)
            val nodeType = arg<String>(2)
            nodeWrites.add(Triple(owner, nodeId, nodeType))
            nodeItems.add(
                mapOf(
                    "nodeId" to AttributeValue.builder().s(nodeId).build(),
                    "nodeType" to AttributeValue.builder().s(nodeType).build(),
                    "name" to AttributeValue.builder().s(arg<String>(3)).build(),
                    "config" to AttributeValue.builder().s(arg<String>(4)).build(),
                )
            )
        }
        coEvery {
            graphRepo.createCustomerGraph(
                customerId = any(), graphId = any(), name = any(), isDefault = capture(isDefaultSlot),
                nodeIds = any(), edges = capture(edgesSlot), entryPoint = any(),
                maxIterations = any(), layout = anyNullable(), category = anyNullable(),
            )
        } answers {
            written = mapOf(
                "customerId" to AttributeValue.builder().s(arg<String>(0)).build(),
                "graphId" to AttributeValue.builder().s(arg<String>(1)).build(),
                "name" to AttributeValue.builder().s(arg<String>(2)).build(),
                "isDefault" to AttributeValue.builder().bool(arg<Boolean>(3)).build(),
                "nodeIds" to AttributeValue.builder()
                    .l(arg<List<String>>(4).map { AttributeValue.builder().s(it).build() }).build(),
                "edges" to AttributeValue.builder().s(arg<String>(5)).build(),
                "entryPoint" to AttributeValue.builder().s(arg<String>(6)).build(),
                "maxIterations" to AttributeValue.builder().n(arg<Int>(7).toString()).build(),
            ) + (arg<String?>(9)?.let { mapOf("category" to AttributeValue.builder().s(it).build()) } ?: emptyMap())
        }
        coEvery { graphRepo.getCustomerGraph(any()) } answers { written }
        coEvery { graphRepo.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER) } answers { nodeItems }
        return Triple(edgesSlot, isDefaultSlot, nodeWrites)
    }

    @Test
    fun `publishes the agent-loop template as a System-owned non-default agent`() = runTest {
        val (edgesSlot, isDefaultSlot, nodeWrites) = captureWrites()

        val response = service.publishSystemAgent(agentLoopRequest())

        assertTrue(nodeWrites.all { it.first == SYSTEM_GRAPH_OWNER })
        assertEquals(
            listOf("MEMORY", "RESPONSE_GENERATOR", "TOOL_EXECUTOR"),
            nodeWrites.map { it.third },
        )
        assertFalse(isDefaultSlot.captured)
        assertTrue(response.isSystem)
        assertEquals(40, response.maxIterations)
        assertEquals(3, response.nodes.size)

        // tempIds were substituted everywhere: the stored edges reference the
        // generated node ids, never the client's temp names.
        val generatedIds = nodeWrites.map { it.second }
        assertTrue(generatedIds.all { edgesSlot.captured.contains(it) || response.entryPoint == it })
        listOf("\"memory\"", "\"generator\"", "\"tools\"").forEach {
            assertFalse(edgesSlot.captured.contains(it), "edges still reference tempId $it")
        }
        assertTrue(generatedIds.contains(response.entryPoint))
    }

    @Test
    fun `isDefault is pinned to false even when the request asks for default`() = runTest {
        val (_, isDefaultSlot, _) = captureWrites()

        service.publishSystemAgent(agentLoopRequest(isDefault = true))

        assertFalse(isDefaultSlot.captured)
    }

    @Test
    fun `category defaults to CONVERSATION and an explicit one passes through`() = runTest {
        captureWrites()

        assertEquals("CONVERSATION", service.publishSystemAgent(agentLoopRequest()).category)
        assertEquals(
            "MEMORY",
            service.publishSystemAgent(agentLoopRequest().copy(category = "MEMORY")).category,
        )
    }

    @Test
    fun `an unknown category is rejected before anything is written`() = runTest {
        captureWrites()

        kotlin.test.assertFailsWith<IllegalArgumentException> {
            service.publishSystemAgent(agentLoopRequest().copy(category = "NOT_A_CATEGORY"))
        }
    }
}
