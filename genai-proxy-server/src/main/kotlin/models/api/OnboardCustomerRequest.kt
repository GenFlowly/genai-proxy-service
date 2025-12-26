package models

import kotlinx.serialization.Serializable

@Serializable
data class OnboardCustomerRequest(
    val sub: String,
    val client: String,
    val email: String? = null,
    val name: String? = null,
    val picture: String? = null
)