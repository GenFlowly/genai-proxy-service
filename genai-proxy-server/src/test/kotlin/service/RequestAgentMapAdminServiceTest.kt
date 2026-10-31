package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestType
import com.genflowly.models.api.PutRequestAgentMapRequest
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class RequestAgentMapAdminServiceTest {

    private val mapRepo = mockk<RequestAgentMapRepository>(relaxed = true)
    private val graphRepo = mockk<GraphRepository>()
    private val resolution = mockk<AgentResolutionService>(relaxed = true)
    private val cacheVersions = mockk<CacheVersionService>(relaxed = true)
    private val service = RequestAgentMapAdminService(mapRepo, graphRepo, resolution, cacheVersions)

    private fun graphOwnedBy(customerId: String) = mapOf(
        DynamoDBConstants.CUSTOMER_ID_KEY to AttributeValue.builder().s(customerId).build()
    )

    private val request = PutRequestAgentMapRequest(mapKey = "PersonaCustom", graphId = "GRP1")

    @Test
    fun `putMapEntry rejects a graph the calling admin does not own`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphOwnedBy("CU-other")

        val e = assertFailsWith<IllegalArgumentException> {
            service.putMapEntry(RequestType.INSTRUCTION_PERSONA, request, "CU-admin")
        }
        assertTrue(e.message!!.contains("not owned"))
        coVerify(exactly = 0) { mapRepo.putMapEntry(any()) }
    }

    @Test
    fun `putMapEntry stores a SYSTEM-scope entry, transfers ownership to System and invalidates`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns (graphOwnedBy("CU-admin") + mapOf(
            DynamoDBConstants.GRAPH_NODE_IDS_KEY to AttributeValue.builder()
                .l(AttributeValue.builder().s("NOD1").build()).build()
        ))
        coEvery { graphRepo.transferNodeOwnership(any(), any()) } returns Unit
        coEvery { graphRepo.transferGraphOwnership(any(), any()) } returns Unit
        coEvery { graphRepo.setGraphCategory(any(), any()) } returns Unit

        service.putMapEntry(RequestType.INSTRUCTION_PERSONA, request, "CU-admin")

        coVerify { resolution.buildAgentFromGraph("GRP1", RequestType.INSTRUCTION_PERSONA, "PersonaCustom") }
        // A globally mapped agent becomes System infrastructure (visible to
        // every customer read-only, forked explicitly to edit) — nodes first,
        // then graph.
        coVerify { graphRepo.transferNodeOwnership("NOD1", DynamoDBConstants.SYSTEM_GRAPH_OWNER) }
        coVerify { graphRepo.transferGraphOwnership("GRP1", DynamoDBConstants.SYSTEM_GRAPH_OWNER) }
        // The mapping is authoritative about the agent's purpose — its
        // category follows the request type.
        coVerify { graphRepo.setGraphCategory("GRP1", "INSTRUCTIONS") }
        coVerify {
            mapRepo.putMapEntry(match {
                it.scope == SYSTEM_SCOPE &&
                        it.requestType == "INSTRUCTION_PERSONA" &&
                        it.graphId == "GRP1" &&
                        it.updatedBy == "CU-admin"
            })
        }
        coVerify { resolution.invalidate(RequestType.INSTRUCTION_PERSONA) }
    }

    @Test
    fun `putMapEntry accepts an already System-owned graph without re-transferring`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns
            graphOwnedBy(DynamoDBConstants.SYSTEM_GRAPH_OWNER)
        coEvery { graphRepo.setGraphCategory(any(), any()) } returns Unit

        service.putMapEntry(RequestType.INSTRUCTION_PERSONA, request, "CU-admin")

        coVerify(exactly = 0) { graphRepo.transferGraphOwnership(any(), any()) }
        coVerify { mapRepo.putMapEntry(match { it.scope == SYSTEM_SCOPE && it.graphId == "GRP1" }) }
    }

    @Test
    fun `disableMapEntry writes the row back disabled instead of deleting it`() = runTest {
        // A deleted row would be resurrected by the startup seeder; disabling
        // preserves the admin's intent across restarts.
        val existing = com.genflowly.models.RequestAgentMapEntry(
            scope = SYSTEM_SCOPE,
            requestType = RequestType.NOTE_TITLE.name,
            mapKey = "NoteTitleDefault",
            graphId = "GRP7",
            enabled = true,
        )
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, "NOTE_TITLE") } returns existing

        service.disableMapEntry(RequestType.NOTE_TITLE, "CU-admin")

        coVerify {
            mapRepo.putMapEntry(match {
                it.scope == SYSTEM_SCOPE && it.requestType == "NOTE_TITLE" &&
                        !it.enabled && it.graphId == "GRP7" && it.updatedBy == "CU-admin"
            })
        }
        coVerify(exactly = 0) { mapRepo.deleteMapEntry(any(), any()) }
        coVerify { resolution.invalidate(RequestType.NOTE_TITLE) }
    }

    @Test
    fun `disableMapEntry on a never-mapped action is an error, not a no-op`() = runTest {
        coEvery { mapRepo.getMapEntry(SYSTEM_SCOPE, "NOTE_TITLE") } returns null

        kotlin.test.assertFailsWith<IllegalArgumentException> {
            service.disableMapEntry(RequestType.NOTE_TITLE, "CU-admin")
        }
    }
}
