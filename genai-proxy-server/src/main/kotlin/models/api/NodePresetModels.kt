package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * An admin-curated "pre-made node" for the graph editor palette: a runtime
 * node type plus a ready-made name/description/config. Global — every
 * customer's palette shows the same set.
 */
@Serializable
data class NodePreset(
    val presetId: String,
    val name: String,
    val nodeType: String,
    val description: String = "",
    /** JSON string used as the config of newly dropped nodes (may reference instructions). */
    val config: String = "{}",
    /** Contract lines shown on the palette item; empty → the primitive's contract shows. */
    val requiredAttributes: List<String> = emptyList(),
    val sortOrder: Int = 0,
    val createdAt: String? = null,
    val updatedAt: String? = null,
)

@Serializable
data class GetNodePresetsResponse(val presets: List<NodePreset>)

/** Create/update body — presetId is server-generated on create. */
@Serializable
data class UpsertNodePresetRequest(
    val name: String,
    val nodeType: String,
    val description: String = "",
    val config: String = "{}",
    val requiredAttributes: List<String> = emptyList(),
    val sortOrder: Int = 0,
)
