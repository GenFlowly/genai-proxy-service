package com.genflowly.models.api

import kotlinx.serialization.Serializable

/**
 * Store credentials and/or plain settings for a tool. At least one of
 * [credentials]/[settings] must be present. Credentials are KMS-encrypted at
 * rest; settings are NON-SECRET per-tool config stored in the clear (e.g.
 * WEB_SEARCH's "max_searches_per_turn") and may be saved without any
 * credentials — a customer on the platform search key can still tune limits.
 * Omitted fields leave their stored counterpart untouched, so saving a key
 * never clobbers settings and vice versa.
 */
@Serializable
data class StoreToolCredentialsRequest(
    val toolType: String,
    val authType: String,
    val credentials: Map<String, String>? = null,
    val settings: Map<String, String>? = null,
)
