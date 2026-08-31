package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class StoreCustomerVectorDBConfigRequest(
    val vendor: String,
    val endpoint: String,
    val token: String
)

@Serializable
enum class VectorDBConfigStatusValue(val value: String) {
    PRESENT("PRESENT"),
    NOT_SET("NOT_SET")
}

@Serializable
data class VectorDBConfigStatus(
    val vendor: String,
    val isConfigValid: Boolean,
    val status: VectorDBConfigStatusValue,
    val updateSuccessful: Boolean
)

@Serializable
data class StoreCustomerVectorDBConfigResponse(
    val configStatus: VectorDBConfigStatus
)
