package com.genflowly.models.api

import kotlinx.serialization.Serializable

/** DELETE /api/v1/account body; [confirmation] must be "DELETE". */
@Serializable
data class DeleteAccountRequest(val confirmation: String? = null)

@Serializable
data class DeleteAccountResponse(val status: String)

/** DELETE /api/v1/credentials result: how many keys and credentials were removed. */
@Serializable
data class DeleteCredentialsResponse(val deleted: Int)
