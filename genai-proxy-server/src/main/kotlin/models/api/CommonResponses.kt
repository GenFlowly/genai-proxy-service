package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * Standard error payload returned by all endpoints on 4xx/5xx responses.
 * Used for OpenAPI documentation of `mapOf("error" to ...)` responses.
 */
@Serializable
data class ErrorResponse(val error: String)

/**
 * Standard `{"status": "success"}` payload returned by mutation endpoints.
 */
@Serializable
data class StatusResponse(val status: String)

/**
 * Standard `{"success": true}` payload returned by profile-settings endpoints.
 */
@Serializable
data class SuccessResponse(val success: Boolean)
