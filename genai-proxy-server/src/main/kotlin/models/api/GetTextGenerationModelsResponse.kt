package com.genflowly.models

import com.genflowly.aicallerlib.models.AIVendor
import kotlinx.serialization.Serializable

@Serializable
data class GetTextGenerationModelsResponse(
    val aiVendorModelList: List<AIVendorModelList>
)

@Serializable
data class AIVendorModelList(
    val aiVendor: AIVendor,
    val modelsList: List<String>
)
