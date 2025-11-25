package com.genflowly.models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GetTextGenerationModelsRequest(
    val aiVendor: List<AIVendor>,
    val client: String
)