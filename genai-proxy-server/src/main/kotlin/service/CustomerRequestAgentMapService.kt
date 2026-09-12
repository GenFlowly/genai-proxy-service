package com.genflowly.service

import com.genflowly.DynamoDBConstants.CUSTOMER_ID_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NAME_KEY
import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.models.RequestAgentMapEntry
import com.genflowly.models.RequestType
import com.genflowly.models.api.CustomerRequestAgentStatus
import com.genflowly.models.api.GetCustomerRequestAgentsResponse
import com.genflowly.models.api.PutCustomerRequestAgentRequest
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.RequestAgentMapRepository
import mu.KotlinLogging

private val logger = KotlinLogging.logger {}

/**
 * Per-customer overrides of the default-action agents. Same table and
 * resolution chain as the admin (SYSTEM-scope) map, but scoped to the
 * calling customer: their entry wins over the SYSTEM mapping and the bundled
 * defaults for THEIR requests only (AgentResolutionService checks the
 * customer scope first). Unlike the admin path, mapping never transfers
 * graph ownership — the customer keeps their agent.
 */
class CustomerRequestAgentMapService(
    private val requestAgentMapRepository: RequestAgentMapRepository,
    private val graphRepository: GraphRepository,
    private val agentResolutionService: AgentResolutionService
) {

    /** Every default action plus this customer's override, when set. */
    suspend fun listEntries(customerId: String): GetCustomerRequestAgentsResponse {
        val entries = RequestType.entries.map { requestType ->
            val systemEntry = requestAgentMapRepository
                .getMapEntry(SYSTEM_SCOPE, requestType.name)
                ?.takeIf { it.enabled }
            CustomerRequestAgentStatus(
                requestType = requestType.name,
                displayName = requestType.displayName,
                templateVariables = requestType.templateVariables,
                entry = requestAgentMapRepository.getMapEntry(customerId, requestType.name),
                platformAgentName = systemEntry?.let {
                    graphRepository.getCustomerGraph(it.graphId)?.get(GRAPH_NAME_KEY)?.s()
                }
            )
        }
        return GetCustomerRequestAgentsResponse(entries = entries)
    }

    /**
     * Upserts this customer's override for one action. The graph must be the
     * customer's own agent (or a System-published one) and pass the same
     * chain validation the admin mapping uses.
     * @throws IllegalArgumentException on an unusable or foreign graph → 400.
     */
    suspend fun putEntry(
        customerId: String,
        requestType: RequestType,
        request: PutCustomerRequestAgentRequest
    ) {
        val graphItem = graphRepository.getCustomerGraph(request.graphId)
        requireNotNull(graphItem) { "graph ${request.graphId} not found" }
        val owner = graphItem[CUSTOMER_ID_KEY]?.s()
        require(owner == customerId || owner == SYSTEM_GRAPH_OWNER) {
            "graph ${request.graphId} is not owned by your account"
        }

        // Validates the rest of the chain: GENERATION entry node → parseable
        // config → existing instruction.
        agentResolutionService.buildAgentFromGraph(
            graphId = request.graphId,
            requestType = requestType,
            mapKey = mapKeyFor(graphItem[GRAPH_NAME_KEY]?.s(), requestType)
        )

        requestAgentMapRepository.putMapEntry(
            RequestAgentMapEntry(
                scope = customerId,
                requestType = requestType.name,
                mapKey = mapKeyFor(graphItem[GRAPH_NAME_KEY]?.s(), requestType),
                graphId = request.graphId,
                enabled = request.enabled,
                updatedBy = customerId
            )
        )
        agentResolutionService.invalidate(requestType)
        logger.info { "Customer $customerId mapped $requestType → ${request.graphId}" }
    }

    /** Removes the override; resolution reverts to the SYSTEM mapping / bundled default. */
    suspend fun deleteEntry(customerId: String, requestType: RequestType) {
        requestAgentMapRepository.deleteMapEntry(customerId, requestType.name)
        agentResolutionService.invalidate(requestType)
        logger.info { "Customer $customerId removed their $requestType mapping" }
    }

    /** Customers don't manage map keys — derive one from the agent name. */
    private fun mapKeyFor(graphName: String?, requestType: RequestType): String =
        graphName?.takeIf { it.isNotBlank() } ?: "Custom${requestType.name}"
}
