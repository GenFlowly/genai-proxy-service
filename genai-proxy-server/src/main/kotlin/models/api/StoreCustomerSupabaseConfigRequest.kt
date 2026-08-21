package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerSupabaseConfigRequest(
    val endpoint: String,
    val token: String,
    val password: String
)

@Serializable
enum class SupabaseConfigStatusValue(val value: String) {
    PRESENT("PRESENT"),
    NOT_SET("NOT_SET")
}

@Serializable
data class SupabaseConfigStatus(
    val isConfigValid: Boolean,
    val status: SupabaseConfigStatusValue,
    val updateSuccessful: Boolean
)

@Serializable
data class StoreCustomerSupabaseConfigResponse(
    val configStatus: SupabaseConfigStatus
)
