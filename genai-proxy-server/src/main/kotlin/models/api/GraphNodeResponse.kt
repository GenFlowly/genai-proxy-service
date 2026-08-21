package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class GraphNodeResponse(
    val nodeId: String,
    val nodeType: String,
    val name: String,
    val config: String,
    val version: Int,
    val latestVersion: Int,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class GraphNodeVersionResponse(
    val nodeId: String,
    val version: Int,
    val nodeType: String,
    val name: String,
    val config: String,
    val createdAt: String,
)

@Serializable
data class GraphNodeListResponse(
    val nodes: List<GraphNodeResponse>,
)

@Serializable
data class GraphNodeVersionListResponse(
    val nodeId: String,
    val versions: List<GraphNodeVersionResponse>,
)
