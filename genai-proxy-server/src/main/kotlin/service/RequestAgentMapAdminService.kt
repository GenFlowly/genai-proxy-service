package com.genflowly.service

import com.genflowly.DynamoDBConstants
import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.models.api.GetRequestAgentMapResponse
import com.genflowly.models.api.PutRequestAgentMapRequest
import com.genflowly.models.api.RequestAgentMapStatus
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.RequestAgentMapRepository
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Admin-panel operations on the global (scope = "SYSTEM") request-agent map.
 * The instructions and agents behind the map are ordinary customer-owned
 * resources created through the regular customer-facing APIs — only the
 * global mapping itself is admin territory.
 */
class RequestAgentMapAdminService(
    private val requestAgentMapRepository: RequestAgentMapRepository,
    private val graphRepository: GraphRepository,
    private val agentResolutionService: AgentResolutionService
) {

    /**
     * The full effective picture per request type: what currently resolves
     * (and from where), plus the raw DDB row when one exists.
     */
    suspend fun listMapEntries(): GetRequestAgentMapResponse {
        val ddbEntries = requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE)
            .associateBy { it.requestType }
        val entries = RequestType.entries.map { requestType ->
            val effective = agentResolutionService.resolve(requestType)
            RequestAgentMapStatus(
                requestType = requestType.name,
                displayName = requestType.displayName,
                templateVariables = requestType.templateVariables,
                effectiveMapKey = effective.mapKey,
                effectiveSource = effective.source.name,
                ddbEntry = ddbEntries[requestType.name]
            )
        }
        return GetRequestAgentMapResponse(entries = entries)
    }

    /**
     * Upserts a global map entry after verifying the calling admin owns the
     * referenced graph and that it is a usable GENERATION agent (entry node
     * type, parseable config, existing instruction).
     * @throws IllegalArgumentException naming the broken link when it is not.
     */
    suspend fun putMapEntry(
        requestType: RequestType,
        request: PutRequestAgentMapRequest,
        adminCustomerId: String
    ) {
        require(request.mapKey.isNotBlank()) { "mapKey must not be blank" }

        // Ownership gate: a global mapping may only point at a graph the
        // mapping admin owns or one that is already System infrastructure —
        // never at some other customer's graph.
        val graphItem = graphRepository.getCustomerGraph(request.graphId)
        requireNotNull(graphItem) { "graph ${request.graphId} not found" }
        val owner = graphItem[CUSTOMER_ID_KEY]?.s()
        require(owner == adminCustomerId || owner == SYSTEM_GRAPH_OWNER) {
            "graph ${request.graphId} is not owned by your account"
        }

        // Validates the rest of the chain: GENERATION entry node → parseable
        // config → existing instruction.
        agentResolutionService.buildAgentFromGraph(
            graphId = request.graphId,
            requestType = requestType,
            mapKey = request.mapKey
        )

        // Globally mapped agents follow the instruction ownership model: they
        // become System-owned, which makes them visible to every customer
        // (read-only, fork-on-edit) instead of hiding inside the admin account.
        if (owner == adminCustomerId) {
            val nodeIds = graphItem[DynamoDBConstants.GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()
            nodeIds.forEach { graphRepository.transferNodeOwnership(it, SYSTEM_GRAPH_OWNER) }
            graphRepository.transferGraphOwnership(request.graphId, SYSTEM_GRAPH_OWNER)
        }

        requestAgentMapRepository.putMapEntry(
            RequestAgentMapEntry(
                scope = SYSTEM_SCOPE,
                requestType = requestType.name,
                mapKey = request.mapKey,
                graphId = request.graphId,
                enabled = request.enabled,
                updatedBy = adminCustomerId
            )
        )
        agentResolutionService.invalidate(requestType)
        logger.info { "Admin $adminCustomerId mapped $requestType → ${request.graphId} ('${request.mapKey}')" }
    }

    /** Removes a global map entry; resolution reverts to the bundled default. */
    suspend fun deleteMapEntry(requestType: RequestType) {
        requestAgentMapRepository.deleteMapEntry(SYSTEM_SCOPE, requestType.name)
        agentResolutionService.invalidate(requestType)
    }
}
