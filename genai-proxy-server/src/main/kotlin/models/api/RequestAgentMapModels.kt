package com.genflowly.models.api

import com.genflowly.models.RequestAgentMapEntry
import kotlinx.serialization.Serializable

/** Admin-panel DTOs for the global request-agent map. */

@Serializable
data class PutRequestAgentMapRequest(
    val mapKey: String,
    val graphId: String,
    val enabled: Boolean = true
)

/**
 * Effective mapping status for one request type: what currently resolves
 * (DDB entry or bundled config default) plus the raw DDB row when present.
 */
@Serializable
data class RequestAgentMapStatus(
    val requestType: String,
    /** Human-readable action name from the RequestType registry. */
    val displayName: String,
    /** Template variables the server supplies to this action's prompts. */
    val templateVariables: List<String>,
    val effectiveMapKey: String,
    val effectiveSource: String,
    val ddbEntry: RequestAgentMapEntry? = null
)

@Serializable
data class GetRequestAgentMapResponse(
    val entries: List<RequestAgentMapStatus>
)

/** Customer-facing DTOs for per-customer default-action overrides. */

@Serializable
data class CustomerRequestAgentStatus(
    val requestType: String,
    /** Human-readable action name from the RequestType registry. */
    val displayName: String,
    /** Template variables the server supplies to this action's prompts. */
    val templateVariables: List<String>,
    /** This customer's own override, when one is set. */
    val entry: RequestAgentMapEntry? = null,
    /**
     * Name of the agent serving this action when the customer has no
     * override: the SYSTEM-mapped agent's name, or null when the action runs
     * on the bundled built-in prompts.
     */
    val platformAgentName: String? = null
)

@Serializable
data class GetCustomerRequestAgentsResponse(
    val entries: List<CustomerRequestAgentStatus>
)

@Serializable
data class PutCustomerRequestAgentRequest(
    val graphId: String,
    val enabled: Boolean = true
)
