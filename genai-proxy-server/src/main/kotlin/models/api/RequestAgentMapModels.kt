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
    val effectiveMapKey: String,
    val effectiveSource: String,
    val ddbEntry: RequestAgentMapEntry? = null
)

@Serializable
data class GetRequestAgentMapResponse(
    val entries: List<RequestAgentMapStatus>
)
