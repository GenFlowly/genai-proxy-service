package com.genflowly.models.api

import kotlinx.serialization.Serializable

@Serializable
data class DeleteIndexedChatsResponse(val status: String, val deleted: Int)
