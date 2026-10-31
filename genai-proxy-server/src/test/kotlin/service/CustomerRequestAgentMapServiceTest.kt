package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.RequestAgentMapRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CustomerRequestAgentMapServiceTest {

    private val mapRepo = mockk<RequestAgentMapRepository>(relaxed = true)
    private val graphRepo = mockk<GraphRepository>()
    private val resolution = mockk<AgentResolutionService>(relaxed = true)
    private val cacheVersions = mockk<CacheVersionService>(relaxed = true)
    private val service = CustomerRequestAgentMapService(mapRepo, graphRepo, resolution, cacheVersions)

    private fun mapEntry(
        scope: String,
        requestType: RequestType,
        graphId: String,
        enabled: Boolean = true,
    ) = RequestAgentMapEntry(
        scope = scope,
        requestType = requestType.name,
        mapKey = "key-${requestType.name}",
        graphId = graphId,
        enabled = enabled,
    )

    private fun graphNamed(name: String) = mapOf(
        DynamoDBConstants.GRAPH_NAME_KEY to AttributeValue.builder().s(name).build()
    )

    @Test
    fun `listEntries returns every request type joined with system and customer entries`() = runTest {
        coEvery { mapRepo.listMapEntries(SYSTEM_SCOPE) } returns listOf(
            mapEntry(SYSTEM_SCOPE, RequestType.INSTRUCTION_PERSONA, "GRP-SYS"),
            mapEntry(SYSTEM_SCOPE, RequestType.NOTE_TITLE, "GRP-OFF", enabled = false),
        )
        coEvery { mapRepo.listMapEntries("CU-1") } returns listOf(
            mapEntry("CU-1", RequestType.MEMORY_EXTRACTION, "GRP-MINE"),
        )
        coEvery { graphRepo.getCustomerGraph("GRP-SYS") } returns graphNamed("Persona Agent")

        val response = service.listEntries("CU-1")

        assertEquals(RequestType.entries.map { it.name }, response.entries.map { it.requestType })
        val byType = response.entries.associateBy { it.requestType }

        // System mapping surfaces its agent's display name
        assertEquals("Persona Agent", byType[RequestType.INSTRUCTION_PERSONA.name]?.platformAgentName)
        // Disabled system entries are ignored — no name lookup for them
        assertNull(byType[RequestType.NOTE_TITLE.name]?.platformAgentName)
        coVerify(exactly = 0) { graphRepo.getCustomerGraph("GRP-OFF") }
        // The customer's own override rides along untouched
        assertEquals("GRP-MINE", byType[RequestType.MEMORY_EXTRACTION.name]?.entry?.graphId)
        assertNull(byType[RequestType.MEMORY_EXTRACTION.name]?.platformAgentName)
    }

    @Test
    fun `listEntries resolves a shared platform graph name only once`() = runTest {
        coEvery { mapRepo.listMapEntries(SYSTEM_SCOPE) } returns listOf(
            mapEntry(SYSTEM_SCOPE, RequestType.CONVERSATION_TITLE, "GRP-SHARED"),
            mapEntry(SYSTEM_SCOPE, RequestType.NOTE_TITLE, "GRP-SHARED"),
        )
        coEvery { mapRepo.listMapEntries("CU-1") } returns emptyList()
        coEvery { graphRepo.getCustomerGraph("GRP-SHARED") } returns graphNamed("Title Agent")

        val response = service.listEntries("CU-1")

        val byType = response.entries.associateBy { it.requestType }
        assertEquals("Title Agent", byType[RequestType.CONVERSATION_TITLE.name]?.platformAgentName)
        assertEquals("Title Agent", byType[RequestType.NOTE_TITLE.name]?.platformAgentName)
        coVerify(exactly = 1) { graphRepo.getCustomerGraph("GRP-SHARED") }
    }
}
