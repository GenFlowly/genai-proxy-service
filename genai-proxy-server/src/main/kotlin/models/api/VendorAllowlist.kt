package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** One vendor row on the admin "Allowlist AI Vendors" page. */
@Serializable
data class VendorAllowlistEntry(
    /** Provider catalog id (LiteLLM id, e.g. "openai", "xai") */
    val id: String,
    val displayName: String,
    /** First-party langchain integration vs LiteLLM path */
    val native: Boolean,
    val allowed: Boolean
)

@Serializable
data class GetVendorAllowlistResponse(
    val vendors: List<VendorAllowlistEntry>,
    /** False until an admin has saved the list at least once (= all allowed) */
    val configured: Boolean
)

@Serializable
data class PutVendorAllowlistRequest(
    /** Provider catalog ids to allow; empty means all vendors stay visible */
    val allowedVendors: List<String>
)
