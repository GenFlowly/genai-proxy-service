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
     * The full effective picture per request type: the published agent that
     * currently resolves, or UNRESOLVED when the action is disabled/unmapped
     * (there is no bundled runtime fallback), plus the raw DDB row when one
     * exists.
     */
    suspend fun listMapEntries(): GetRequestAgentMapResponse {
        val ddbEntries = requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE)
            .associateBy { it.requestType }
        val entries = RequestType.entries.map { requestType ->
            val effective = try {
                agentResolutionService.resolve(requestType)
            } catch (e: RequestAgentUnresolvedException) {
                null
            }
            RequestAgentMapStatus(
                requestType = requestType.name,
                displayName = requestType.displayName,
                templateVariables = requestType.templateVariables,
                effectiveMapKey = effective?.mapKey,
                effectiveSource = if (effective != null) "DDB" else "UNRESOLVED",
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
        // (read-only, forked explicitly to edit) instead of hiding inside the
        // admin account.
        if (owner == adminCustomerId) {
            val nodeIds = graphItem[DynamoDBConstants.GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()
            nodeIds.forEach { graphRepository.transferNodeOwnership(it, SYSTEM_GRAPH_OWNER) }
            graphRepository.transferGraphOwnership(request.graphId, SYSTEM_GRAPH_OWNER)
        }

        // The global mapping is authoritative about what the agent powers —
        // stamp the matching category so the agent lands in the right section
        // of the Agents page and stays out of the conversation picker.
        com.genflowly.models.AgentCategory.categoryForRequestType(requestType.name)?.let { category ->
            graphRepository.setGraphCategory(request.graphId, category.name)
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

    /**
     * DISABLES a global mapping (writes the row back with enabled=false)
     * instead of deleting it: with no bundled runtime fallback, the row is
     * the record of an admin's intent — removing it entirely would let the
     * startup seeder resurrect the mapping on the next deploy. A disabled
     * action resolves to nothing and fails loudly until re-enabled/remapped.
     */
    suspend fun disableMapEntry(requestType: RequestType, adminCustomerId: String) {
        val existing = requestAgentMapRepository.getMapEntry(SYSTEM_SCOPE, requestType.name)
            ?: throw IllegalArgumentException("no mapping exists for ${requestType.name}")
        requestAgentMapRepository.putMapEntry(
            existing.copy(enabled = false, updatedBy = adminCustomerId)
        )
        agentResolutionService.invalidate(requestType)
        logger.info { "Admin $adminCustomerId disabled the ${requestType.name} mapping" }
    }
}
