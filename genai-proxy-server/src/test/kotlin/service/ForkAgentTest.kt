package com.genflowly.service

import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.GENERATION_NODE_TYPE
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.api.UpdateAgentRequest
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
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * The explicit fork flow that replaced silent fork-on-edit:
 *
 *  * POST /agents/{id}/fork clones a System agent into a customer-owned copy
 *    named `<agent-name>-<latestVersion>-forked`, inheriting the source's
 *    category (stored, or derived from the request-agent map for pre-category
 *    rows)
 *  * forking a request-type agent mirrors the SYSTEM map rows as customer
 *    overrides pointing at the fork; forking the default graph does not
 *  * only System agents are forkable (anything else reads as not-found)
 *  * a non-admin PUT on a System agent is rejected with
 *    [SystemAgentEditForbiddenException] (→ 403); admins still edit in place
 */
class ForkAgentTest {

    private val graphRepo = mockk<GraphRepository>(relaxed = true)
    private val instructionRepo = mockk<InstructionRepository>(relaxed = true)
    private val mapRepo = mockk<RequestAgentMapRepository>(relaxed = true)
    private val cacheVersions = mockk<CacheVersionService>(relaxed = true)
    private val service = GraphService(graphRepo, instructionRepo, mapRepo, cacheVersions)

    private fun av(s: String): AttributeValue = AttributeValue.builder().s(s).build()

    private fun systemGraph(
        graphId: String,
        name: String,
        latestVersion: Int = 3,
        isDefault: Boolean = false,
        category: String? = null,
    ): Map<String, AttributeValue> = mapOf(
        "customerId" to av(SYSTEM_GRAPH_OWNER),
        "graphId" to av(graphId),
        "name" to av(name),
        "isDefault" to AttributeValue.builder().bool(isDefault).build(),
        "nodeIds" to AttributeValue.builder().l(av("NOD-SYS")).build(),
        "edges" to av("""{"edges":[{"from":"NOD-SYS","to":"__end__"}]}"""),
        "entryPoint" to av("NOD-SYS"),
        "maxIterations" to AttributeValue.builder().n("1").build(),
        "latestVersion" to AttributeValue.builder().n(latestVersion.toString()).build(),
    ) + (category?.let { mapOf("category" to av(it)) } ?: emptyMap())

    private val systemNode = mapOf(
        "nodeId" to av("NOD-SYS"),
        "nodeType" to av(GENERATION_NODE_TYPE),
        "name" to av("gen"),
        "config" to av("{}"),
    )

