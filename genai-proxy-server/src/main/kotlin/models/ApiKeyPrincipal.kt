package com.genflowly.models

/**
 * Principal attached to calls authenticated with a developer API key.
 * [keyId] names the key that made the call, so the turns it pays for can be
 * attributed to it on the Developer page.
 */
data class ApiKeyPrincipal(val customerId: String, val keyId: String? = null)
