package com.genflowly.models.api

import com.genflowly.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GetTextGenerationModelsRequest(
    val aiVendor: List<AIVendor>
)