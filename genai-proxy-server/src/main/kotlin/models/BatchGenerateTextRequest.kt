package com.genflowly.models

import kotlinx.serialization.Serializable
import models.GenerateTextRequest

@Serializable
data class BatchGenerateTextRequest(
    val requests: List<GenerateTextRequest>
)