    /** Captures the fork's createCustomerGraph write and serves it back on read. */
    private fun captureForkWrite(source: Map<String, AttributeValue>): CaptureHolder {
        val holder = CaptureHolder()
        coEvery { graphRepo.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER) } returns listOf(systemNode)
        coEvery {
            graphRepo.createCustomerGraph(
                customerId = any(), graphId = any(), name = any(), isDefault = any(),
                nodeIds = any(), edges = any(), entryPoint = any(),
                maxIterations = any(), layout = anyNullable(), category = anyNullable(),
            )
        } answers {
            holder.written = mapOf(
                "customerId" to av(arg(0)),
                "graphId" to av(arg(1)),
                "name" to av(arg(2)),
                "isDefault" to AttributeValue.builder().bool(arg(3)).build(),
                "nodeIds" to AttributeValue.builder()
                    .l(arg<List<String>>(4).map { av(it) }).build(),
                "edges" to av(arg(5)),
                "entryPoint" to av(arg(6)),
                "maxIterations" to AttributeValue.builder().n(arg<Int>(7).toString()).build(),
            ) + (arg<String?>(9)?.let { mapOf("category" to av(it)) } ?: emptyMap())
        }
        val sourceId = source["graphId"]!!.s()
        coEvery { graphRepo.getCustomerGraph(any()) } answers {
            if (firstArg<String>() == sourceId) source else holder.written
        }
        return holder
    }

    private class CaptureHolder {
        var written: Map<String, AttributeValue>? = null
    }

    @Test
    fun `fork is named name-version-forked and inherits the stored category`() = runTest {
        val source = systemGraph("GRP-TC", "TitleCreatorDefaultAgent", latestVersion = 7, category = "TITLE_CREATOR")
        captureForkWrite(source)
        coEvery { mapRepo.listMapEntries(any()) } returns emptyList()

        val fork = service.forkAgent("CU1", "GRP-TC")

        assertEquals("TitleCreatorDefaultAgent-7-forked", fork.name)
        assertEquals("TITLE_CREATOR", fork.category)
        assertFalse(fork.isSystem)
        assertFalse(fork.isDefault)
    }

    @Test
    fun `fork of a pre-category mapped agent derives its category from the map`() = runTest {
        val source = systemGraph("GRP-MEM", "MemoryExtractionDefaultAgent", latestVersion = 2)
        captureForkWrite(source)
        coEvery { mapRepo.listMapEntries(SYSTEM_SCOPE) } returns listOf(
            RequestAgentMapEntry(
                scope = SYSTEM_SCOPE, requestType = "MEMORY_EXTRACTION",
                mapKey = "MemoryExtractionDefault", graphId = "GRP-MEM",
            )
        )
        coEvery { mapRepo.listMapEntries("CU1") } returns emptyList()

        val fork = service.forkAgent("CU1", "GRP-MEM")

        assertEquals("MEMORY", fork.category)
        assertEquals("MemoryExtractionDefaultAgent-2-forked", fork.name)
        // The SYSTEM mapping is mirrored as this customer's override onto the fork.
        coVerify(exactly = 1) {
            mapRepo.putMapEntry(match {
                it.scope == "CU1" && it.requestType == "MEMORY_EXTRACTION" &&
                    it.graphId == fork.graphId && it.updatedBy == "CU1"
            })
        }
    }

    @Test
    fun `fork of the System default graph stays default and mirrors no map rows`() = runTest {
        val source = systemGraph("GRP-DEF", "Agent", isDefault = true, category = "CONVERSATION")
        captureForkWrite(source)
        coEvery { mapRepo.listMapEntries(any()) } returns emptyList()

        val fork = service.forkAgent("CU1", "GRP-DEF")

        // The fork replaces the System graph as this customer's default.
        assertEquals(true, fork.isDefault)
        coVerify(exactly = 0) { mapRepo.putMapEntry(any()) }
    }

    @Test
    fun `only System agents are forkable — own and unknown graphs read as not-found`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP-OWN") } returns mapOf(
            "customerId" to av("CU1"), "graphId" to av("GRP-OWN"),
        )
        coEvery { graphRepo.getCustomerGraph("GRP-GONE") } returns null

        assertFailsWith<IllegalStateException> { service.forkAgent("CU1", "GRP-OWN") }
        assertFailsWith<IllegalStateException> { service.forkAgent("CU1", "GRP-GONE") }
    }

    @Test
    fun `non-admin PUT on a System agent is forbidden — no silent fork anymore`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP-SYS") } returns systemGraph("GRP-SYS", "Agent")

        assertFailsWith<SystemAgentEditForbiddenException> {
            service.updateAgent("CU1", "GRP-SYS", UpdateAgentRequest(name = "Hijack"))
        }
        // Nothing was written: no fork, no map mirroring.
        coVerify(exactly = 0) {
            graphRepo.createCustomerGraph(
                customerId = any(), graphId = any(), name = any(), isDefault = any(),
                nodeIds = any(), edges = any(), entryPoint = any(),
                maxIterations = any(), layout = anyNullable(), category = anyNullable(),
            )
        }
        coVerify(exactly = 0) { mapRepo.putMapEntry(any()) }
    }

    @Test
    fun `admin edits a System agent in place, including its category`() = runTest {
        val source = systemGraph("GRP-SYS", "Agent", category = "CONVERSATION")
        coEvery { graphRepo.getCustomerGraph("GRP-SYS") } returns source
        coEvery { graphRepo.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER) } returns listOf(systemNode)
        var categoryPassed: String? = null
        coEvery {
            graphRepo.updateCustomerGraph(
                graphId = any(), name = any(), isDefault = any(), nodeIds = any(),
                edges = any(), entryPoint = any(), maxIterations = any(),
                layout = anyNullable(), category = anyNullable(),
            )
        } answers {
            categoryPassed = arg<String?>(8)
            source + mapOf("name" to av("Renamed"), "category" to av("MEMORY"))
        }

        val updated = service.updateAgent(
            "CU-ADMIN", "GRP-SYS",
            UpdateAgentRequest(name = "Renamed", category = "MEMORY"),
            isAdmin = true,
        )

        assertEquals("Renamed", updated.name)
        assertEquals("MEMORY", updated.category)
        assertEquals("MEMORY", categoryPassed)
    }

    @Test
    fun `customer update keeps the stored category when the request omits it`() = runTest {
        val own = systemGraph("GRP-OWN", "Mine", category = "MEMORY")
            .plus("customerId" to av("CU1"))
        coEvery { graphRepo.getCustomerGraph("GRP-OWN") } returns own
        coEvery { graphRepo.listCustomerGraphNodes("CU1") } returns listOf(systemNode)
        coEvery { graphRepo.listCustomerGraphs("CU1") } returns listOf(own)
        var categoryPassed: String? = "sentinel"
        coEvery {
            graphRepo.updateCustomerGraph(
                graphId = any(), name = any(), isDefault = any(), nodeIds = any(),
                edges = any(), entryPoint = any(), maxIterations = any(),
                layout = anyNullable(), category = anyNullable(),
            )
        } answers {
            categoryPassed = arg<String?>(8)
            own
        }

        service.updateAgent("CU1", "GRP-OWN", UpdateAgentRequest(name = "Still mine"))

        // null → the repository keeps the stored value (same contract as layout)
        assertNull(categoryPassed)
    }

    @Test
    fun `an invalid category on update is rejected before any write`() = runTest {
        val own = systemGraph("GRP-OWN", "Mine").plus("customerId" to av("CU1"))
        coEvery { graphRepo.getCustomerGraph("GRP-OWN") } returns own
        coEvery { graphRepo.listCustomerGraphNodes("CU1") } returns listOf(systemNode)
        coEvery { graphRepo.listCustomerGraphs("CU1") } returns listOf(own)

        assertFailsWith<IllegalArgumentException> {
            service.updateAgent("CU1", "GRP-OWN", UpdateAgentRequest(category = "BOGUS"))
        }
        coVerify(exactly = 0) {
            graphRepo.updateCustomerGraph(
                graphId = any(), name = any(), isDefault = any(), nodeIds = any(),
                edges = any(), entryPoint = any(), maxIterations = any(),
                layout = anyNullable(), category = anyNullable(),
            )
        }
    }
}
