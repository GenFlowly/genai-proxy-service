package com.genflowly.models

import kotlinx.serialization.Serializable
import models.GenerateTextResponse

@Serializable
data class BatchGenerateTextResponse(
    val results: List<GenerateTextResponse>
)