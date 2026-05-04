package models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateCustomerGraphRequest(
    val name: String,
    val isDefault: Boolean = false,
    val nodeIds: List<String>,
    val edges: String,
    val entryPoint: String,
    val maxIterations: Int? = null,
)
