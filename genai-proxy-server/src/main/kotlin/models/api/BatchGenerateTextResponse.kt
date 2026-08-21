package com.genflowly.models

import kotlinx.serialization.Serializable

@Serializable
data class BatchGenerateTextResponse(
    val results: List<GenerateTextResponse>
)