package com.genflowly.models.api

import kotlinx.serialization.Serializable
import com.genflowly.models.AIVendorAPIKeyStatus
import com.genflowly.models.VectorDBConfigStatus

@Serializable
data class OnboardCustomerResponse(
    val customerId: String,
    val aiConfigPreferences: AIConfigPreferences,
    val aiVendorAPIKeyStatusList: List<AIVendorAPIKeyStatus>,
    val customerName: String?,
    val customerPicture: String?,
    val customerInstructions: List<InstructionResponse>?,
    val vectorDBConfigStatusList: List<VectorDBConfigStatus> = emptyList(),
    val onboardingCompleted: Boolean = true,
    /** True until the customer agrees to the current version of the AI data consent screen. */
    val aiDataConsentRequired: Boolean = false,
    /** When the customer last agreed, ISO-8601 UTC; null if they never have. */
    val aiDataConsentAt: String? = null,
    /**
     * Monotonic per-resource counters bumped on every server-side mutation
     * (customer + SYSTEM scope combined). The client skips refetching a
     * resource whose counter matches the one its cache was written at.
     * Null = versions unavailable this response; the client must refetch.
     */
    val cacheVersions: CacheVersions? = null
)

@Serializable
data class AiDataConsentResponse(
    val aiDataConsentAt: String
)

@Serializable
data class CacheVersions(
    val agents: Long = 0,
    val requestAgents: Long = 0,
    val projects: Long = 0,
)

