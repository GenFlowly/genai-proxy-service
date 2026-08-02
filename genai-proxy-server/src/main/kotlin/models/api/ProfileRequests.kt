package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class UpdateUsernameRequest(
    val username: String
)

@Serializable
data class UpdateDiscoverabilityRequest(
    val isDiscoverable: Boolean
)

@Serializable
data class SearchCustomerResponse(
    val customerId: String,
    val name: String?,
    val username: String,
    val picture: String?
)

@Serializable
data class CustomerProfileResponse(
    val customerId: String,
    val name: String?,
    val email: String?,
    val username: String?,
    val picture: String?,
    val isDiscoverable: Boolean
)
