package models

import kotlinx.serialization.Serializable

@Serializable
data class CustomerProfile(
    val customerId: String,
    val sub: String,
    val client: String,
    val email: String? = null,
    val name: String? = null,
    val picture: String? = null,
    val username: String? = null,
    val isDiscoverable: Boolean = false
)
