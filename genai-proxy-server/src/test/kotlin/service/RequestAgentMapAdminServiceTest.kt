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
    private val service = RequestAgentMapAdminService(mapRepo, graphRepo, resolution)

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
    fun `putMapEntry stores a SYSTEM-scope entry and invalidates the cache`() = runTest {
        coEvery { graphRepo.getCustomerGraph("GRP1") } returns graphOwnedBy("CU-admin")

        service.putMapEntry(RequestType.INSTRUCTION_PERSONA, request, "CU-admin")

        coVerify { resolution.buildAgentFromGraph("GRP1", RequestType.INSTRUCTION_PERSONA, "PersonaCustom") }
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
    fun `deleteMapEntry removes the SYSTEM row and invalidates`() = runTest {
        service.deleteMapEntry(RequestType.NOTE_TITLE)

        coVerify { mapRepo.deleteMapEntry(SYSTEM_SCOPE, "NOTE_TITLE") }
        coVerify { resolution.invalidate(RequestType.NOTE_TITLE) }
    }
}
