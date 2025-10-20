package models

import kotlinx.serialization.Serializable

@Serializable
data class OnboardCustomerRequest(
    val email: String?,
    val name: String?,
    val sub: String,
    val client: String,
)