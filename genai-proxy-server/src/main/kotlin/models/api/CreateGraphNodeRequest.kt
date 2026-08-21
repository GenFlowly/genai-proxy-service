package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class CreateGraphNodeRequest(
    val nodeType: String,
    val name: String,
    val config: String = "{}", // TODO Make this an object given we already
    // have a
    // structure
)
