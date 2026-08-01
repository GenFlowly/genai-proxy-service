package models.api

import kotlinx.serialization.Serializable

@Serializable
data class UpdateCustomerGraphRequest(
    val name: String? = null,
    val isDefault: Boolean? = null,
    val nodeIds: List<String>? = null,
    val edges: String? = null,
    val entryPoint: String? = null,
    val maxIterations: Int? = null,
)
