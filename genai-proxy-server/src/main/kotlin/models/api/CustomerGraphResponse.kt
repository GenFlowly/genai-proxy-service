package models.api

import kotlinx.serialization.Serializable

@Serializable
data class CustomerGraphResponse(
    val graphId: String,
    val name: String,
    val isDefault: Boolean,
    val nodeIds: List<String>,
    val edges: String,
    val entryPoint: String,
    val maxIterations: Int,
    val version: Int,
    val latestVersion: Int,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class CustomerGraphVersionResponse(
    val graphId: String,
    val version: Int,
    val name: String,
    val isDefault: Boolean,
    val nodeIds: List<String>,
    val edges: String,
    val entryPoint: String,
    val maxIterations: Int,
    val createdAt: String,
)

@Serializable
data class CustomerGraphListResponse(
    val graphs: List<CustomerGraphResponse>,
)

@Serializable
data class CustomerGraphVersionListResponse(
    val graphId: String,
    val versions: List<CustomerGraphVersionResponse>,
)
