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
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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
    suspend fun listEntries(customerId: String): GetCustomerRequestAgentsResponse = coroutineScope {
        // One query per scope (instead of a point-read per request type), both in flight together
        val systemEntriesDeferred = async { requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE) }
        val customerEntriesDeferred = async { requestAgentMapRepository.listMapEntries(customerId) }
        val systemEntries = systemEntriesDeferred.await()
            .filter { it.enabled }
            .associateBy { it.requestType }
        val customerEntries = customerEntriesDeferred.await().associateBy { it.requestType }

        // Resolve each distinct platform graph's display name once, concurrently —
        // several request types often share the same system agent
        val platformAgentNames = systemEntries.values
            .map { it.graphId }
            .distinct()
            .map { graphId ->
                async { graphId to graphRepository.getCustomerGraph(graphId)?.get(GRAPH_NAME_KEY)?.s() }
            }
            .awaitAll()
            .toMap()

        GetCustomerRequestAgentsResponse(
            entries = RequestType.entries.map { requestType ->
                CustomerRequestAgentStatus(
                    requestType = requestType.name,
                    displayName = requestType.displayName,
                    templateVariables = requestType.templateVariables,
                    entry = customerEntries[requestType.name],
                    platformAgentName = systemEntries[requestType.name]
                        ?.let { platformAgentNames[it.graphId] }
                )
            }
        )
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

    /** Removes the override; resolution reverts to the SYSTEM mapping. */
    suspend fun deleteEntry(customerId: String, requestType: RequestType) {
        requestAgentMapRepository.deleteMapEntry(customerId, requestType.name)
        agentResolutionService.invalidate(requestType)
        logger.info { "Customer $customerId removed their $requestType mapping" }
    }

    /** Customers don't manage map keys — derive one from the agent name. */
    private fun mapKeyFor(graphName: String?, requestType: RequestType): String =
        graphName?.takeIf { it.isNotBlank() } ?: "Custom${requestType.name}"
}
