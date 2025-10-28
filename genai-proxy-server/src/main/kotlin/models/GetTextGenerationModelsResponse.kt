package com.genflowly.models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GetTextGenerationModelsResponse(
    val vendor: AIVendor,
    val modelsList: List<String>
)
