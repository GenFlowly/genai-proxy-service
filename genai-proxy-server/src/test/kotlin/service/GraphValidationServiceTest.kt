package com.genflowly.service

import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class GraphValidationServiceTest {

    private fun validate(
        edges: String,
        nodeTypes: Map<String, String>,
        entryPoint: String = nodeTypes.keys.first(),
    ) = GraphValidationService.validateAgentUpdate(
        nodeIds = nodeTypes.keys.toList(),
        nodeTypeById = nodeTypes,
        entryPoint = entryPoint,
        edgesJson = edges,
        maxIterations = 10,
        name = null,
        isDefault = null,
        isOnlyGraph = false,
        nodePatchConfigs = emptyMap(),
    )

    @Test
    fun `multi-way value conditional with default route passes`() {
        validate(
            edges = """{"edges":[{"from":"B","to":"__end__"},{"from":"C","to":"__end__"},{"from":"D","to":"__end__"}],
                "conditional_edges":[{"from":"A","condition_key":"sentiment","condition_type":"value",
                "routes":{"positive":"B","negative":"C","__default__":"D"}}]}""",
            nodeTypes = mapOf("A" to "GENERATION", "B" to "GENERATION", "C" to "GENERATION", "D" to "GENERATION"),
        )
    }

    @Test
    fun `blank condition_key is rejected, arbitrary keys are accepted`() {
        val nodeTypes = mapOf("A" to "GENERATION", "B" to "GENERATION", "C" to "GENERATION")
        val edgesFor = { key: String ->
            """{"edges":[{"from":"B","to":"__end__"},{"from":"C","to":"__end__"}],
               "conditional_edges":[{"from":"A","condition_key":"$key","routes":{"true":"B","false":"C"}}]}"""
        }
        // A custom scratch key — no whitelist anymore.
        validate(edgesFor("my_custom_output"), nodeTypes)

        val e = assertFailsWith<IllegalArgumentException> { validate(edgesFor(" "), nodeTypes) }
        assertTrue(e.message!!.contains("blank condition_key"))
    }

    @Test
    fun `bool conditional must have exactly true and false routes`() {
        val e = assertFailsWith<IllegalArgumentException> {
            validate(
                edges = """{"edges":[{"from":"B","to":"__end__"}],
                    "conditional_edges":[{"from":"A","condition_key":"needs_rewrite","routes":{"true":"B"}}]}""",
                nodeTypes = mapOf("A" to "GENERATION", "B" to "GENERATION"),
            )
        }
        assertTrue(e.message!!.contains("'true' and 'false'"))
    }

    @Test
    fun `acyclic branching without a reflection node passes`() {
        // The old rule rejected ANY conditional edge without a reflection node;
        // only actual cycles need the cycle-exit signal.
        validate(
            edges = """{"edges":[{"from":"B","to":"__end__"},{"from":"C","to":"__end__"}],
                "conditional_edges":[{"from":"A","condition_key":"needs_rewrite","routes":{"true":"B","false":"C"}}]}""",
            nodeTypes = mapOf("A" to "QUERY_ANALYZER", "B" to "GENERATION", "C" to "GENERATION"),
        )
    }

    @Test
    fun `conditional cycle requires a reflection node`() {
        val nodeTypesNoReflection = mapOf("A" to "GENERATION", "B" to "GENERATION")
        val cyclicEdges = """{"edges":[{"from":"A","to":"B"}],
            "conditional_edges":[{"from":"B","condition_key":"needs_more_context","routes":{"true":"A","false":"__end__"}}]}"""

        val e = assertFailsWith<IllegalArgumentException> { validate(cyclicEdges, nodeTypesNoReflection) }
        assertTrue(e.message!!.contains("cycle"))

        validate(cyclicEdges, mapOf("A" to "GENERATION", "B" to "RESPONSE_GENERATOR_WITH_REFLECTION"))
    }

    @Test
    fun `tool_route cycle passes without a reflection node`() {
        // Agent loop: RESPONSE_GENERATOR → tool_route → TOOL_EXECUTOR → back.
        // Exits by construction (no tool calls → "none" route), so no
        // reflection node is required.
        validate(
            edges = """{"edges":[{"from":"T","to":"A"}],
                "conditional_edges":[{"from":"A","condition_key":"tool_calls","condition_type":"tool_route",
                "routes":{"builtin":"T","caller":"__end__","none":"__end__"}}]}""",
            nodeTypes = mapOf("A" to "RESPONSE_GENERATOR", "T" to "TOOL_EXECUTOR"),
        )
    }

    @Test
    fun `non-tool cycle still requires reflection even when a tool_route edge exists`() {
        // A ⇄ B is a plain bool cycle; the separate tool_route loop must not
        // exempt it.
        val e = assertFailsWith<IllegalArgumentException> {
            validate(
                edges = """{"edges":[{"from":"A","to":"B"},{"from":"T","to":"A"}],
                    "conditional_edges":[
                        {"from":"B","condition_key":"needs_more_context","routes":{"true":"A","false":"__end__"}},
                        {"from":"A","condition_key":"tool_calls","condition_type":"tool_route",
                         "routes":{"builtin":"T","caller":"__end__","none":"__end__"}}]}""",
                nodeTypes = mapOf("A" to "RESPONSE_GENERATOR", "B" to "GENERATION", "T" to "TOOL_EXECUTOR"),
            )
        }
        assertTrue(e.message!!.contains("cycle"))
    }

    @Test
    fun `nodes reachable only through a tool_route edge are still reachable`() {
        // TOOL_EXECUTOR is only reachable via the tool_route conditional —
        // the reachability check must traverse it even though cycle detection
        // ignores it.
        validate(
            edges = """{"edges":[{"from":"T","to":"A"}],
                "conditional_edges":[{"from":"A","condition_key":"tool_calls","condition_type":"tool_route",
                "routes":{"builtin":"T","caller":"__end__","none":"__end__"}}]}""",
            nodeTypes = mapOf("A" to "RESPONSE_GENERATOR", "T" to "TOOL_EXECUTOR"),
            entryPoint = "A",
        )
    }

    @Test
    fun `plain-edge cycle is also caught`() {
        val e = assertFailsWith<IllegalArgumentException> {
            validate(
                edges = """{"edges":[{"from":"A","to":"B"},{"from":"B","to":"A"}],"conditional_edges":[]}""",
                nodeTypes = mapOf("A" to "GENERATION", "B" to "GENERATION"),
            )
        }
        assertTrue(e.message!!.contains("cycle"))
    }
}
